/**
 * The ProofDesk engine: one event loop, two input streams, no manual input.
 *
 *   odds frame   → consensus tracker → (calibrate model pre-match)
 *                → fill check against standing quotes → requote cycle
 *   scores frame → in-play model state → disruptive-event windows
 *                → final record → settlement + proof + anchor
 *   timer        → anchor tick (commit activity hashes on-chain)
 *
 * The engine is source-agnostic: `ingest()` is called by the live SSE
 * consumer and by the replay engine with identical frames, so live and
 * replay runs exercise exactly the same decision path.
 */

import { EventEmitter } from "node:events";
import { InplayModel } from "./model/inplay.js";
import { computeQuote, shouldRequote } from "./mm/quoter.js";
import { Book } from "./mm/book.js";
import { RiskGate } from "./risk/gate.js";
import { Ledger } from "./ledger/db.js";
import { Settler, isFinalRecord } from "./settle/settlement.js";
import type { Anchorer } from "./anchorlog/anchor.js";
import type { TxlineRest } from "./txline/rest.js";
import { makeLog } from "./log.js";
import {
  OUTCOMES,
  type EngineEvent,
  type FixturePayload,
  type OddsPayload,
  type Outcome,
  type ProbTriple,
  type Quote,
  type ScorePayload,
} from "./types.js";

const log = makeLog("engine");

interface FixtureState {
  fixtureId: number;
  model: InplayModel;
  consensus: ProbTriple | null;
  prematchConsensus: ProbTriple | null;
  standingQuotes: Map<Outcome, Quote>;
  lastDisruptiveEventTs: number;
  name?: string;
  settled: boolean;
}

const DISRUPTIVE_ACTIONS = new Set([
  "goal",
  "red_card",
  "second_yellow",
  "penalty",
  "penalty_awarded",
  "var",
  "var_end",
]);

export class Engine {
  readonly bus = new EventEmitter();
  readonly book = new Book();
  private fixtures = new Map<number, FixtureState>();
  private fixtureMeta = new Map<number, FixturePayload>();
  /** Instance-scoped so identical replays produce identical quote ids. */
  private quoteSeq = 0;

  constructor(
    readonly ledger: Ledger,
    readonly gate: RiskGate,
    readonly settler: Settler,
    readonly anchorer: Anchorer | null,
    readonly rest: TxlineRest | null,
    /** Record raw frames into the ledger (true for live, false for replay). */
    private recordFrames: boolean
  ) {
    // Crash recovery: rebuild the book from persisted positions.
    for (const pos of ledger.positions()) {
      this.book.restore(pos);
    }
  }

  private emit(type: EngineEvent["type"], payload: unknown, ts = Date.now()): void {
    this.bus.emit("event", { type, ts, payload } satisfies EngineEvent);
  }

  /** Load fixture names/metadata for the dashboard (best-effort). */
  async refreshFixtures(): Promise<void> {
    if (!this.rest) return;
    try {
      const fixtures = await this.rest.fixturesSnapshot();
      for (const f of fixtures) this.fixtureMeta.set(f.FixtureId, f);
      log.info(`fixtures snapshot: ${fixtures.length} fixtures known`);
    } catch (e) {
      log.warn("fixtures snapshot failed:", String(e).slice(0, 120));
    }
  }

  fixtureName(fixtureId: number): string {
    const f = this.fixtureMeta.get(fixtureId);
    if (!f) return `fixture ${fixtureId}`;
    const home = f.Participant1IsHome ? f.Participant1 : f.Participant2;
    const away = f.Participant1IsHome ? f.Participant2 : f.Participant1;
    return `${home} vs ${away}`;
  }

  /** Entry point for every frame, live or replayed. */
  ingest(stream: "odds" | "scores", recvTs: number, raw: string): void {
    if (this.recordFrames) this.ledger.recordFrame(recvTs, stream, raw);
    const parsed = safeParse(raw);
    if (!parsed) return;
    const records = Array.isArray(parsed) ? parsed : [parsed];
    for (const rec of records) {
      try {
        if (stream === "odds") this.onOdds(recvTs, rec as OddsPayload);
        else this.onScore(recvTs, rec as ScorePayload);
      } catch (e) {
        log.error(`processing ${stream} record failed:`, e);
      }
    }
  }

  // -- odds path ----------------------------------------------------------

