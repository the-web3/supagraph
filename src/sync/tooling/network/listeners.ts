import { errors } from "ethers";
import { JsonRpcProvider, WebSocketProvider } from "@ethersproject/providers";
import { TransactionResponse } from "@ethersproject/abstract-provider";

import { getEngine } from "@/sync/tooling/persistence/store";
import { processListenerBlock } from "@/sync/tooling/processing";
import { saveJSON, readJSON } from "@/sync/tooling/persistence/disk";

import { AsyncBlockParts, Migration, Sync } from "@/sync/types";

import { getBlockByNumber } from "@/sync/tooling/network/blocks";
import { getNetworks } from "@/sync/tooling/network/providers";
import { getTransactionReceipt } from "@/sync/tooling/network/transactions";

// create a listener to attach to the provider
export const createListener = (
  state: {
    inSync: boolean;
    listening?: boolean;
  },
  chainId: number,
  indexedMigrations: Record<string, Migration[]>,
  blockQueue: {
    chainId: number;
    number: number;
    asyncParts: Promise<() => Promise<AsyncBlockParts>>;
    asyncEntities: Record<string, Record<number, Promise<{ id: string }[]>>>;
  }[]
) => {
  return async (number: number) => {
    // push to the block stack to signal the block is retrievable
    if (state.listening) {
      // console.log("\nPushing block:", blockNumber, "on chainId:", chainId);
      await recordListenerBlock(
        number,
        +chainId,
        indexedMigrations,
        blockQueue
      );
    }
  };
};

// construct an error handler to attach to the provider
export const createErrorHandler = (
  errorHandlers: {
    reject?: (reason?: any) => void;
    resolve?: (value: void | PromiseLike<void>) => void;
  } = undefined
) => {
  return async (error: Error & { code: string }) => {
    // handle the error by code...
    switch (error.code) {
      case errors.NETWORK_ERROR:
      case errors.SERVER_ERROR:
      case errors.UNSUPPORTED_OPERATION:
        // print the error
        console.error("Network Error:", error.message);
        // reject propagation and trigger close (on all listeners)
        if (errorHandlers?.reject) {
          errorHandlers.reject(error);
        }
        break;
      case errors.TIMEOUT:
        // timeouts will be handled internally
        break;
      default:
        // don't close but print the error...
        console.error("Unhandled error:", error.message);
    }
  };
};

// pull the next block form the queue
export const attemptNextBlock = async (
  blockQueue: {
    chainId: number;
    number: number;
    asyncParts: Promise<() => Promise<AsyncBlockParts>>;
    asyncEntities: Record<
      string,
      Record<
        number,
        Promise<
          {
            id: string;
          }[]
        >
      >
    >;
  }[],
  indexedMigrations: Record<string, Migration[]>
) => {
  // access the engine
  const engine = await getEngine();

  // extract the chainId we will be operating on
  const chainId = +blockQueue[0].chainId;
  // check that this block follows the last completed block sequentially
  const latestBlock = engine.latestBlocks[chainId];
  // if the gap is greater than one then...
  if (blockQueue[0].number - latestBlock.number > 1) {
    // start from the latestBlocks blockNumber...
    let latestBlockNumber = latestBlock.number;
    // ... we need to close it
    while (latestBlockNumber !== blockQueue[0].number) {
      // push all prev blocks in ascending block order
      recordListenerBlock(
        // move to the next block each incr
        (latestBlockNumber += 1),
        chainId,
        indexedMigrations,
        blockQueue
      );
    }
  }
  // take the next block in the queue (this might not be the same block as the old blockQueue[0] but chainId will be the same)
  const [{ number, asyncParts, asyncEntities }] = blockQueue.splice(0, 1);

  // attempt to process the events in this block (record currentProcess so we can wait for it to complete before closing)...
  engine.currentProcess = processListenerBlockSafely(
    number,
    chainId,
    asyncParts,
    asyncEntities,
    indexedMigrations,
    blockQueue
  );
  // await the currentProcess
  await engine.currentProcess;
};

