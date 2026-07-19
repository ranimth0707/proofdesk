import { test } from "node:test";
import assert from "node:assert/strict";
import { outcomeProbs, pmf, solveLambdas, MAX_GOALS } from "../src/model/poisson.js";
import { InplayModel, PENALTY_CONVERSION } from "../src/model/inplay.js";
import { Phase } from "../src/types.js";

test("pmf sums to ~1 over truncation range", () => {
  let s = 0;
  for (let k = 0; k <= MAX_GOALS; k++) s += pmf(k, 2.5);
  assert.ok(Math.abs(s - 1) < 1e-3);
});

test("outcomeProbs is symmetric under team swap", () => {
  const p = outcomeProbs(1.6, 1.1);
  const q = outcomeProbs(1.1, 1.6);
  assert.ok(Math.abs(p.HOME - q.AWAY) < 1e-12);
  assert.ok(Math.abs(p.DRAW - q.DRAW) < 1e-12);
  const sum = p.HOME + p.DRAW + p.AWAY;
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("solveLambdas round-trips a known triple", () => {
  const target = outcomeProbs(1.7, 1.05);
  const { lambdaHome, lambdaAway } = solveLambdas(target);
  assert.ok(Math.abs(lambdaHome - 1.7) < 0.03, `lh ${lambdaHome}`);
  assert.ok(Math.abs(lambdaAway - 1.05) < 0.03, `la ${lambdaAway}`);
});

test("solveLambdas is deterministic", () => {
  const t = { HOME: 0.45, DRAW: 0.28, AWAY: 0.27 };
  const a = solveLambdas(t);
  const b = solveLambdas(t);
  assert.deepEqual(a, b);
});

test("model: leading team's win probability rises as clock runs down", () => {
  const kickoff = Date.parse("2026-07-19T18:00:00Z");
  const m = new InplayModel(1);
  m.calibrate({ HOME: 0.45, DRAW: 0.28, AWAY: 0.27 });
  m.onScoreEvent({ FixtureId: 1, Ts: kickoff, Period: Phase.H1, Seq: 1 });
  m.onScoreEvent({ FixtureId: 1, Ts: kickoff + 60_000, Action: "goal", Participant: 1, Seq: 2, Stats: { "1": 1, "2": 0 } });
  const early = m.snapshot(kickoff + 5 * 60_000).probs.HOME;
  // advance phases realistically to H2 late
  m.onScoreEvent({ FixtureId: 1, Ts: kickoff + 49 * 60_000, Period: Phase.HT, Seq: 3 });
  m.onScoreEvent({ FixtureId: 1, Ts: kickoff + 64 * 60_000, Period: Phase.H2, Seq: 4 });
  const late = m.snapshot(kickoff + 64 * 60_000 + 44 * 60_000).probs.HOME;
  assert.ok(late > early, `late ${late} should exceed early ${early}`);
  assert.ok(late > 0.9, `1-0 in the 89th minute should be >90%, got ${late}`);
});

test("model: red card for away boosts home win probability", () => {
  const kickoff = Date.parse("2026-07-19T18:00:00Z");
  const mk = () => {
    const m = new InplayModel(2);
    m.calibrate({ HOME: 0.4, DRAW: 0.3, AWAY: 0.3 });
    m.onScoreEvent({ FixtureId: 2, Ts: kickoff, Period: Phase.H1, Seq: 1 });
    return m;
  };
  const base = mk().snapshot(kickoff + 10 * 60_000).probs.HOME;
  const withRed = mk();
  withRed.onScoreEvent({ FixtureId: 2, Ts: kickoff + 9 * 60_000, Action: "red_card", Participant: 2, Seq: 2 });
  const after = withRed.snapshot(kickoff + 10 * 60_000).probs.HOME;
  assert.ok(after > base, `red card should raise HOME prob: ${after} vs ${base}`);
});

test("model: pending penalty mixes with documented conversion rate", () => {
  const kickoff = Date.parse("2026-07-19T18:00:00Z");
  const m = new InplayModel(3);
  m.calibrate({ HOME: 0.4, DRAW: 0.3, AWAY: 0.3 });
  m.onScoreEvent({ FixtureId: 3, Ts: kickoff, Period: Phase.H1, Seq: 1 });
  const before = m.snapshot(kickoff + 20 * 60_000).probs.HOME;
  m.onScoreEvent({ FixtureId: 3, Ts: kickoff + 20 * 60_000, Action: "penalty_awarded", Participant: 1, Seq: 2 });
  const during = m.snapshot(kickoff + 20 * 60_000).probs.HOME;
  assert.ok(during > before, "pending home penalty must raise home prob");
  assert.ok(PENALTY_CONVERSION > 0.7 && PENALTY_CONVERSION < 0.8);
});

test("model: full time collapses to observed result", () => {
  const kickoff = Date.parse("2026-07-19T18:00:00Z");
  const m = new InplayModel(4);
  m.calibrate({ HOME: 0.4, DRAW: 0.3, AWAY: 0.3 });
  m.onScoreEvent({ FixtureId: 4, Ts: kickoff, Period: Phase.H1, Seq: 1 });
  m.onScoreEvent({ FixtureId: 4, Ts: kickoff + 90 * 60_000, Period: Phase.F, Seq: 2, Stats: { "1": 2, "2": 1 } });
  const probs = m.snapshot(kickoff + 91 * 60_000).probs;
  assert.equal(probs.HOME, 1);
  assert.equal(probs.DRAW, 0);
  assert.equal(probs.AWAY, 0);
});
