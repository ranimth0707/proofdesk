import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MissingPolicyConfigError, RiskGate } from "../src/risk/gate.js";
import { Book } from "../src/mm/book.js";
import { Ledger } from "../src/ledger/db.js";
import { Engine, extract1x2 } from "../src/engine.js";
import { Settler, isFinalRecord, winnerOf } from "../src/settle/settlement.js";
import { canonicalPayload, payloadHash } from "../src/anchorlog/anchor.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "proofdesk-test-"));

const writePolicy = (dir: string, overrides: object = {}) => {
  const p = path.join(dir, "policy.json");
  fs.writeFileSync(
    p,
    JSON.stringify({
      maxAbsPositionPerOutcome: 2,
      maxGrossExposurePerFixture: 10,
      maxDailyFills: 5,
      fillCooldownSec: 0,
      unitSize: 1,
      killSwitchFile: "KILL",
      ...overrides,
    })
  );
  return p;
};

test("gate: refuses to construct without a policy file (fail-closed)", () => {
  assert.throws(() => new RiskGate(path.join(tmpDir(), "missing.json")), MissingPolicyConfigError);
});

test("gate: refuses to construct with an incomplete policy", () => {
  const dir = tmpDir();
  const p = path.join(dir, "policy.json");
  fs.writeFileSync(p, JSON.stringify({ maxAbsPositionPerOutcome: 2 }));
  assert.throws(() => new RiskGate(p), MissingPolicyConfigError);
});

test("gate: position limit blocks the third unit", () => {
  const dir = tmpDir();
  const gate = new RiskGate(writePolicy(dir));
  const book = new Book();
  for (let i = 0; i < 2; i++) {
    const d = gate.checkFill(book, 1, "HOME", 1, 0.5, 1000 + i);
    assert.ok(d.allowed, d.reason);
    book.apply({ id: `f${i}`, ts: 1000 + i, fixtureId: 1, outcome: "HOME", side: 1, price: 0.5, qty: 1, quoteId: "q", consensusProb: 0.5 });
    gate.onFillAccepted(1, "HOME", 1000 + i);
  }
  const d3 = gate.checkFill(book, 1, "HOME", 1, 0.5, 2000);
  assert.ok(!d3.allowed);
  assert.equal(d3.policy, "position-limit");
});

test("gate: kill switch halts everything", () => {
  const dir = tmpDir();
  const gate = new RiskGate(writePolicy(dir));
  fs.writeFileSync(path.join(dir, "KILL"), "");
  const d = gate.checkFill(new Book(), 1, "HOME", 1, 0.5, 1000);
  assert.ok(!d.allowed);
  assert.equal(d.policy, "kill-switch");
});

test("extract1x2: parses StablePrice Pct and classifies market horizon", () => {
  const good = extract1x2({
    FixtureId: 1, MessageId: "m", Ts: 1, Bookmaker: "StablePrice", BookmakerId: 1,
    SuperOddsType: "ML", InRunning: true,
    PriceNames: ["1", "X", "2"], Prices: [1900, 3400, 4100], Pct: ["45.000", "28.000", "27.000"],
  });
  assert.ok(good);
  assert.equal(good!.horizon, "FT");
  assert.ok(Math.abs(good!.triple.HOME - 0.45) < 1e-9);

  // Real devnet demo-feed shape: part1/draw/part2 names, first-half market.
  const h1 = extract1x2({
    FixtureId: 1, MessageId: "m", Ts: 1, Bookmaker: "TXLineStablePriceDemargined", BookmakerId: 10021,
    SuperOddsType: "1X2_PARTICIPANT_RESULT", InRunning: false, MarketPeriod: "half=1",
    PriceNames: ["part1", "draw", "part2"], Prices: [3330, 2037, 4792], Pct: ["30.030", "49.092", "20.868"],
  });
  assert.ok(h1);
  assert.equal(h1!.horizon, "H1");
  assert.ok(Math.abs(h1!.triple.HOME - 0.3003) < 1e-3);

  const na = extract1x2({
    FixtureId: 1, MessageId: "m", Ts: 1, Bookmaker: "B", BookmakerId: 1,
    SuperOddsType: "AH", InRunning: true,
    PriceNames: ["1", "2"], Prices: [1900, 1900], Pct: ["50.000", "50.000"],
  } as never);
  assert.equal(na, null);

  // Second-half market: observed but not traded.
  const h2 = extract1x2({
    FixtureId: 1, MessageId: "m", Ts: 1, Bookmaker: "B", BookmakerId: 1,
    SuperOddsType: "1X2_PARTICIPANT_RESULT", InRunning: true, MarketPeriod: "half=2",
    PriceNames: ["part1", "draw", "part2"], Prices: [0, 0, 0], Pct: ["50.000", "30.000", "20.000"],
  });
  assert.equal(h2, null);
});