// attach listeners (listening for blocks) to enqueue prior to processing
export const attachListeners = async (
  state: {
    inSync: boolean;
    listening?: boolean;
  } = {
    inSync: true,
    listening: true,
  },
  migrations: Migration[] = [],
  errorHandlers: {
    reject?: (reason?: any) => void;
    resolve?: (value: void | PromiseLike<void>) => void;
  } = undefined
) => {
  // retrieve engine
  const engine = await getEngine();

  // get all chainIds for defined networks
  const { syncProviders } = await getNetworks();

  // array of blocks that need to be processed...
  const blockQueue: {
    chainId: number;
    number: number;
    asyncParts: Promise<() => Promise<AsyncBlockParts>>;
    asyncEntities: Record<string, Record<number, Promise<{ id: string }[]>>>;
  }[] = [];

  // index all migrations
  const indexedMigrations = migrations.reduce((index, migration) => {
    // start arr to keep migrations for chainId at blockNumber
    index[`${migration.chainId}-${migration.blockNumber}`] =
      index[`${migration.chainId}-${migration.blockNumber}`] || [];

    // store the migration
    index[`${migration.chainId}-${migration.blockNumber}`].push(migration);

    // return the index
    return index;
  }, {} as Record<string, Migration[]>);

  // process these ops once now (then again after every block)
  const ops = await getValidSyncOps();

  // attach a single listener for each provider
  const listeners = await Promise.all(
    Object.keys(syncProviders).map(async (chainId) => {
      // proceed with valid ops
      if (ops[+chainId].length) {
        // construct a listener to attach to the provider
        const listener = createListener(
          state,
          +chainId,
          indexedMigrations,
          blockQueue
        );
        // construct an error handler to attach to the provider
        const handler = createErrorHandler(errorHandlers);

        // attach this listener to onBlock to start collecting blocks
        syncProviders[+chainId].on("block", listener);

        // attach close to error handler
        syncProviders[+chainId].on("error", handler);

        // return detach method to stop the handler - this will be triggered onError
        return async () => {
          // stop listening for new errors and blocks first
          syncProviders[+chainId].off("error", handler);
          syncProviders[+chainId].off("block", listener);

          // wait for the current block to complete
          if (engine.currentProcess) await engine.currentProcess;

          // remove the lock for the next iteration
          engine.latestEntity[chainId].set("locked", false);
          // persist changes into the store
          engine.latestEntity[chainId] = await engine.latestEntity[
            chainId
          ].save();
        };
      }

      // no valid ops
      return false;
    })
  );

  // on the outside, we need to process all events emitted by the handlers to execute procedurally
  Promise.resolve()
    .then(async () => {
      // pull from the reqStack and process...
      while (state.listening) {
        // once the state moves to inSync - we can start taking blocks from the array to process
        if (blockQueue.length && state.inSync) {
          // take the next block from the challenge queue
          await attemptNextBlock(blockQueue, indexedMigrations);
        } else {
          // wait 1 second for something to enter the queue
          await new Promise((resolve) => {
            setTimeout(resolve, 1000);
          });
        }
      }
    })
    .catch((e) => {
      // reject propagation and close
      if (errorHandlers?.reject) {
        errorHandlers.reject(e);
      }
    });

  // retun a handler to remove the listener
  return [
    // all valid listeners
    ...listeners.filter((v) => v),
  ];
};

// restructure ops into ops by chainId
export const getValidSyncOps: () => Promise<
  Record<number, Sync[]>
> = async () => {
  // get the engine
  const engine = await getEngine();
  // get all chainIds for defined networks
  const networks = await getNetworks();

  // return the indexed valid ops
  return Object.keys(networks.syncProviders)
    .map((chainId) => {
      // filter for ops associated with this chainid
      const ops = engine.syncs.filter(
        (op) =>
          // is for chainId
          op.provider.network.chainId === +chainId
      );

      return {
        chainId: +chainId,
        validOps: ops,
      };
    })
    .reduce((all, op) => {
      return {
        ...all,
        [op.chainId]: op.validOps,
      };
    }, {});
};

