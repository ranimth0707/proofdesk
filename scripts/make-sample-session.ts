/**
 * make-sample-session — synthesize a realistic recorded session so that
 * `npm run replay` works out of the box, with no credentials and no live
 * match. The generator is fully deterministic (seeded PRNG): rebuilding the
 * file produces byte-identical frames.
 *
 * Story of the synthetic fixture (id 18170001, "Azuria vs Crimsonia"):
 *   0'   kickoff at 44/29/27
 *   23'  home goal (shots pressure building beforehand)
 *   HT   1-0
 *   61'  away red card — consensus lags the event by ~45s, the desk's model
 *        reprices instantly off the scores feed (this is the edge the desk
 *        demonstrates)
 *   78'  home goal (2-0)
 *   FT   game_finalised 2-0, statusId=100, period=100
 *
 * Consensus odds follow events with a deliberate 30-60s lag and small noise;
 * the scores feed carries the events instantly — mirroring the real relation
 * between TxLINE's scout feed and the StablePrice consensus.
 */

import fs from "node:fs";
import path from "node:path";
import { Ledger } from "../src/ledger/db.js";
import { DATA_DIR } from "../src/config.js";

const OUT = process.argv[2] ?? path.join(DATA_DIR, "sample-session.db");
if (fs.existsSync(OUT)) fs.rmSync(OUT);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const ledger = new Ledger(OUT);

// Deterministic PRNG (mulberry32) — same seed, same session.
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(42);

const FID = 18170001;
const kickoff = Date.parse("2026-07-19T19:00:00Z");
let seq = 0;

const oddsFrame = (t: number, h: number, d: number, a: number, inRunning: boolean) =>
  ledger.recordFrame(t, "odds", JSON.stringify({
    FixtureId: FID, MessageId: `sim-${t}`, Ts: t, Bookmaker: "StablePrice", BookmakerId: 1,
    SuperOddsType: "ML", InRunning: inRunning, MarketPeriod: "",
    PriceNames: ["1", "X", "2"],
    Prices: [Math.round(100000 / h), Math.round(100000 / d), Math.round(100000 / a)],
    Pct: [h.toFixed(3), d.toFixed(3), a.toFixed(3)],
  }));

const scoreFrame = (t: number, rec: object) =>
  ledger.recordFrame(t, "scores", JSON.stringify({ FixtureId: FID, Ts: t, Seq: ++seq, ...rec }));

// A piecewise consensus path: [minute, H, D, A] targets; interpolated with noise.
const anchorsPath: [number, number, number, number][] = [
  [-10, 44, 29, 27],
  [0, 44, 29, 27],
  [10, 45.5, 28.6, 25.9],
  [22.9, 47, 28, 25],
  [24, 63, 22, 15],    // goal 23' priced in within ~60s
  [45, 66, 21.5, 12.5],
  [61.6, 66, 21.5, 12.5], // red card 61' — consensus still stale…
  [63, 74, 17.5, 8.5],    // …then reprices with ~60-90s lag
  [77.9, 77, 16.5, 6.5],
  [79, 91.5, 7, 1.5],   // second goal 78'
  [90, 97.5, 2.2, 0.3],
];
function consensusAt(minute: number): [number, number, number] {
  for (let i = 1; i < anchorsPath.length; i++) {
    if (minute <= anchorsPath[i][0]) {
      const [m0, h0, d0, a0] = anchorsPath[i - 1];
      const [m1, h1, d1, a1] = anchorsPath[i];
      const f = m1 === m0 ? 1 : (minute - m0) / (m1 - m0);
      return [h0 + f * (h1 - h0), d0 + f * (d1 - d0), a0 + f * (a1 - a0)];
    }
  }
  const last = anchorsPath[anchorsPath.length - 1];
  return [last[1], last[2], last[3]];
}

// Pre-match: a few ticks in the hour before kickoff.
for (let m = -60; m < 0; m += 12) {
  const [h, d, a] = consensusAt(-10);
  oddsFrame(kickoff + m * 60_000, h + rnd() * 0.4 - 0.2, d + rnd() * 0.3 - 0.15, a + rnd() * 0.3 - 0.15, false);
}

// Kickoff.
scoreFrame(kickoff, { Action: "phase", Period: 2 });

// Scripted match events: [minute, frame factory]
type Ev = [number, () => void];
const events: Ev[] = [
  [4, () => scoreFrame(at(4), { Action: "free_kick", Participant: 1, Period: 2, Data: { FreeKickType: "Danger" } })],
  [9, () => scoreFrame(at(9), { Action: "corner", Participant: 1, Period: 2 })],
  [14, () => scoreFrame(at(14), { Action: "shot", Participant: 1, Period: 2, Data: { Outcome: "OnTarget" } })],
  [18, () => scoreFrame(at(18), { Action: "shot", Participant: 1, Period: 2, Data: { Outcome: "Woodwork" } })],
  [21, () => scoreFrame(at(21), { Action: "corner", Participant: 1, Period: 2 })],
  [23, () => scoreFrame(at(23), { Action: "goal", Participant: 1, Period: 2, Stats: { "1": 1, "2": 0 } })],
  [31, () => scoreFrame(at(31), { Action: "shot", Participant: 2, Period: 2, Data: { Outcome: "OffTarget" } })],
  [38, () => scoreFrame(at(38), { Action: "free_kick", Participant: 2, Period: 2, Data: { FreeKickType: "HighDanger" } })],
  [45, () => scoreFrame(at(45), { Action: "phase", Period: 3, Stats: { "1": 1, "2": 0 } })],
  [46, () => scoreFrame(at(46), { Action: "halftime_finalised", Period: 3 })],
  [61, () => scoreFrame(at(61), { Action: "phase", Period: 4 })], // H2 starts (compressed HT)
  [61.5, () => scoreFrame(at(61.5), { Action: "red_card", Participant: 2, Period: 4, Stats: { "5": 0, "6": 1 } })],
  [67, () => scoreFrame(at(67), { Action: "shot", Participant: 1, Period: 4, Data: { Outcome: "OnTarget" } })],
  [72, () => scoreFrame(at(72), { Action: "corner", Participant: 1, Period: 4 })],
  [78, () => scoreFrame(at(78), { Action: "goal", Participant: 1, Period: 4, Stats: { "1": 2, "2": 0 } })],
  [90, () => scoreFrame(at(90), { Action: "phase", Period: 5, Stats: { "1": 2, "2": 0 } })],
  [92, () => scoreFrame(at(92), { Action: "game_finalised", StatusId: 100, Period: 100, Stats: { "1": 2, "2": 0 } })],
];
const at = (minute: number) => kickoff + minute * 60_000;

// Interleave odds ticks (every ~40s ±10s) with scripted events, in time order.
let nextEvent = 0;
for (let t = kickoff; t <= at(92); t += (30 + rnd() * 20) * 1000) {
  while (nextEvent < events.length && at(events[nextEvent][0]) <= t) {
    events[nextEvent][1]();
    nextEvent++;
  }
  const minute = (t - kickoff) / 60_000;
  if (minute > 45 && minute < 61) continue; // halftime: no in-play odds ticks
  const [h, d, a] = consensusAt(minute);
  const jitter = () => rnd() * 0.5 - 0.25;
  const H = Math.max(0.2, h + jitter()), D = Math.max(0.2, d + jitter()), A = Math.max(0.2, a + jitter());
  oddsFrame(t, H, D, A, true);
}
while (nextEvent < events.length) { events[nextEvent][1](); nextEvent++; }

ledger.setMeta("session", "sample");
console.log(`sample session written to ${OUT}: ${ledger.frameCount()} frames`);
ledger.close();
