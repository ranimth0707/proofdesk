/**
 * ProofDesk entry point.
 *
 *   tsx src/main.ts live                 — trade on the live TxLINE feed
 *   tsx src/main.ts replay [--speed 20] [--source data/sample-session.db]
 *                                        — re-run a recorded session through
 *                                          the identical decision path
 *
 * Once started, no human input is required or possible: the process runs
 * feed → model → quote → gate → ledger → anchor → settle autonomously.
 */

import path from "node:path";
import {
  ANCHOR_INTERVAL_MS,
  DASHBOARD_PORT,
  DB_PATH,
  KEYPAIR_PATH,
  POLICY_PATH,
  activeNetwork,
} from "./config.js";
import { Ledger } from "./ledger/db.js";
import { RiskGate } from "./risk/gate.js";
import { AuthManager } from "./txline/auth.js";
import { TxlineRest } from "./txline/rest.js";
import { openStream } from "./txline/stream.js";
import { Engine } from "./engine.js";
import { Settler } from "./settle/settlement.js";
import { Anchorer } from "./anchorlog/anchor.js";
import { connection, loadOrCreateKeypair, oracleProgram } from "./solana.js";
import { startDashboard } from "./dashboard/server.js";
import { replay } from "./replay/replayer.js";
import { makeLog } from "./log.js";

const log = makeLog("main");

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "live";
  const args = process.argv.slice(3);
  const net = activeNetwork();
  log.info(`ProofDesk starting — mode=${mode} network=${net.network}`);

  const gate = new RiskGate(POLICY_PATH); // fail-closed: throws without a policy
  log.info("risk policy loaded:", JSON.stringify(gate.policy));

  if (mode === "live") {
    const auth = new AuthManager();
    const rest = new TxlineRest(auth);
    const ledger = new Ledger(DB_PATH);
    const session = `s${Date.now().toString(36)}`;
    ledger.setMeta("session", session);

    // Solana side (best-effort: the desk trades even if the chain is down).
    let anchorer: Anchorer | null = null;
    let settler: Settler;
    try {
      const kp = loadOrCreateKeypair(KEYPAIR_PATH);
      const conn = connection();
      const program = oracleProgram(kp, conn);
      anchorer = new Anchorer(ledger, conn, kp, session);
      settler = new Settler(rest, ledger, program);
      log.info("desk wallet:", kp.publicKey.toBase58());
    } catch (e) {
      log.warn("Solana wiring unavailable (anchoring/proofs disabled):", String(e).slice(0, 120));
      settler = new Settler(rest, ledger, null);
    }

    const engine = new Engine(ledger, gate, settler, anchorer, rest, true);
    settler.attachBook(engine.book);

    await engine.refreshFixtures();
    setInterval(() => void engine.refreshFixtures(), 30 * 60 * 1000);

    startDashboard(engine, DASHBOARD_PORT);

    const probe = await rest.probe();
    log.info(`API probe: ${probe.ok ? "OK" : "FAILED"} — ${probe.detail}`);

    const odds = openStream(auth, "odds", (ts, raw) => engine.ingest("odds", ts, raw));
    const scores = openStream(auth, "scores", (ts, raw) => engine.ingest("scores", ts, raw));

    setInterval(() => void engine.anchorTick(), ANCHOR_INTERVAL_MS);

    const shutdown = () => {
      log.info("shutting down");
      odds.close();
      scores.close();
      ledger.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    log.info("live engine running — no further input required");
    return;
  }

  if (mode === "replay") {
    const speed = numArg(args, "--speed") ?? 20;
    const source = strArg(args, "--source") ?? path.join(path.dirname(DB_PATH), "sample-session.db");
    const sourceLedger = new Ledger(source);
    // Replay writes decisions to a scratch ledger so reruns stay pristine.
    const scratch = strArg(args, "--out") ?? path.join(path.dirname(DB_PATH), `replay-${Date.now()}.db`);
    const ledger = new Ledger(scratch);
    const session = `replay${Date.now().toString(36)}`;

    // Replay is offline-first: no REST, no chain. Proof calls are marked
    // unavailable unless credentials + wallet exist (then they run live).
    let rest: TxlineRest | null = null;
    let anchorer: Anchorer | null = null;
    let program = null;
    try {
      const auth = new AuthManager();
      rest = new TxlineRest(auth);
      const kp = loadOrCreateKeypair(KEYPAIR_PATH);
      const conn = connection();
      program = oracleProgram(kp, conn);
      anchorer = new Anchorer(ledger, conn, kp, session);
    } catch {
      log.info("replay running fully offline (no credentials/wallet found) — fine for judging");
    }

    const settler = new Settler(rest, ledger, program);
    const engine = new Engine(ledger, gate, settler, anchorer, rest, false);
    settler.attachBook(engine.book);

    startDashboard(engine, DASHBOARD_PORT);
    log.info(`replay dashboard up — source=${source} speed=${speed}x`);
    await replay(sourceLedger, engine, { speed, maxGapMs: 4000 });
    log.info("replay finished; dashboard stays up (Ctrl-C to exit)");
    return;
  }

  throw new Error(`unknown mode "${mode}" — use live or replay`);
}

function numArg(args: string[], flag: string): number | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : undefined;
}
function strArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

main().catch((e) => {
  log.error(e);
  process.exit(1);
});
