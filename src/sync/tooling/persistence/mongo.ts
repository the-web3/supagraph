// Mongo class wraps mongo with a simple entity management system (abstract-leveldown compatible)
import type { AnyBulkWriteOperation, Document, MongoClient } from "mongodb";

// Extend from db (abstract-leveldown compatible kv implementation)
import { BatchOp, Engine, KV } from "@/sync/types";
import { DB, NotFound } from "@/sync/tooling/persistence/db";

// Simple key-value database store (abstract-leveldown compliant)
export class Mongo extends DB {
  // kv store holds a materialised view of current state in local cache (by ref.id)
  declare kv: KV;

  // engine carries global state
  declare engine: Engine;

  // useStorage will be undefined on this adapter because we're bypassing DB.update()
  declare useStorage?: boolean;

  // underlying mongo client
  client: MongoClient | Promise<MongoClient>;

  // selected db on the mongo client
  db: ReturnType<MongoClient["db"]> | Promise<ReturnType<MongoClient["db"]>>;

  // name given to the db on the mongo client
  name: string;

  // are the entities in this db being upserted or not?
  mutable: boolean;

  // construct a kv store
  constructor(
    client: MongoClient | Promise<MongoClient>,
    name: string,
    kv: KV,
    mutable?: boolean,
    engine?: Engine
  ) {
    // init super
    super(kv, engine);
    // establish connection
    this.client = client;
    // record the connection name
    this.name = name;
    // are the ids unique?
    this.mutable = mutable || false;
    // associate the engine
    this.engine = engine || ({} as Engine);
    // resolve the client then attach the named db
    this.db = Promise.resolve(client).then((mongo) =>
      mongo.db(name || "supagraph")
    );
  }

  // create a new instance statically
  static async create({
    client,
    name,
    kv,
    mutable,
    engine,
  }: {
    client: MongoClient | Promise<MongoClient>;
    name: string;
    kv: KV;
    mutable?: boolean;
    engine?: Engine;
  } & Record<string, unknown>) {
    const db = new this(client, name, kv, mutable, engine);
    await db.update({ kv });
    return db;
  }

  // update the kv store with a new set of values (we're not starting node-persist here)
  async update({ kv }: { kv: KV } & Record<string, unknown>) {
    // use given kv
    const kvs = { ...kv };
    // restore the kv store
    this.kv = kvs;
  }

  // get from mongodb
  async get(key: string) {
    // otherwise spit the key and get from mongo
    const [ref, id] = key.split(".");

    // TODO: the hotpath here is usually checking on things which don't exist in the db
    //  - we've solved for this in one implementation by loading everything in to memory and setting engine.warmDb [to prevent db reads], but this has a mem limit (however heap is manageble atm)...
    //  - we could have a system to record only the index and store that in mem (btree + bloomfilters), but we will still risk reaching limits...
    //  - when we start nearing our limit we could move the btree to disk and continue there (depending on depth this could require several reads to seek by key)
    //  - alternatively we can perist everything to disk by key and we can refrain from doing any seeks by range etc - this will require local storage space the same size as the db medium
    //  - or we give up on using a db persistance layer and store everything locally - this would mean stateful deployments/a connected persistence medium - i/o could still be a constraint.

    // check in runtime cache
    if (ref && id) {
      // console.log(`getting ${key}`);
      const val = this.kv[ref]?.[id];

      // return the value
      if (val) return val;
    }

    // for valid single entry get...
    if (
      ref &&
      id &&
      !this.engine.newDb &&
      (!this.engine.warmDb || ref === "__meta__")
    ) {
      // this wants to get only the most recent insertion
      const result = await (await Promise.resolve(this.db))
        .collection(ref)
        .findOne({ id }, { sort: { _block_ts: -1 } });

      // return if we discovered a result
      if (result) return result;
    }

    // for valid entry reqs (used in migrations)...
    if (
      ref &&
      !id &&
      !this.engine.newDb &&
      (!this.engine.warmDb || ref === "__meta__")
    ) {
      // return a materialised view for immutable collection - this will get a snapshot of the most recent state for each id...
      if (!this.mutable && ref !== "__meta__") {
        // get collection for the ref
        const collection = (await Promise.resolve(this.db)).collection(ref);
        // get the total number of results we expect to retrieve
        const totalCountAggregate = collection.aggregate([
          {
            $sort: {
              _block_ts: -1,
            },
          },
          {
            $group: {
              _id: "$id",
              latestDocument: {
                $first: "$$ROOT",
              },
            },
          },
          {
            $count: "totalDocuments",
          },
        ]);
        // batch them into 10000 blocks to not overwhelm the driver
        const batchSize = 5000;
        const totalCount = await totalCountAggregate.next();
        const totalCountResult = totalCount ? totalCount.totalDocuments : 0;
        // move skip along
        let skip = 0;
        // collect all results into array
        const result = [];
        // while theres still results left...
        while (skip < totalCountResult) {
          (
            await collection
              .aggregate([
                {
                  $sort: {
                    _block_ts: -1,
                  },
                },
                {
                  $group: {
                    _id: "$id",
                    latestDocument: {
                      $first: "$$ROOT",
                    },
                  },
                },
                {
                  $replaceRoot: { newRoot: "$latestDocument" },
                },
                {
                  $skip: skip,
                },
                {
                  $limit: batchSize,
                },
              ])
              .toArray()
          ).forEach((obj) => {
            // push all to the result
            result.push(obj);
          });
          // Process or store the documents in memory here
          skip += batchSize;
        }

        // return if the collections holds values
        if (result && result.length) return result;
      } else {
        // fing all on the ref table
        const result = await (
          await Promise.resolve(this.db)
        )
          // if we're immutable then get from the materialised view
          .collection(ref)
          .find({})
          .toArray();
        // return if the collection holds values
        if (result && result.length) return result;
      }
    } else if (ref && !id) {
      // can get all from kv store
      const val = this.kv[ref];

      // return the collection
      if (val) return Object.values(val);
    }

    // throw not found to indicate we can't find it
    throw new NotFound("Not Found");
  }