// get a receipt for the given details
export const getReceipt = async (
  tx: TransactionResponse,
  chainId: number,
  provider: JsonRpcProvider
) => {
  // retrieve the engine to check flags
  const engine = await getEngine();
  // this promise.all is trapped until we resolve all tx receipts in the block
  try {
    // get the receipt
    const fullTx = await getTransactionReceipt(provider, tx);
    // try again
    if (!fullTx.transactionHash) throw new Error("Missing hash");

    // if we're tmp storing data...
    if (!engine.flags.cleanup) {
      // save each tx to disk to release from mem
      await saveJSON(
        "transactions",
        `${chainId}-${fullTx.transactionHash}`,
        fullTx as unknown as Record<string, unknown>
      );
    }

    // return the tx
    return fullTx;
  } catch {
    // attempt to get receipt again on failure
    return getReceipt(tx, chainId, provider);
  }
};

// await collection of the block and receipt, saving to disk, then return a fn to read back the data from disk
export const awaitListenerBlockAndReceipts = async (
  number: number,
  chainId: number,
  syncProviders: Record<number, JsonRpcProvider | WebSocketProvider>
) => {
  // retrieve engine
  const engine = await getEngine();

  // get the full block details
  const block = await getBlockByNumber(syncProviders[+chainId], number);

  // get all receipts for the block - we need the receipts to access the logBlooms (if we're only doing onBlock/onTransaction we dont need to do this unless collectTxReceipts is true)
  const receipts = (
    await Promise.all(
      block.transactions.map((tx) =>
        getReceipt(tx, +chainId, syncProviders[+chainId])
      )
    )
  ).reduce((all, receipt) => {
    // combine all receipts to create an indexed lookup obj
    return {
      ...all,
      [receipt.transactionHash]: receipt,
    };
  }, {});

  // if we're tmp storing data...
  if (!engine.flags.cleanup) {
    // save the block for sync-cache
    await saveJSON("blocks", `${chainId}-${+block.number}`, {
      block,
    });
  }

  // save everything together to reduce readback i/o (if we're using cleanup true - this is all we will save - we will delete it after processing)
  await saveJSON("blockAndReceipts", `${chainId}-${+block.number}`, {
    block,
    receipts,
  });
};

// pull all block and receipt details (cancel attempt after 30s)
export const saveListenerBlockAndReceipts = async (
  number: number,
  chainId: number
) => {
  // get all chainIds for defined networks
  const { syncProviders } = await getNetworks();

  // return the full block and receipts in 60s or cancel
  return awaitListenerBlockAndReceipts(number, chainId, syncProviders);
};

// read a block and its receipt from disk
export const readListenerBlockAndReceipts = async (
  number: number,
  chainId: number
) => {
  try {
    // read block and receipts from the disk stored blockAndReceipts
    const { block, receipts } = await readJSON(
      "blockAndReceipts",
      `${chainId}-${+number}`
    );
    return {
      block,
      receipts,
    } as AsyncBlockParts;
  } catch {
    return false as unknown as AsyncBlockParts;
  }
};