  private onOdds(recvTs: number, odds: OddsPayload): void {
    if (!odds || typeof odds.FixtureId !== "number") return;
    const triple = extract1x2(odds);
    if (!triple) return; // not a full-time 1X2 record, or Pct missing

    const st = this.fixtureState(odds.FixtureId);
    st.consensus = triple;
    this.emit("odds", { fixtureId: odds.FixtureId, triple, inRunning: odds.InRunning, ts: odds.Ts }, recvTs);

    if (!odds.InRunning) {
      // Latest pre-match consensus becomes the calibration target at kickoff.
      st.prematchConsensus = triple;
      return;
    }

    if (!st.model.isCalibrated) {
      const base = st.prematchConsensus ?? triple;
      st.model.calibrate(base);
      this.emit("model", {
        fixtureId: odds.FixtureId,
        note: st.prematchConsensus ? "calibrated_from_prematch" : "calibrated_from_first_inplay",
        base,
      });
    }

    this.quoteCycle(st, recvTs);
  }

  /** Fill check against standing quotes, then requote. */
  private quoteCycle(st: FixtureState, ts: number): void {
    if (st.settled || !st.consensus) return;
    const model = st.model.snapshot(ts);

    for (const outcome of OUTCOMES) {
      const consensusNow = st.consensus[outcome];
      const standing = st.standingQuotes.get(outcome);

      // 1. Did the consensus move through our standing quote? (adverse fill)
      if (standing && !standing.suspended) {
        const side: 1 | -1 | 0 =
          consensusNow >= standing.ask ? -1 : consensusNow <= standing.bid ? 1 : 0;
        if (side !== 0) {
          const decision = this.gate.checkFill(
            this.book,
            st.fixtureId,
            outcome,
            side,
            side === -1 ? standing.ask : standing.bid,
            ts
          );
          if (decision.allowed) {
            const fill = this.book.tryFill(standing, consensusNow, ts, this.gate.policy.unitSize);
            if (fill) {
              this.gate.onFillAccepted(st.fixtureId, outcome, ts);
              this.ledger.saveFill(fill);
              const pos = this.book.position(st.fixtureId, outcome);
              if (pos) this.ledger.savePosition(pos);
              this.emit("fill", { ...fill, fixtureName: this.fixtureName(st.fixtureId) }, ts);
            }
          } else {
            this.ledger.saveGateBlock(ts, st.fixtureId, outcome, decision);
            this.emit("gate_block", { fixtureId: st.fixtureId, outcome, ...decision }, ts);
          }
        }
      }

      // 2. Requote around the fresh model/consensus pair.
      const fresh = computeQuote({
        fixtureId: st.fixtureId,
        outcome,
        ts,
        model,
        consensus: st.consensus,
        lastDisruptiveEventTs: st.lastDisruptiveEventTs,
      });
      fresh.id = `q${++this.quoteSeq}`;
      const gateQ = this.gate.checkQuote(st.fixtureId, model.phase);
      if (!gateQ.allowed) {
        if (!standing?.suspended) {
          const suspendedQuote = { ...fresh, suspended: true, reason: `gate:${gateQ.reason}` };
          st.standingQuotes.set(outcome, suspendedQuote);
          this.ledger.saveQuote(suspendedQuote);
          this.emit("quote", suspendedQuote, ts);
        }
        continue;
      }
      if (shouldRequote(standing, fresh)) {
        st.standingQuotes.set(outcome, fresh);
        this.ledger.saveQuote(fresh);
        this.emit("quote", { ...fresh, fixtureName: this.fixtureName(st.fixtureId) }, ts);
      }
    }
  }

  // -- scores path --------------------------------------------------------

  private onScore(recvTs: number, ev: ScorePayload): void {
    const fixtureId = Number(ev.FixtureId ?? ev.fixtureId);
    if (!Number.isFinite(fixtureId)) return;
    const st = this.fixtureState(fixtureId);

    st.model.onScoreEvent(ev);
    const action = String(ev.Action ?? ev.action ?? "").toLowerCase();
    if (DISRUPTIVE_ACTIONS.has(action)) {
      st.lastDisruptiveEventTs = recvTs;
    }
    this.emit("score", {
      fixtureId,
      fixtureName: this.fixtureName(fixtureId),
      action,
      snapshot: st.model.snapshot(recvTs),
    }, recvTs);

    if (isFinalRecord(ev) && !st.settled) {
      st.settled = true;
      st.standingQuotes.clear();
      void this.finalize(ev, fixtureId);
      return;
    }

    // Score events move the model → refresh quotes immediately.
    this.quoteCycle(st, recvTs);
  }