test("engine trades the H1 market when that is what the feed publishes", async () => {
  const dir = tmpDir();
  const ledger = new Ledger(path.join(dir, "h1.db"));
  const gate = new RiskGate(writePolicy(dir));
  const settler = new Settler(null, ledger, null);
  const engine = new Engine(ledger, gate, settler, null, null, false);
  settler.attachBook(engine.book);

  let t = Date.parse("2026-07-19T19:00:00Z");
  const odds = (h: number, d: number, a: number, inRunning: boolean) =>
    engine.ingest("odds", t, JSON.stringify({
      FixtureId: 9, MessageId: `m${t}`, Ts: t, Bookmaker: "TXLineStablePriceDemargined", BookmakerId: 10021,
      SuperOddsType: "1X2_PARTICIPANT_RESULT", InRunning: inRunning, MarketPeriod: "half=1",
      PriceNames: ["part1", "draw", "part2"], Prices: [0, 0, 0],
      Pct: [h.toFixed(3), d.toFixed(3), a.toFixed(3)],
    }));

  odds(30, 49, 21, false);                      // pre-match H1 triple (draw-heavy — typical for H1)
  engine.ingest("scores", t, JSON.stringify({ FixtureId: 9, Ts: t, Period: 2, Seq: 1 }));
  odds(30, 49, 21, true);                       // locks the H1 market + calibrates
  t += 10 * 60_000;
  odds(38, 44, 18, true);                       // move → possible fill
  t += 40 * 60_000;                             // halftime: H1 market decided 1-0
  engine.ingest("scores", t, JSON.stringify({ FixtureId: 9, Ts: t, Action: "goal", Participant: 1, Period: 2, Seq: 2, Stats: { "1": 1, "2": 0 } }));
  engine.ingest("scores", t, JSON.stringify({ FixtureId: 9, Ts: t, Period: 3, Seq: 3 }));
  t += 60 * 60_000;
  engine.ingest("scores", t, JSON.stringify({
    FixtureId: 9, Ts: t, Action: "game_finalised", StatusId: 100, Period: 100, Seq: 9,
    Stats: { "1": 2, "2": 2, "1001": 1, "1002": 0 },   // FT 2-2 but H1 was 1-0
  }));

  await new Promise((r) => setTimeout(r, 150));
  const quotes = ledger.recentQuotes(100);
  assert.ok(quotes.length > 0, "H1 market produced quotes");
  const s = ledger.settlements()[0] as { winner: string; homeGoals: number; awayGoals: number };
  assert.equal(s.winner, "HOME", "H1 market settles on the 1001/1002 keys (1-0), not the FT 2-2");
  assert.equal(s.homeGoals, 1);
  assert.equal(s.awayGoals, 0);
  ledger.close();
});

test("engine: end-to-end synthetic match produces quotes, fill, settlement; deterministic", async () => {
  const run = () => {
    const dir = tmpDir();
    const ledger = new Ledger(path.join(dir, "t.db"));
    const gate = new RiskGate(writePolicy(dir));
    const settler = new Settler(null, ledger, null);
    const engine = new Engine(ledger, gate, settler, null, null, false);
    settler.attachBook(engine.book);

    let t = Date.parse("2026-07-19T18:00:00Z");
    const odds = (h: number, d: number, a: number, inRunning: boolean) =>
      engine.ingest("odds", t, JSON.stringify({
        FixtureId: 5, MessageId: `m${t}`, Ts: t, Bookmaker: "StablePrice", BookmakerId: 1,
        SuperOddsType: "ML", InRunning: inRunning,
        PriceNames: ["1", "X", "2"], Prices: [0, 0, 0],
        Pct: [h.toFixed(3), d.toFixed(3), a.toFixed(3)],
      }));

    odds(45, 28, 27, false);
    engine.ingest("scores", t, JSON.stringify({ FixtureId: 5, Ts: t, Period: 2, Seq: 1 }));
    odds(45, 28, 27, true);
    t += 10 * 60_000;
    odds(52, 25, 23, true); // big move → crosses standing ask
    t += 80 * 60_000;
    engine.ingest("scores", t, JSON.stringify({
      FixtureId: 5, Ts: t, Action: "game_finalised", StatusId: 100, Period: 100, Seq: 9, Stats: { "1": 1, "2": 0 },
    }));

    return new Promise<{ fills: number; quotes: number; settlement: unknown; hash: string }>((resolve) => {
      setTimeout(() => {
        const fills = ledger.recentFills(100);
        const quotes = ledger.recentQuotes(1000);
        const activity = ledger.unanchoredActivity();
        const hash = payloadHash(canonicalPayload(activity.quotes, activity.fills));
        const out = {
          fills: fills.length,
          quotes: quotes.length,
          settlement: ledger.settlements()[0],
          hash,
        };
        ledger.close();
        resolve(out);
      }, 200);
    });
  };

  const a = await run();
  const b = await run();
  assert.ok(a.quotes > 0, "quotes were posted");
  assert.ok(a.fills > 0, "the 45→52 move filled a standing quote");
  const s = a.settlement as { winner: string; proofStatus: string; pnl: number };
  assert.equal(s.winner, "HOME");
  assert.equal(s.proofStatus, "unavailable"); // offline: no program/rest wired
  // Determinism: identical frames → identical canonical activity hash.
  assert.equal(a.hash, b.hash);
  assert.equal(a.fills, b.fills);
  assert.equal(a.quotes, b.quotes);
});

test("settlement helpers: final record detection and winner mapping", () => {
  assert.ok(isFinalRecord({ Action: "game_finalised" }));
  assert.ok(isFinalRecord({ statusId: 100, period: 100 }));
  assert.ok(!isFinalRecord({ Action: "goal", statusId: 4, period: 4 }));
  assert.equal(winnerOf(2, 1), "HOME");
  assert.equal(winnerOf(1, 1), "DRAW");
  assert.equal(winnerOf(0, 3), "AWAY");
});