  // store into mongodb
  async put(key: string, val: Record<string, unknown>) {
    // spit the key and get from mongo
    const [ref, id] = key.split(".");

    // default the collection
    this.kv[ref] = this.kv[ref] || {};

    // for valid reqs...
    if (ref && id) {
      // console.log(`putting ${key}`, val);
      this.kv[ref][id] = val;

      // prevent alterations in read-only mode
      if (!this.engine.readOnly) {
        // resolve db promise layer
        const db = await Promise.resolve(this.db);
        // get the collection for this entity
        const collection = db.collection(ref);

        // this will update the most recent entry or upsert a new document (do we want this to insert a new doc every update?)
        await collection.replaceOne(
          {
            id,
            // if ids are unique then we can place by update by checking for a match on current block setup
            ...(this.mutable || ref === "__meta__"
              ? {}
              : {
                  _block_ts: val?._block_ts,
                  _block_num: val?._block_num,
                  _chain_id: val?._chain_id,
                }),
          },
          // the replacement values
          val,
          {
            upsert: true,
          }
        );
      }
    }

    return true;
  }

  // delete from mongodb (not sure we ever need to do this? We could noop)
  async del(key: string) {
    // spit the key and get from mongo
    const [ref, id] = key.split(".");

    // default the collection
    this.kv[ref] = this.kv[ref] || {};

    // for valid reqs...
    if (ref && id) {
      // remove from local-cache
      delete this.kv[ref][id];
      // prevent alterations in read-only mode
      if (!this.engine.readOnly) {
        // get the collection for this entity
        const collection = (await Promise.resolve(this.db)).collection(ref);
        // this will delete the latest entry - do we want to delete all entries??
        // would it be better to put an empty here instead?
        const document = collection.findOne(
          { id },
          { sort: { _block_ts: -1 } }
        );

        // delete the single document we discovered
        if (document) {
          await collection.deleteOne(document);
        }
      }
    }

    return true;
  }

  // perfom a bulkWrite against mongodb
  async batch(vals: BatchOp[]) {
    // collect every together into appropriate collections
    const byCollection = vals.reduce((collection, val) => {
      // avoid reassigning props of param error
      const collected = collection;

      // pull ref from the given key
      const [ref] = val.key.split(".");

      // keep going or start fresh
      collected[ref] = collected[ref] || [];

      // only collect true values
      if (val.type === "del" || val?.value) {
        collected[ref].push(val);
        // make sure the store exists to cache values into
        this.kv[ref] = this.kv[ref] || {};
      }

      return collected;
    }, {} as Record<string, typeof vals>);

    // eslint-disable-next-line no-restricted-syntax
    for (const collection of Object.keys(byCollection)) {
      // convert the operations into a set of mongodb bulkWrite operations
      const batch = byCollection[collection].reduce((operations, val) => {
        // Put operation operates on the id + block to upsert a new entity entry
        if (val.type === "put") {
          // construct replacement value set
          const replacement = {
            // ignore the _id key because this will cause an error in mongo
            ...Object.keys(val.value || {}).reduce((carr, key) => {
              return {
                ...carr,
                // add everything but the _id
                ...(key !== "_id"
                  ? {
                      [key]: val.value?.[key],
                    }
                  : {}),
              };
            }, {} as Record<string, unknown>),
            // add block details to the insert (this is what makes it an insert - every event should insert a new document)
            _block_ts: val.value?._block_ts,
            _block_num: val.value?._block_num,
            _chain_id: val.value?._chain_id,
          };
          // push operation for bulkwrite
          operations.push({
            replaceOne: {
              filter: {
                // each entry is unique by block and id
                id: val.key.split(".")[1],
                // if ids are unique then we can place by update
                ...(this.mutable || collection === "__meta__"
                  ? {}
                  : {
                      _block_ts: val.value?._block_ts,
                      _block_num: val.value?._block_num,
                      _chain_id: val.value?._chain_id,
                    }),
              },
              replacement,
              // insert new entry if criteria isnt met
              upsert: true,
            },
          });
          // store in to local-cache
          this.kv[collection][val.key.split(".")[1]] = replacement;
        }
        // del will delete ALL entries from the collection (this shouldnt need to be called - it might be wiser to insert an empty entry than to try to delete anything)
        if (val.type === "del") {
          operations.push({
            deleteMany: {
              filter: { id: val.key.split(".")[1] },
            },
          });
          // delete the value from cache
          delete this.kv[collection][val.key.split(".")[1]];
        }
        // returns all Document operations
        return operations;
      }, [] as AnyBulkWriteOperation<Document>[]);

      // save the batch to mongo
      if (!this.engine.readOnly && batch.length) {
        // eslint-disable-next-line no-await-in-loop
        await (await Promise.resolve(this.db))
          .collection(collection)
          .bulkWrite(batch, {
            // allow for parallel writes (we've already ensured one entry per key with our staged sets (use checkpoint & commit))
            ordered: false,
            // write objectIds mongo side
            forceServerObjectId: true,
          });
      }
    }

    return true;
  }
}

export default Mongo;
