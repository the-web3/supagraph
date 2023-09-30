import { MongoClient, Collection, Document } from "mongodb";
import { Mongo } from "../../src/sync/mongo";

// Mock the mongodb methods and classes
jest.mock("mongodb");

describe("Mongo", () => {
  let mockClient: MongoClient;
  let mockDb: ReturnType<MongoClient["db"]>;
  let mockCollection: Collection<Document>;

  beforeEach(() => {
    // Create mock instances for each test
    mockDb = {
      collection: jest.fn(),
    } as unknown as ReturnType<MongoClient["db"]>;

    mockCollection = {
      findOne: jest.fn(),
      updateOne: jest.fn(),
      replaceOne: jest.fn(),
      bulkWrite: jest.fn(),
      deleteOne: jest.fn(),
    } as unknown as Collection<Document>;

    mockClient = {
      db: jest.fn(() => mockDb) as MongoClient["db"],
    } as unknown as MongoClient;

    (mockDb.collection as jest.Mock) = jest.fn(() => mockCollection);
    (mockCollection.findOne as jest.Mock) = jest.fn();
  });

  it("should create an instance of Mongo", async () => {
    const db = new Mongo(mockClient, "testDb", {});
    expect(db).toBeInstanceOf(Mongo);
  });

  it("should initialize with the given kv data", async () => {
    const kvData = {
      exampleRef: {
        id1: { data: "value1" },
        id2: { data: "value2" },
      },
    };
    const db = new Mongo(mockClient, "testDb", kvData);

    expect(db.kv).toEqual(kvData);
  });

  it("should update kv data", async () => {
    const kvData = {
      exampleRef: {
        id1: { data: "value1" },
        id2: { data: "value2" },
      },
    };
    const db = new Mongo(mockClient, "testDb", {});

    await db.update({ kv: kvData });

    expect(db.kv).toEqual(kvData);
  });

  it("should get a value using the get method", async () => {
    // connect to the mockClient
    const db = new Mongo(mockClient, "testDb", {});
    // get an entry
    await db.get("exampleRef.id1");

    // expect to have attempt a query
    expect(mockCollection.findOne).toHaveBeenCalledWith(
      { id: "id1" },
      { sort: { _block_ts: -1 } }
    );
  });

  it("should put a value using the put method", async () => {
    // connect to the mockClient
    const db = new Mongo(mockClient, "testDb", {});
    // put an entry
    await db.put("exampleRef.id1", {
      id: "id1",
      data: "new-value",
    });

    // expect to have attempt a query
    expect(mockCollection.replaceOne).toHaveBeenCalledWith(
      {
        id: "id1",
        _block_ts: undefined,
        _block_num: undefined,
        _chain_id: undefined,
      },
      {
        id: "id1",
        data: "new-value",
        _block_ts: undefined,
        _block_num: undefined,
        _chain_id: undefined,
      },
      {
        upsert: true,
      }
    );
  });

  it("should perform batch operations", async () => {
    const db = new Mongo(mockClient, "testDb", {});

    const batchData: {
      type: "put" | "del";
      key: string;
      value?: Record<string, unknown>;
    }[] = [
      {
        type: "put",
        key: "exampleRef.id1",
        value: { id: "id1", data: "value1" },
      },
      {
        type: "put",
        key: "exampleRef.id2",
        value: { id: "id2", data: "value2" },
      },
      { type: "del", key: "exampleRef.id3" },
    ];
    await db.batch(batchData);

    expect(mockCollection.bulkWrite).toHaveBeenCalledWith(
      [
        {
          replaceOne: {
            filter: {
              id: "id1",
              _block_ts: undefined,
              _block_num: undefined,
              _chain_id: undefined,
            },
            replacement: {
              id: "id1",
              data: "value1",
              _block_ts: undefined,
              _block_num: undefined,
              _chain_id: undefined,
            },
            upsert: true,
          },
        },
        {
          replaceOne: {
            filter: {
              id: "id2",
              _block_ts: undefined,
              _block_num: undefined,
              _chain_id: undefined,
            },
            replacement: {
              id: "id2",
              data: "value2",
              _block_ts: undefined,
              _block_num: undefined,
              _chain_id: undefined,
            },
            upsert: true,
          },
        },
        {
          deleteMany: {
            filter: { id: "id3" },
          },
        },
      ],
      {
        ordered: false,
        forceServerObjectId: true,
      }
    );
  });
});