// record the block for the given chainId
export const recordListenerBlock = async (
  number: number,
  chainId: number,
  indexedMigrations: Record<string, Migration[]>,
  blockQueue: {
    chainId: number;
    number: number;
    asyncParts: Promise<() => Promise<AsyncBlockParts>>;
    asyncEntities: Record<string, Record<number, Promise<{ id: string }[]>>>;
  }[]
) => {
  // access db via the engine
  const engine = await getEngine();
  // store all in sparse array (as obj)
  const asyncMigrationEntities: Record<
    string,
    Record<number, Promise<{ id: string }[]>>
  > = {};

  // check if any migration is relevant in this block
  if (indexedMigrations[`${chainId}-${number}`]) {
    // start collecting entities for migration now (this could be expensive)
    indexedMigrations[`${chainId}-${number}`].forEach((migration, key) => {
      asyncMigrationEntities[`${chainId}-${number}`] =
        asyncMigrationEntities[`${chainId}-${number}`] || {};
      asyncMigrationEntities[`${chainId}-${number}`][key] = new Promise(
        (resolve) => {
          resolve(
            migration.entity &&
              (engine.db.get(migration.entity) as Promise<{ id: string }[]>)
          );
        }
      );
    });
  }

  // record the new block
  blockQueue.push({
    number,
    chainId: +chainId,
    // start fetching these parts now, we will wait for them when we begin processing the blocks...
    asyncParts: saveListenerBlockAndReceipts(number, chainId).then(() => {
      return () => readListenerBlockAndReceipts(number, chainId);
    }),
    // record migration entities on the block
    asyncEntities: asyncMigrationEntities,
  });
};

// stop waiting for a read action
const cancelReadWait = () => {
  return new Promise<AsyncBlockParts>((resolve) => {
    setTimeout(() => resolve({} as unknown as AsyncBlockParts), 10000);
  });
};

// check for the current value set in wraper
const cancelOp = async (
  blockAndReceipts: Promise<AsyncBlockParts>,
  resolve: () => void
) => {
  // set cancelled on the asyncParts obj we're passing through processListenerBlock
  if (blockAndReceipts) {
    // await the blockAndReceipt promise
    const vals = await Promise.race([cancelReadWait(), blockAndReceipts]);
    // mark as cancelled
    vals.cancelled = true;
    // delete from wrapper
    delete vals?.block;
    delete vals?.receipts;
  }
  // resolve to end processing
  resolve();
};

// method to cancel the block after a timeout (default of 30s)
const cancelListenerBlockAfterTimeout = async (
  blockAndReceipts: Promise<AsyncBlockParts>,
  timeout: number = 30000,
  ref: {
    current?: NodeJS.Timeout;
    resolve?: () => void;
    resolver?: (
      blockAndReceipts: Promise<AsyncBlockParts>,
      resolve: () => void
    ) => void;
  } = {}
) => {
  // return a promise to resolve the cancelation on the provided vals
  return new Promise<void>((resolve) => {
    // store the resolver
    ref.resolver = cancelOp;
    // attach caller to the ref
    ref.resolve = () => ref.resolver(blockAndReceipts, resolve);
    // add another 60s to process the block
    ref.current = setTimeout(ref.resolve, Math.max(timeout, 10000)); // min of 10s per block, default of 30s - we'll adjust if needed
  });
};

// restack this at the top so that we can try again
const restackListenerBlock = (
  number: number,
  chainId: number,
  asyncEntities: Record<
    string,
    Record<
      number,
      Promise<
        {
          id: string;
        }[]
      >
    >
  >,
  blockQueue: {
    chainId: number;
    number: number;
    asyncParts: Promise<() => Promise<AsyncBlockParts>>;
    asyncEntities: Record<string, Record<number, Promise<{ id: string }[]>>>;
  }[]
) => {
  blockQueue.splice(0, 0, {
    number,
    chainId,
    // recreate the async parts to pull everything fresh
    asyncParts: saveListenerBlockAndReceipts(number, chainId).then(() => {
      // return method to read the data back into memory
      return () => readListenerBlockAndReceipts(number, chainId);
    }),
    // this shouldn't fail (but it could be empty)
    asyncEntities,
  });
};

