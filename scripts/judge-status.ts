/**
 * judge-status — one-screen readiness report for reviewers.
 * Checks every dependency of the live path and prints PASS/FAIL per item.
 * Read-only: no trades, no transactions.
 */

import fs from "node:fs";
import { CREDENTIALS_PATH, DB_PATH, KEYPAIR_PATH, POLICY_PATH, activeNetwork } from "../src/config.js";
import { RiskGate } from "../src/risk/gate.js";
import { AuthManager } from "../src/txline/auth.js";
import { TxlineRest } from "../src/txline/rest.js";
import { Ledger } from "../src/ledger/db.js";
import { connection, loadOrCreateKeypair } from "../src/solana.js";

const rows: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => rows.push([name, ok, detail]);

async function main(): Promise<void> {
  const net = activeNetwork();
  check("network", true, `${net.network} (${net.apiBaseUrl})`);
  check("node", Number(process.versions.node.split(".")[0]) >= 22, `v${process.versions.node} (need ≥22.5 for node:sqlite)`);

  // risk policy (fail-closed)
  try {
    const gate = new RiskGate(POLICY_PATH);
    check("risk policy", true, `${POLICY_PATH} — unit ${gate.policy.unitSize}, max pos ${gate.policy.maxAbsPositionPerOutcome}`);
  } catch (e) {
    check("risk policy", false, String(e).slice(0, 100));
  }

  // credentials + API
  if (fs.existsSync(CREDENTIALS_PATH)) {
    try {
      const auth = new AuthManager();
      check("credentials", true, `network-bound token present (${CREDENTIALS_PATH})`);
      const rest = new TxlineRest(auth);
      const probe = await rest.probe();
      check("TxLINE API", probe.ok, probe.detail.slice(0, 90));
    } catch (e) {
      check("credentials", false, String(e).slice(0, 100));
    }
  } else {
    check("credentials", false, `missing ${CREDENTIALS_PATH} — run npm run activate`);
  }

  // wallet + chain
  try {
    const kp = loadOrCreateKeypair(KEYPAIR_PATH);
    const bal = await connection().getBalance(kp.publicKey);
    check("desk wallet", bal > 0, `${kp.publicKey.toBase58()} — ${(bal / 1e9).toFixed(4)} SOL`);
  } catch (e) {
    check("desk wallet", false, String(e).slice(0, 100));
  }

  // ledger
  if (fs.existsSync(DB_PATH)) {
    const ledger = new Ledger(DB_PATH);
    check(
      "ledger",
      true,
      `${ledger.frameCount()} recorded frames, ${ledger.settlements().length} settlements, ${(ledger.anchors() as unknown[]).length} anchors`
    );
    ledger.close();
  } else {
    check("ledger", true, "fresh (no session recorded yet)");
  }

  const width = Math.max(...rows.map(([n]) => n.length));
  console.log("\nPROOFDESK JUDGE STATUS\n" + "=".repeat(60));
  for (const [name, ok, detail] of rows) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(width)}  ${detail}`);
  }
  const allOk = rows.every(([, ok]) => ok);
  console.log("=".repeat(60));
  console.log(allOk ? "All checks passed — `npm start` will trade autonomously." : "Some checks failed — see above.");
  process.exit(allOk ? 0 : 1);
}

main();
