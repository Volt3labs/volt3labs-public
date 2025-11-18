import { ethers } from "ethers";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ---------- CONFIG ----------

// Ronin RPC
const RPC_URL = "https://api.roninchain.com/rpc";
const provider = new ethers.JsonRpcProvider(RPC_URL);

// Tokens we track
const TOKENS = [
  {
    symbol: "AXS",
    address: "0x97a9107c1793bc407d6f527b77e7fff4d812bece",
    decimals: 18,
  },
  {
    symbol: "WETH",
    address: "0xc99a6a985ed2cac1ef41640596c5a5f9f4e19ef5",
    decimals: 18,
  },
];

// Treasury + proxies
const TREASURY_ADDRESS =
  "0x245db945c485b68fdc429e4f7085a1761aa4d45d".toLowerCase();
const PROXY_ADDRESSES = [
  "0x3b3adf1422f84254b7fbb0e7ca62bd0865133fe3".toLowerCase(),
];

// EVM Transfer event signature
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

// getLogs constraints
const BLOCK_SPAN = 400;
const MAX_CONCURRENCY = 2;
const BATCH_DELAY_MS = 300;

// ---------- HELPERS ----------

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// Build windows like: [start, start+399], [next, next+399], ...
function buildRangesForward(fromBlock: number, toBlock: number, span: number) {
  const ranges: { fromBlock: number; toBlock: number }[] = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + span - 1, toBlock);
    ranges.push({ fromBlock: start, toBlock: end });
    start = end + 1;
  }
  return ranges;
}

// topic (32 bytes) → checksummed address
function topicToAddress(topic: string): string {
  const hex = "0x" + topic.slice(-40);
  return ethers.getAddress(hex);
}

// Decide who gets “credit” for this transfer
function computeContributor(transferFrom: string, txFrom: string): string {
  const fromLower = transferFrom.toLowerCase();
  if (PROXY_ADDRESSES.includes(fromLower)) {
    return ethers.getAddress(txFrom); // attribute to tx sender if proxy was used
  }
  return transferFrom;
}

// ---------- CORE INDEXER ----------

async function indexRange(fromBlock: number, toBlock: number) {
  const treasury = TREASURY_ADDRESS;
  const toTopic = ethers.zeroPadValue(treasury, 32);

  // Transfer(address indexed from, address indexed to, uint256 value)
  const topicsFilter = [TRANSFER_TOPIC, null, toTopic];

  const tokenAddrMap = new Map(
    TOKENS.map((t) => [t.address.toLowerCase(), t])
  );

  const ranges = buildRangesForward(fromBlock, toBlock, BLOCK_SPAN);
  const batches = chunkArray(ranges, MAX_CONCURRENCY);

  const totalWeiByToken = new Map<string, bigint>();
  let totalRecords = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(
      `Batch ${i + 1}/${batches.length} → blocks ${
        batch[0].fromBlock
      }..${batch[batch.length - 1].toBlock}`
    );

    try {
      const results = await Promise.all(
        batch.map((r) =>
          provider.getLogs({
            address: TOKENS.map((t) => t.address),
            fromBlock: r.fromBlock,
            toBlock: r.toBlock,
            topics: topicsFilter,
          })
        )
      );

      for (const logs of results) {
        for (const log of logs) {
          const token = tokenAddrMap.get(log.address.toLowerCase());
          if (!token) {
            // not AXS or WETH we care about
            continue;
          }

          const transferFrom = topicToAddress(log.topics[1]);
          const transferTo = topicToAddress(log.topics[2]);
          const valueWei = BigInt(log.data);

          // Fetch tx to know who actually sent it
          const tx = await provider.getTransaction(log.transactionHash);
          if (!tx) {
            console.warn("Transaction not found. Skipping:", log.transactionHash);
            continue;
          }

          const txFrom = ethers.getAddress(tx.from);
          const contributor = computeContributor(transferFrom, txFrom);
          const formatted = ethers.formatUnits(valueWei, token.decimals);
          const proxyUsed = PROXY_ADDRESSES.includes(
            transferFrom.toLowerCase()
          );

          // accumulate total per token
          const prev = totalWeiByToken.get(token.symbol) ?? 0n;
          totalWeiByToken.set(token.symbol, prev + valueWei);

          try {
            await prisma.treasuryTransfer.upsert({
              where: {
                txHash_logIndex: {
                  txHash: log.transactionHash,
                  logIndex: log.index,
                },
              },
              update: {}, // immutable
              create: {
                txHash: log.transactionHash,
                logIndex: log.index,
                blockNumber: log.blockNumber,
                tokenSymbol: token.symbol,
                tokenAddress: token.address,
                treasury: transferTo,
                proxyUsed,
                txFrom,
                transferFrom,
                transferTo,
                contributor,
                amountRaw: valueWei.toString(),
                amountFormatted: formatted,
              },
            });
            totalRecords += 1;
          } catch (dbErr) {
            console.error(
              "DB error (upsert) for log",
              log.transactionHash,
              log.index,
              dbErr
            );
          }
        }
      }
    } catch (err) {
      console.error(`Error in batch ${i + 1}:`, err);
    }

    await sleep(BATCH_DELAY_MS);
  }

  return { totalWeiByToken, totalRecords };
}

// ---------- MAIN ----------

(async () => {
  try {
    // full backfill range
    const FROM_BLOCK = 16377000;
    const TO_BLOCK = 50532500;

    console.log(
      `Indexing AXS + WETH from block ${FROM_BLOCK} to ${TO_BLOCK}...`
    );

    const startTime = Date.now();

    const { totalWeiByToken, totalRecords } = await indexRange(
      FROM_BLOCK,
      TO_BLOCK
    );

    console.log(`\nTotal records stored: ${totalRecords}`);

    for (const token of TOKENS) {
      const wei = totalWeiByToken.get(token.symbol) ?? 0n;
      const formatted = ethers.formatUnits(wei, token.decimals);
      console.log(
        `Total inflow for ${token.symbol}: ${formatted} ${token.symbol}`
      );
    }

    const endTime = Date.now();
    console.log(
      `\nAll done in ${((endTime - startTime) / 1000).toFixed(2)} seconds`
    );
  } catch (e) {
    console.error("Fatal error in indexer:", e);
  } finally {
    await prisma.$disconnect();
  }
})();