// begine processing the block
export const startProcessingBlock = async (
  number: number,
  chainId: number,
  indexedMigrations: Record<string, Migration[]>,
  blockQueue: {
    chainId: number;
    number: number;
    asyncParts: Promise<() => Promise<AsyncBlockParts>>;
    asyncEntities: Record<string, Record<number, Promise<{ id: string }[]>>>;
  }[],
  asyncEntities: Record<string, Record<number, Promise<{ id: string }[]>>>,
  blockAndReceipts: Promise<AsyncBlockParts>,
  cancelRef: {
    current?: NodeJS.Timeout;
    resolve?: () => void;
    resolver?: (
      blockAndReceipts: Promise<AsyncBlockParts>,
      resolve: () => void
    ) => void;
  }
) => {
  const engine = await getEngine();
  try {
    // attempt to process the block
    await processListenerBlock(
      // blockNumber being processed...
      number,
      // the chainId it belongs to...
      +chainId,
      // process validOps [for this chain] each tick to associate any new syncs (cache and invalidate?)
      await getValidSyncOps(),
      // pass through the config...
      engine.flags.collectBlocks,
      engine.flags.collectTxReceipts,
      engine.flags.silent,
      // pass through the length of the queue for reporting and for deciding if we should be saving or not
      blockQueue.length,
      // helper parts to pass through entities, block & receipts...
      indexedMigrations,
      asyncEntities,
      blockAndReceipts
    );
    // if any of this cleanup logic throws we don't need to do anything with the error...
    try {
      // final await on the block and receipts
      const vals = await blockAndReceipts;
      // clear timeout to prevent cancellation
      if (typeof cancelRef.resolver !== "undefined") {
        // clear the timeout to prevent calling the handler
        clearTimeout(cancelRef.current);
        // set the resolver but don't clear the timeout because we want it to resolve its promise
        cancelRef.resolver = (_, resolve) => {
          // mark for g/c
          delete cancelRef.resolve;
          delete cancelRef.resolver;
          delete cancelRef.current;
          // resolve the promise
          resolve();
        };
      }
      // record the new number
      if (vals?.cancelled) {
        // reattempt the timedout block
        restackListenerBlock(number, chainId, asyncEntities, blockQueue);
      }
      // delete cancelled marker
      delete vals?.cancelled;
      // delete from details from the wrapper
      delete vals?.block;
      delete vals?.receipts;
    } finally {
      // clear the cancelListenerBlockAfterTimeout promise (by resolving it now)
      if (typeof cancelRef.resolver !== "undefined") {
        // call resovle to clear the promise after completing this callback
        setTimeout(cancelRef.resolve);
      }
      // unref the content of the promise
      await blockAndReceipts.then(() => null);
    }
  } catch (e) {
    // log the error
    console.log(e);
    // reattempt the failed block
    restackListenerBlock(number, chainId, asyncEntities, blockQueue);
  }
};

// process the events from a block
export const processListenerBlockSafely = async (
  number: number,
  chainId: number,
  asyncParts: Promise<() => Promise<AsyncBlockParts>>,
  asyncEntities: Record<
    string,
    Record<
      number,
      Promise<
        {
          id: string;
        }[]
      >
    >
  >,
  indexedMigrations: Record<string, Migration[]>,
  blockQueue: {
    chainId: number;
    number: number;
    asyncParts: Promise<() => Promise<AsyncBlockParts>>;
    asyncEntities: Record<string, Record<number, Promise<{ id: string }[]>>>;
  }[]
) => {
  // get the engine
  const engine = await getEngine();
  // check if this block needs to be processed (check its not included in the catchup-set)
  if (
    engine.startBlocks[+chainId] &&
    // @TODO: replace these with exact number checks
    number >= engine.startBlocks[+chainId] &&
    number >= engine.latestBlocks[+chainId].number
  ) {
    // track cancellation timeout for cancelling
    const cancelRef = {};
    // start reading data from disk - this will pull the async data at chainId with current number
    const blockAndReceipts = (await asyncParts)();
    // wrap in a race here so that we never spend too long stuck on a block
    await Promise.race([
      // place a promise to cancel the block in 60s (configurable?)
      cancelListenerBlockAfterTimeout(blockAndReceipts, 30000, cancelRef),
      // attempt to resolve everything that happened in the block...
      startProcessingBlock(
        number,
        chainId,
        indexedMigrations,
        blockQueue,
        asyncEntities,
        blockAndReceipts,
        cancelRef
      ),
    ]);
  }
};
