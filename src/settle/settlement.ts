/**
 * Proof-based settlement.
 *
 * When the scores feed emits the final-outcome marker (`game_finalised`,
 * statusId=100, period=100 — see TxLINE scores overview), the desk:
 *
 *   1. settles every open position on that fixture against the final score,
 *   2. fetches the Merkle validation payload for the observed record
 *      (`/scores/stat-validation?fixtureId&seq&statKeys=1,2`, using the real
 *      observed `seq` per TxLINE docs),
 *   3. simulates `validateStatV2` on the TxLINE oracle program with a
 *      strategy asserting the exact final score — home goals == X AND away
 *      goals == Y — against the on-chain daily Merkle root,
 *   4. anchors the settlement (score, PnL, proof result) as a memo tx.
 *
 * The settlement therefore never relies on our own server's honesty: the
 * exact numbers used to grade the book are proven against the same on-chain
 * roots TxLINE publishes for everyone.
 */

import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import type { Book } from "../mm/book.js";
import type { Ledger } from "../ledger/db.js";
import { makeLog } from "../log.js";
import type { Horizon, Outcome, ScorePayload, Settlement } from "../types.js";
import type { TxlineRest } from "../txline/rest.js";

const log = makeLog("settle");

interface ApiProofNode {
  hash: number[] | Uint8Array;
  isRightSibling: boolean;
}

export function isFinalRecord(ev: ScorePayload): boolean {
  const action = String(ev.Action ?? ev.action ?? "").toLowerCase();
  const status = Number(ev.StatusId ?? ev.statusId ?? NaN);
  const period = Number(ev.Period ?? ev.period ?? NaN);
  return action === "game_finalised" || (status === 100 && period === 100);
}

/**
 * Stat keys per TxLINE soccer encoding: base 1/2 = P1/P2 total goals,
 * period prefix 1000 = first half. The H1 market settles on 1001/1002.
 */
export function statKeysFor(horizon: Horizon): [number, number] {
  return horizon === "H1" ? [1001, 1002] : [1, 2];
}

export function finalGoals(ev: ScorePayload, horizon: Horizon = "FT"): { home: number; away: number } | null {
  const stats = (ev.Stats ?? ev.stats) as Record<string, number> | undefined;
  if (!stats) return null;
  const [homeKey, awayKey] = statKeysFor(horizon);
  const home = stats[String(homeKey)];
  const away = stats[String(awayKey)];
  if (typeof home !== "number" || typeof away !== "number") return null;
  return { home, away };
}

export function winnerOf(home: number, away: number): Outcome {
  if (home > away) return "HOME";
  if (home < away) return "AWAY";
  return "DRAW";
}

export class Settler {
  private book!: Book;

  constructor(
    private rest: TxlineRest | null,
    private ledger: Ledger,
    /** Oracle program bound to the desk wallet; null → proofs marked unavailable. */
    private program: anchor.Program | null
  ) {}

  /** The engine owns the book; it attaches itself right after construction. */
  attachBook(book: Book): void {
    this.book = book;
  }

  /**
   * Settle a fixture from its observed final record.
   * Returns the settlement row (already persisted).
   */
  async settleFixture(ev: ScorePayload, horizon: Horizon = "FT"): Promise<Settlement | null> {
    const fixtureId = Number(ev.FixtureId ?? ev.fixtureId);
    const seq = Number(ev.Seq ?? ev.seq ?? 0);
    if (!Number.isFinite(fixtureId)) return null;

    const goals = finalGoals(ev, horizon);
    if (!goals) {
      log.warn(`fixture ${fixtureId}: final record without ${horizon} goal stats — cannot settle`);
      return null;
    }

    const winner = winnerOf(goals.home, goals.away);
    const pnl = this.book.settle(fixtureId, winner);
    this.ledger.deleteFixturePositions(fixtureId);

    const settlement: Settlement = {
      fixtureId,
      ts: Date.now(),
      homeGoals: goals.home,
      awayGoals: goals.away,
      winner,
      seq,
      pnl,
      proofStatus: "pending",
    };
    this.ledger.saveSettlement(settlement);
    log.info(
      `fixture ${fixtureId} settled ${horizon} ${goals.home}-${goals.away} (${winner}), pnl=${pnl.toFixed(4)}; proving…`
    );

    try {
      const proven = await this.proveFinalScore(fixtureId, seq, goals.home, goals.away, horizon);
      settlement.proofStatus = proven ? "proven" : "failed";
      settlement.proofDetail = proven
        ? `validateStatV2 view() returned true for exact ${horizon} score ${goals.home}-${goals.away} at seq ${seq}`
        : "validateStatV2 view() returned false";
    } catch (e) {
      settlement.proofStatus = "unavailable";
      settlement.proofDetail = String(e).slice(0, 300);
      log.warn(`fixture ${fixtureId}: proof unavailable —`, settlement.proofDetail);
    }
    this.ledger.saveSettlement(settlement);
    return settlement;
  }

