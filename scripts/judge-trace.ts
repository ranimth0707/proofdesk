/**
 * judge-trace — a single-screen proof of the decision path, no network, no
 * funds, no credentials. Feeds a synthetic three-minute match through the
 * real Engine (same code as live) and prints every decision the desk makes:
 * calibration, quotes, an adverse fill, a red card repricing, a gate
 * refusal, and a settlement.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../src/engine.js";
import { Ledger } from "../src/ledger/db.js";
import { RiskGate } from "../src/risk/gate.js";
import { Settler } from "../src/settle/settlement.js";
import type { EngineEvent } from "../src/types.js";

// Scratch environment: temp ledger + a strict demo policy.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "proofdesk-trace-"));
const policyPath = path.join(tmp, "policy.json");
fs.writeFileSync(
  policyPath,
  JSON.stringify({
    maxAbsPositionPerOutcome: 2,
    maxGrossExposurePerFixture: 1.2,
    maxDailyFills: 100,
    fillCooldownSec: 0,
    unitSize: 1,
    killSwitchFile: "KILL",
  })
);

const ledger = new Ledger(path.join(tmp, "trace.db"));
const gate = new RiskGate(policyPath);
const settler = new Settler(null, ledger, null);
const engine = new Engine(ledger, gate, settler, null, null, false);
settler.attachBook(engine.book);

engine.bus.on("event", (ev: EngineEvent) => {
  const p = ev.payload as Record<string, unknown>;
  switch (ev.type) {
    case "model":
      console.log(`MODEL      ${p.note} base=${JSON.stringify(p.base)}`);
      break;
    case "quote": {
      const q = p as { outcome: string; bid: number; ask: number; suspended: boolean; reason: string };
      console.log(
        q.suspended
          ? `QUOTE      ${q.outcome.padEnd(4)} SUSPENDED (${q.reason})`
          : `QUOTE      ${q.outcome.padEnd(4)} bid ${(q.bid * 100).toFixed(1)}% / ask ${(q.ask * 100).toFixed(1)}%  [${q.reason}]`
      );
      break;
    }
    case "fill": {
      const f = p as { outcome: string; side: number; price: number };
      console.log(`FILL       ${f.outcome} ${f.side === 1 ? "BUY" : "SELL"} @ ${(f.price * 100).toFixed(1)}%  (consensus crossed our quote)`);
      break;
    }
    case "gate_block":
      console.log(`GATE-BLOCK ${p.outcome ?? ""} policy=${p.policy}: ${p.reason}`);
      break;
    case "settlement": {
      const s = p as { homeGoals: number; awayGoals: number; winner: string; pnl: number; proofStatus: string };
      console.log(
        `SETTLE     final ${s.homeGoals}-${s.awayGoals} (${s.winner}) pnl=${s.pnl.toFixed(3)} proof=${s.proofStatus} (offline trace: proof intentionally unavailable)`
      );
      break;
    }
  }
});

const FID = 999001;
let t = Date.parse("2026-07-19T18:00:00Z");
const odds = (h: number, d: number, a: number, inRunning: boolean) =>
  engine.ingest("odds", t, JSON.stringify({
    FixtureId: FID, MessageId: `m${t}`, Ts: t, Bookmaker: "StablePrice", BookmakerId: 1,
    SuperOddsType: "ML", InRunning: inRunning, PriceNames: ["1", "X", "2"],
    Prices: [0, 0, 0], Pct: [String(h), String(d), String(a)],
  }));
const score = (rec: object) => engine.ingest("scores", t, JSON.stringify({ FixtureId: FID, Ts: t, ...rec }));

console.log("\nPROOFDESK JUDGE TRACE — synthetic match through the real engine");
console.log("=".repeat(70));

console.log("\n-- pre-match: consensus 45.0/28.0/27.0 → model calibration target");
odds(45, 28, 27, false);

console.log("\n-- kickoff (phase H1), first in-play consensus tick");
score({ Action: "phase", Period: 2, Seq: 1 });
odds(45, 28, 27, true);

console.log("\n-- minute ~10: consensus drifts up through our HOME ask → adverse fill");
t += 10 * 60 * 1000;
odds(49.5, 26.5, 24, true);

console.log("\n-- minute ~30: away team red card → model reprices sharply");
t += 20 * 60 * 1000;
score({ Action: "red_card", Participant: 2, Seq: 2, Period: 2 });
odds(52, 26, 22, true);

console.log("\n-- consensus dives through our bids repeatedly → position/exposure caps kick in");
t += 5 * 60 * 1000;
odds(46, 29, 25, true);
t += 60 * 1000;
odds(41, 31, 28, true);
t += 60 * 1000;
odds(36, 33, 31, true);
t += 60 * 1000;
odds(32, 34, 34, true);

console.log("\n-- goal for home, then full time 1-0 → settlement against final stats");
t += 30 * 60 * 1000;
score({ Action: "goal", Participant: 1, Seq: 3, Period: 4, Stats: { "1": 1, "2": 0 } });
odds(88, 9, 3, true);
t += 20 * 60 * 1000;
score({ Action: "game_finalised", StatusId: 100, Period: 100, Seq: 4, Stats: { "1": 1, "2": 0 } });

// settlement is async (proof attempt) — give it a beat, then summarize
setTimeout(() => {
  console.log("\n" + "=".repeat(70));
  const settlements = ledger.settlements();
  const anchors = ledger.anchors() as unknown[];
  console.log(
    `ledger: ${ledger.recentQuotes(1000).length} quotes, ${ledger.recentFills(1000).length} fills, ` +
      `${settlements.length} settlement, ${anchors.length} anchors (0 expected offline), ` +
      `${(ledger.gateBlocks(100) as unknown[]).length} gate refusals`
  );
  console.log("Every row above came out of the same Engine.ingest() path used live. Deterministic: rerun and diff.");
  ledger.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}, 300);
