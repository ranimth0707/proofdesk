/**
 * Position book with adverse-flow fill simulation.
 *
 * Fill rule: our standing quote is only taken when the consensus price moves
 * through it. If consensus rises to/above our ask, an informed buyer lifted
 * us before we could reprice (we are short). If it falls to/below our bid, we
 * were hit (we are long). This is the *worst-case* flow assumption — every
 * fill is against informed movement — so the PnL this book reports is a lower
 * bound, not a cherry-picked simulation.
 *
 * Prices are probabilities of binary contracts settling at 0 or 1:
 *   pnl_settlement = qty · (settle − avgPrice), settle ∈ {0, 1}.
 */

import type { Fill, Outcome, Position, Quote } from "../types.js";

export class Book {
  /** key: `${fixtureId}:${outcome}` */
  private positions = new Map<string, Position>();
  /** Instance-scoped so identical replays produce identical fill ids. */
  private fillSeq = 0;

  /**
   * Check a consensus move against a standing quote; return the fill if the
   * move crossed the quote. Caller is responsible for gate checks and for
   * requoting after a fill.
   */
  tryFill(quote: Quote, consensusNow: number, ts: number, qty: number): Fill | null {
    if (quote.suspended || qty <= 0) return null;

    let side: 1 | -1;
    let price: number;
    if (consensusNow >= quote.ask) {
      side = -1; // lifted: we sold at the ask
      price = quote.ask;
    } else if (consensusNow <= quote.bid) {
      side = 1; // hit: we bought at the bid
      price = quote.bid;
    } else {
      return null;
    }

    const fill: Fill = {
      id: `f${++this.fillSeq}`,
      ts,
      fixtureId: quote.fixtureId,
      outcome: quote.outcome,
      side,
      price,
      qty,
      quoteId: quote.id,
      consensusProb: consensusNow,
    };
    this.apply(fill);
    return fill;
  }

  /** Apply a fill to the position book (average-price accounting). */
  apply(fill: Fill): Position {
    const key = `${fill.fixtureId}:${fill.outcome}`;
    const pos =
      this.positions.get(key) ??
      ({ fixtureId: fill.fixtureId, outcome: fill.outcome, qty: 0, avgPrice: 0, realizedPnl: 0 } as Position);

    const signedQty = fill.side * fill.qty;
    if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(signedQty)) {
      // extending the position: weighted average entry
      const newQty = pos.qty + signedQty;
      pos.avgPrice = (pos.avgPrice * Math.abs(pos.qty) + fill.price * Math.abs(signedQty)) / Math.abs(newQty);
      pos.qty = newQty;
    } else {
      // reducing / flipping: realize PnL on the closed portion
      const closing = Math.min(Math.abs(pos.qty), Math.abs(signedQty)) * Math.sign(pos.qty);
      pos.realizedPnl += closing * (fill.price - pos.avgPrice);
      pos.qty += signedQty;
      if (pos.qty !== 0 && Math.sign(pos.qty) === Math.sign(signedQty)) pos.avgPrice = fill.price;
      if (pos.qty === 0) pos.avgPrice = 0;
    }

    this.positions.set(key, pos);
    return pos;
  }

  position(fixtureId: number, outcome: Outcome): Position | undefined {
    return this.positions.get(`${fixtureId}:${outcome}`);
  }

  fixturePositions(fixtureId: number): Position[] {
    return [...this.positions.values()].filter((p) => p.fixtureId === fixtureId);
  }

  all(): Position[] {
    return [...this.positions.values()];
  }

  /** Gross exposure for a fixture: Σ |qty·avgPrice| (capital at risk). */
  grossExposure(fixtureId: number): number {
    return this.fixturePositions(fixtureId).reduce((s, p) => s + Math.abs(p.qty * p.avgPrice), 0);
  }

  /** Mark-to-consensus unrealized PnL for a fixture. */
  unrealized(fixtureId: number, consensus: (o: Outcome) => number): number {
    return this.fixturePositions(fixtureId).reduce(
      (s, p) => s + p.qty * (consensus(p.outcome) - p.avgPrice),
      0
    );
  }

  /**
   * Settle every position of a fixture against the final outcome.
   * Returns total settlement PnL and clears the positions.
   */
  settle(fixtureId: number, winner: Outcome): number {
    let pnl = 0;
    for (const p of this.fixturePositions(fixtureId)) {
      const settleValue = p.outcome === winner ? 1 : 0;
      pnl += p.qty * (settleValue - p.avgPrice) + p.realizedPnl;
      this.positions.delete(`${p.fixtureId}:${p.outcome}`);
    }
    return pnl;
  }

  /** Restore a position from the ledger on restart. */
  restore(pos: Position): void {
    this.positions.set(`${pos.fixtureId}:${pos.outcome}`, { ...pos });
  }
}