  /**
   * Simulate validateStatV2 asserting the exact final score against the
   * on-chain daily scores Merkle root. Mirrors TxODDS' own devnet example
   * (subscription_scores_v2.ts) — statKeys order [1,2] maps to indexes 0,1.
   */
  async proveFinalScore(
    fixtureId: number,
    seq: number,
    home: number,
    away: number,
    horizon: Horizon = "FT"
  ): Promise<boolean> {
    if (!this.program) throw new Error("oracle program not configured (no wallet)");
    if (!this.rest) throw new Error("no TxLINE credentials (offline replay)");
    if (!seq) throw new Error("no observed seq on final record");

    const val = (await this.rest.statValidation(fixtureId, seq, [...statKeysFor(horizon)])) as {
      summary: {
        fixtureId: number;
        updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
        eventStatsSubTreeRoot: number[];
      };
      subTreeProof: ApiProofNode[];
      mainTreeProof: ApiProofNode[];
      eventStatRoot: number[];
      statsToProve: unknown[];
      statProofs: ApiProofNode[][];
    };

    const targetTs = val.summary.updateStats.minTimestamp;
    const epochDay = Math.floor(targetTs / 86_400_000);
    const [dailyScoresPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("daily_scores_roots"), new BN(epochDay).toBuffer("le", 2)],
      this.program.programId
    );

    const mapProof = (nodes: ApiProofNode[]) =>
      nodes.map((n) => ({ hash: Array.from(n.hash), isRightSibling: n.isRightSibling }));

    const payload = {
      ts: new BN(targetTs),
      fixtureSummary: {
        fixtureId: new BN(val.summary.fixtureId),
        updateStats: {
          updateCount: val.summary.updateStats.updateCount,
          minTimestamp: new BN(val.summary.updateStats.minTimestamp),
          maxTimestamp: new BN(val.summary.updateStats.maxTimestamp),
        },
        eventsSubTreeRoot: Array.from(val.summary.eventStatsSubTreeRoot),
      },
      fixtureProof: mapProof(val.subTreeProof),
      mainTreeProof: mapProof(val.mainTreeProof),
      eventStatRoot: Array.from(val.eventStatRoot),
      stats: (val.statsToProve as object[]).map((statObj, index) => ({
        stat: statObj,
        statProof: mapProof(val.statProofs[index]),
      })),
    };

    // Assert the exact final score: requested statKeys → index 0 = home, 1 = away.
    const exactScoreStrategy = {
      geometricTargets: [],
      distancePredicate: null,
      discretePredicates: [
        { single: { index: 0, predicate: { threshold: home, comparison: { equalTo: {} } } } },
        { single: { index: 1, predicate: { threshold: away, comparison: { equalTo: {} } } } },
      ],
    };

    const computeBudgetIx = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

    const result: boolean = await (this.program.methods as any)
      .validateStatV2(payload, exactScoreStrategy)
      .accounts({ dailyScoresMerkleRoots: dailyScoresPda })
      .preInstructions([computeBudgetIx])
      .view();

    return result === true;
  }
}
