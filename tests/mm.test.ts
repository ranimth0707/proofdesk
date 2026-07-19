import { test } from "node:test";
import assert from "node:assert/strict";
import { computeQuote, BASE_SPREAD, SUSPEND_DIVERGENCE } from "../src/mm/quoter.js";
import { Book } from "../src/mm/book.js";
import type { ModelSnapshot } from "../src/model/inplay.js";
import { Phase, type Quote } from "../src/types.js";

const model = (h: number, d: number, a: number, phase = Phase.H1): ModelSnapshot => ({
  probs: { HOME: h, DRAW: d, AWAY: a },
  horizon: "FT",
  lambdaHomeRemaining: 1, lambdaAwayRemaining: 1, elapsedFrac: 0.3,
  homeGoals: 0, awayGoals: 0, redCardsHome: 0, redCardsAway: 0,
  pendingPenalty: null, momentumFactorHome: 1, momentumFactorAway: 1,
  phase, ready: true,
});

test("quote: agreement → tight spread; divergence → wider spread", () => {
  const base = { fixtureId: 1, outcome: "HOME" as const, ts: 1_000_000, lastDisruptiveEventTs: 0 };
  const agree = computeQuote({ ...base, model: model(0.5, 0.25, 0.25), consensus: { HOME: 0.5, DRAW: 0.25, AWAY: 0.25 } });
  const diverge = computeQuote({ ...base, model: model(0.55, 0.23, 0.22), consensus: { HOME: 0.5, DRAW: 0.26, AWAY: 0.24 } });
  assert.ok(Math.abs(agree.spread - BASE_SPREAD) < 1e-9);
  assert.ok(diverge.spread > agree.spread);
  assert.ok(!agree.suspended);
});

test("quote: event window widens spread", () => {
  const base = { fixtureId: 1, outcome: "HOME" as const, model: model(0.5, 0.25, 0.25), consensus: { HOME: 0.5, DRAW: 0.25, AWAY: 0.25 } };
  const calm = computeQuote({ ...base, ts: 1_000_000, lastDisruptiveEventTs: 0 });
  const hot = computeQuote({ ...base, ts: 1_000_000, lastDisruptiveEventTs: 990_000 });
  assert.ok(hot.spread > calm.spread);
});

test("quote: toxic divergence suspends", () => {
  const q = computeQuote({
    fixtureId: 1, outcome: "HOME", ts: 1000, lastDisruptiveEventTs: 0,
    model: model(0.7, 0.15, 0.15),
    consensus: { HOME: 0.7 - SUSPEND_DIVERGENCE - 0.02, DRAW: 0.2, AWAY: 0.12 + SUSPEND_DIVERGENCE - 0.06 },
  });
  assert.ok(q.suspended);
});

test("quote: non-playing phase suspends", () => {
  const q = computeQuote({
    fixtureId: 1, outcome: "HOME", ts: 1000, lastDisruptiveEventTs: 0,
    model: model(0.5, 0.25, 0.25, Phase.F), consensus: { HOME: 0.5, DRAW: 0.25, AWAY: 0.25 },
  });
  assert.ok(q.suspended);
});

const quote = (bid: number, ask: number): Quote => ({
  id: "q1", ts: 0, fixtureId: 7, outcome: "HOME", bid, ask, mid: (bid + ask) / 2,
  spread: ask - bid, modelProb: 0.5, consensusProb: 0.5, reason: "", suspended: false,
});

test("book: consensus through ask → short; settlement pays correctly", () => {
  const book = new Book();
  const fill = book.tryFill(quote(0.48, 0.52), 0.53, 1000, 1);
  assert.ok(fill && fill.side === -1 && fill.price === 0.52);
  // HOME loses → short settles at 0 → profit = entry price
  const pnl = book.settle(7, "AWAY");
  assert.ok(Math.abs(pnl - 0.52) < 1e-9, `pnl ${pnl}`);
});

test("book: consensus through bid → long; winning settlement pays 1-entry", () => {
  const book = new Book();
  const fill = book.tryFill(quote(0.48, 0.52), 0.47, 1000, 2);
  assert.ok(fill && fill.side === 1 && fill.price === 0.48);
  const pnl = book.settle(7, "HOME");
  assert.ok(Math.abs(pnl - 2 * (1 - 0.48)) < 1e-9, `pnl ${pnl}`);
});

test("book: no fill when consensus stays inside the spread", () => {
  const book = new Book();
  assert.equal(book.tryFill(quote(0.48, 0.52), 0.5, 1000, 1), null);
});

test("book: reducing fills realize pnl at average price", () => {
  const book = new Book();
  book.apply({ id: "a", ts: 1, fixtureId: 7, outcome: "HOME", side: 1, price: 0.4, qty: 2, quoteId: "q", consensusProb: 0.4 });
  book.apply({ id: "b", ts: 2, fixtureId: 7, outcome: "HOME", side: -1, price: 0.5, qty: 1, quoteId: "q", consensusProb: 0.5 });
  const pos = book.position(7, "HOME")!;
  assert.equal(pos.qty, 1);
  assert.ok(Math.abs(pos.realizedPnl - 0.1) < 1e-9);
});
