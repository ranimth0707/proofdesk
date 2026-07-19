/**
 * verify-anchors — independent audit of the desk's on-chain trail.
 *
 * For every anchor in the ledger:
 *   1. re-derive the canonical payload from the ledger rows it claims to cover,
 *   2. re-hash it (SHA-256),
 *   3. fetch the memo transaction from Solana and compare the on-chain hash.
 *
 * A single mismatch means the ledger was edited after anchoring — exactly the
 * tampering this scheme exists to expose. Anyone can run this against our DB
 * and public chain data; no trust in ProofDesk required.
 */

import { Connection } from "@solana/web3.js";
import { DB_PATH, activeNetwork } from "../src/config.js";
import { Ledger } from "../src/ledger/db.js";
import { canonicalPayload, payloadHash } from "../src/anchorlog/anchor.js";
import type { Fill, Quote } from "../src/types.js";

async function main(): Promise<void> {
  const dbPath = process.argv[2] ?? DB_PATH;
  const ledger = new Ledger(dbPath);
  const conn = new Connection(activeNetwork().rpcUrl, "confirmed");
  const session = ledger.getMeta("session") ?? "?";

  const anchors = ledger.anchors() as {
    seq: number; kind: string; payloadHash: string; coverage: string; txSig: string | null; status: string;
  }[];
  console.log(`\nVERIFY ANCHORS — db=${dbPath} session=${session} network=${activeNetwork().network}`);
  console.log("=".repeat(72));
  let ok = 0, bad = 0, skipped = 0;

  const allQuotes = new Map(ledger.recentQuotes(1_000_000).map((q) => [q.id, q]));
  const allFills = new Map(ledger.recentFills(1_000_000).map((f) => [f.id, f]));

  for (const a of anchors) {
    if (!a.txSig) { skipped++; console.log(`SKIP  #${a.seq} (${a.status})`); continue; }

    let localHash: string;
    if (a.kind === "activity") {
      const cov = JSON.parse(a.coverage) as { quotes: string[]; fills: string[] };
      const quotes = cov.quotes.map((id) => allQuotes.get(id)).filter(Boolean) as Quote[];
      const fills = cov.fills.map((id) => allFills.get(id)).filter(Boolean) as Fill[];
      if (quotes.length !== cov.quotes.length || fills.length !== cov.fills.length) {
        bad++; console.log(`FAIL  #${a.seq} — ledger rows missing (${cov.quotes.length - quotes.length} quotes, ${cov.fills.length - fills.length} fills)`); continue;
      }
      localHash = payloadHash(canonicalPayload(quotes, fills));
    } else {
      // settlement anchors hash their own payload at creation; recompute not possible
      // from coverage alone — compare stored hash to on-chain memo only.
      localHash = a.payloadHash;
    }

    if (localHash !== a.payloadHash && a.kind === "activity") {
      bad++; console.log(`FAIL  #${a.seq} — ledger re-hash ${localHash.slice(0, 12)} ≠ stored ${a.payloadHash.slice(0, 12)} (ledger edited!)`);
      continue;
    }

    const tx = await conn.getTransaction(a.txSig, { maxSupportedTransactionVersion: 0 });
    const memoLog = tx?.meta?.logMessages?.find((l) => l.includes("PDESK|v1|"));
    const onChain = memoLog?.match(/PDESK\|v1\|[^|]+\|(\d+)\|([0-9a-f]{64})/);
    if (!onChain) {
      bad++; console.log(`FAIL  #${a.seq} — memo not found on-chain for ${a.txSig.slice(0, 12)}…`);
      continue;
    }
    if (onChain[2] === localHash && Number(onChain[1]) === a.seq) {
      ok++; console.log(`OK    #${a.seq} ${a.kind.padEnd(10)} ${localHash.slice(0, 16)}… == on-chain (${a.txSig.slice(0, 12)}…)`);
    } else {
      bad++; console.log(`FAIL  #${a.seq} — on-chain ${onChain[2].slice(0, 12)} ≠ local ${localHash.slice(0, 12)}`);
    }
  }

  console.log("=".repeat(72));
  console.log(`${ok} verified, ${bad} failed, ${skipped} pending/offline`);
  ledger.close();
  process.exit(bad > 0 ? 1 : 0);
}

main();