  private async finalize(ev: ScorePayload, fixtureId: number): Promise<void> {
    const settlement = await this.settler.settleFixture(ev);
    if (!settlement) return;
    if (this.anchorer) {
      const sig = await this.anchorer.anchorSettlement(fixtureId, {
        homeGoals: settlement.homeGoals,
        awayGoals: settlement.awayGoals,
        winner: settlement.winner,
        pnl: settlement.pnl,
        proofStatus: settlement.proofStatus,
      });
      if (sig) {
        settlement.anchorSig = sig;
        this.ledger.saveSettlement(settlement);
      }
    }
    this.emit("settlement", { ...settlement, fixtureName: this.fixtureName(fixtureId) });
  }

  // -- anchoring ----------------------------------------------------------

  async anchorTick(): Promise<void> {
    if (!this.anchorer) return;
    const sig = await this.anchorer.tick();
    if (sig) this.emit("anchor", { sig });
  }

  // -- state for the dashboard -------------------------------------------

  stateSnapshot(): object {
    const fixtures = [...this.fixtures.values()].map((st) => {
      const model = st.model.snapshot(Date.now());
      return {
        fixtureId: st.fixtureId,
        name: this.fixtureName(st.fixtureId),
        consensus: st.consensus,
        model: model.probs,
        phase: model.phase,
        score: `${model.homeGoals}-${model.awayGoals}`,
        ready: model.ready,
        settled: st.settled,
        quotes: [...st.standingQuotes.values()],
        positions: this.book.fixturePositions(st.fixtureId),
        unrealized: st.consensus
          ? this.book.unrealized(st.fixtureId, (o) => st.consensus![o])
          : 0,
      };
    });
    return {
      fixtures,
      positions: this.book.all(),
      settlements: this.ledger.settlements(),
      anchors: this.ledger.anchors(),
      recentFills: this.ledger.recentFills(30),
      gateBlocks: this.ledger.gateBlocks(30),
      killSwitch: this.gate.killSwitchActive(),
    };
  }

  private fixtureState(fixtureId: number): FixtureState {
    let st = this.fixtures.get(fixtureId);
    if (!st) {
      st = {
        fixtureId,
        model: new InplayModel(fixtureId),
        consensus: null,
        prematchConsensus: null,
        standingQuotes: new Map(),
        lastDisruptiveEventTs: 0,
        settled: false,
      };
      this.fixtures.set(fixtureId, st);
    }
    return st;
  }
}

// ---------------------------------------------------------------------------

function safeParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Extract a full-time 1X2 probability triple from an odds record, if this
 * record is one. Detection is by shape, not by hard-coded SuperOddsType:
 * three prices whose names map onto {1,X,2}/{Home,Draw,Away}, with usable
 * Pct values. Records with "NA" percentages or other market shapes are
 * ignored (per TxLINE docs, integrations must branch on the actual payload).
 */
export function extract1x2(odds: OddsPayload): ProbTriple | null {
  const names = odds.PriceNames;
  const pct = odds.Pct;
  if (!names || !pct || names.length !== 3 || pct.length !== 3) return null;
  // Full-time market only: MarketPeriod absent, "FT", "Full Time", "0" all
  // count as full time; explicit half markers are excluded.
  const period = String(odds.MarketPeriod ?? "").toLowerCase();
  if (period && /h1|h2|1st|2nd|half/.test(period)) return null;

  const mapped: Partial<Record<Outcome, number>> = {};
  for (let i = 0; i < 3; i++) {
    const key = normalizeOutcomeName(names[i]);
    if (!key) return null;
    const v = Number.parseFloat(pct[i]);
    if (!Number.isFinite(v)) return null; // "NA"
    mapped[key] = v / 100;
  }
  if (mapped.HOME === undefined || mapped.DRAW === undefined || mapped.AWAY === undefined) return null;
  const sum = mapped.HOME + mapped.DRAW + mapped.AWAY;
  if (sum < 0.9 || sum > 1.1) return null; // not a de-margined 3-way book
  return { HOME: mapped.HOME / sum, DRAW: mapped.DRAW / sum, AWAY: mapped.AWAY / sum };
}

function normalizeOutcomeName(name: string): Outcome | null {
  const n = name.trim().toLowerCase();
  if (n === "1" || n === "home" || n === "p1" || n === "participant1") return "HOME";
  if (n === "x" || n === "draw" || n === "tie") return "DRAW";
  if (n === "2" || n === "away" || n === "p2" || n === "participant2") return "AWAY";
  return null;
}
