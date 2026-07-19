/**
 * In-play pricing model for one fixture.
 *
 * Design goals, in order: deterministic, auditable, defensible.
 * Every adjustment is a named constant with a documented rationale, applied
 * multiplicatively to the remaining Poisson intensities. There is no learned
 * state and no randomness: replaying the same feed frames yields bit-identical
 * probabilities.
 *
 * Inputs (all from TxLINE):
 *  - pre-match StablePrice 1X2 consensus  → base intensities via solveLambdas
 *  - scores feed phases/clock             → remaining-time fraction
 *  - scores feed events                   → red cards, momentum, pending penalties
 *
 * The market priced is full-time 1X2 (90' + stoppage), the convention under
 * which the result market settles; extra time and shootouts do not change it.
 */

import { Phase, type Horizon, type ProbTriple, type ScorePayload } from "../types.js";
import { mixPendingGoal, outcomeProbs, solveLambdas } from "./poisson.js";

// ---------------------------------------------------------------------------
// Model constants. Sources: public football-analytics literature; each value
// is intentionally conservative and bounded so a bad reading cannot run away.
// ---------------------------------------------------------------------------

/** Nominal playing seconds per half (45') plus average stoppage (~4'). */
export const HALF_SECONDS = (45 + 4) * 60;

/** Penalty conversion rate at World Cups hovers around 0.75-0.78. */
export const PENALTY_CONVERSION = 0.76;

/**
 * A red card cuts the short-handed team's scoring intensity and boosts the
 * opponent's. Estimates in the literature put the effect near -30% / +10-15%.
 */
export const RED_CARD_SELF = 0.68;
export const RED_CARD_OPPONENT = 1.12;

/**
 * Momentum: exponentially decayed pressure difference from feed events.
 * Bounded to ±12% so momentum can tilt but never dominate the price.
 */
export const MOMENTUM_MAX_TILT = 0.12;
/** Decay half-life of pressure events, seconds. */
export const MOMENTUM_HALF_LIFE = 300;

/** Event pressure weights (dimensionless), from most to least threatening. */
export const PRESSURE_WEIGHTS: Record<string, number> = {
  shot_on_target: 1.0,
  shot_woodwork: 1.0,
  penalty_awarded: 0, // handled explicitly as a pending goal, not as momentum
  freekick_highdanger: 0.6,
  shot_off_target: 0.4,
  corner: 0.35,
  freekick_danger: 0.3,
  shot_blocked: 0.3,
};

export interface ModelSnapshot {
  probs: ProbTriple;
  horizon: Horizon;
  lambdaHomeRemaining: number;
  lambdaAwayRemaining: number;
  elapsedFrac: number;
  homeGoals: number;
  awayGoals: number;
  redCardsHome: number;
  redCardsAway: number;
  pendingPenalty: "HOME" | "AWAY" | null;
  momentumFactorHome: number;
  momentumFactorAway: number;
  phase: Phase;
  /** True once the model has pre-match intensities and can price. */
  ready: boolean;
}

interface PressureState {
  /** Decayed pressure score at `ts`. */
  value: number;
  ts: number;
}

export class InplayModel {
  readonly fixtureId: number;

  private lambdaHome0 = 0;
  private lambdaAway0 = 0;
  private calibrated = false;
  /** Market horizon the calibration triple refers to (FT or first half). */
  private horizon: Horizon = "FT";

  private phase: Phase = Phase.NS;
  private phaseStartTs = 0;
  /** Playing seconds elapsed at the moment the current phase started. */
  private elapsedAtPhaseStart = 0;

  private homeGoals = 0;
  private awayGoals = 0;
  /** First-half goals, frozen when the match leaves H1 (for the H1 market). */
  private h1HomeGoals = 0;
  private h1AwayGoals = 0;
  private h1Frozen = false;
  private redHome = 0;
  private redAway = 0;
  private pendingPenalty: "HOME" | "AWAY" | null = null;

  private pressureHome: PressureState = { value: 0, ts: 0 };
  private pressureAway: PressureState = { value: 0, ts: 0 };

  constructor(fixtureId: number) {
    this.fixtureId = fixtureId;
  }

  /**
   * Calibrate base intensities from the last pre-kickoff StablePrice triple.
   * Called once; later consensus updates are used for quoting, never to
   * re-fit the model (the model must stay an independent opinion).
   *
   * The solved intensities are *horizon-total*: calibrating on the FT triple
   * yields whole-match lambdas, calibrating on the first-half triple yields
   * first-half lambdas. All in-play decay is then computed relative to that
   * same horizon, so no cross-horizon scaling constant is needed.
   */
  calibrate(prematch: ProbTriple, horizon: Horizon = "FT"): void {
    if (this.calibrated) return;
    const { lambdaHome, lambdaAway } = solveLambdas(prematch);
    this.lambdaHome0 = lambdaHome;
    this.lambdaAway0 = lambdaAway;
    this.horizon = horizon;
    this.calibrated = true;
  }

  get marketHorizon(): Horizon {
    return this.horizon;
  }

  get isCalibrated(): boolean {
    return this.calibrated;
  }

  /** Feed one scores-stream record into the model state. */
  onScoreEvent(ev: ScorePayload): void {
    const ts = num(ev.Ts ?? ev.ts) ?? Date.now();
    const action = String(ev.Action ?? ev.action ?? "").toLowerCase();
    const data = (ev.Data ?? ev.data ?? {}) as Record<string, unknown>;
    const participant = participantSide(ev);

    // Phase transitions --------------------------------------------------
    const phase = phaseOf(ev);
    if (phase !== null && phase !== this.phase) {
      this.elapsedAtPhaseStart = this.elapsedPlayingSeconds(ts);
      // Leaving the first half freezes the H1 score for the H1 market.
      if (this.phase <= Phase.H1 && phase >= Phase.HT && !this.h1Frozen) {
        this.h1HomeGoals = this.homeGoals;
        this.h1AwayGoals = this.awayGoals;
        this.h1Frozen = true;
      }
      this.phase = phase;
      this.phaseStartTs = ts;
    }

    // Score --------------------------------------------------------------
    const stats = (ev.Stats ?? ev.stats) as Record<string, number> | undefined;
    if (stats) {
      // Stat keys per TxLINE soccer encoding: 1 = P1 total goals, 2 = P2.
      if (typeof stats["1"] === "number") this.homeGoals = stats["1"];
      if (typeof stats["2"] === "number") this.awayGoals = stats["2"];
      if (typeof stats["5"] === "number") this.redHome = stats["5"];
      if (typeof stats["6"] === "number") this.redAway = stats["6"];
      // Period-prefixed H1 goal keys (1000 + base) are authoritative when sent.
      if (typeof stats["1001"] === "number") { this.h1HomeGoals = stats["1001"]; this.h1Frozen = this.h1Frozen || this.phase >= Phase.HT; }
      if (typeof stats["1002"] === "number") { this.h1AwayGoals = stats["1002"]; this.h1Frozen = this.h1Frozen || this.phase >= Phase.HT; }
    }
    if (action === "goal") {
      // Stats on the record are authoritative; increment only as a fallback
      // for goal records that carry no running totals.
      if (!stats && participant) {
        if (participant === "HOME") this.homeGoals += 1;
        else this.awayGoals += 1;
      }
      this.pendingPenalty = null; // a goal resolves any pending penalty state
    }

    // Cards --------------------------------------------------------------
    if ((action === "red_card" || action === "second_yellow") && participant) {
      if (participant === "HOME") this.redHome += stats ? 0 : 1;
      else this.redAway += stats ? 0 : 1;
    }

    // Penalty lifecycle --------------------------------------------------
    if (action === "penalty" || action === "penalty_awarded") {
      this.pendingPenalty = participant;
    }
    if (action === "penalty_missed" || (action === "penalty" && data["Outcome"] === "Missed")) {
      this.pendingPenalty = null;
    }

    // Momentum-relevant events -------------------------------------------
    const weight = pressureWeight(action, data);
    if (weight > 0 && participant) {
      const state = participant === "HOME" ? this.pressureHome : this.pressureAway;
      const decayed = decay(state.value, ts - state.ts);
      state.value = decayed + weight;
      state.ts = ts;
    }
  }

  /**
   * Playing seconds elapsed toward the 90'+stoppage horizon at wall time ts.
   * Clock is derived from phase transitions, so it survives feed gaps.
   */
  private elapsedPlayingSeconds(ts: number): number {
    switch (this.phase) {
      case Phase.NS:
        return 0;
      case Phase.H1: {
        const inPhase = Math.max(0, (ts - this.phaseStartTs) / 1000);
        return Math.min(HALF_SECONDS, inPhase);
      }
      case Phase.HT:
        return HALF_SECONDS;
      case Phase.H2: {
        const inPhase = Math.max(0, (ts - this.phaseStartTs) / 1000);
        return HALF_SECONDS + Math.min(HALF_SECONDS, inPhase);
      }
      default:
        // F and beyond: the full-time market horizon is exhausted.
        return 2 * HALF_SECONDS;
    }
  }

  /** Current model output. Deterministic in (state, ts). */
  snapshot(ts: number): ModelSnapshot {
    const elapsed = this.elapsedPlayingSeconds(ts);
    // Elapsed fraction is relative to the market horizon: the whole match for
    // FT, the first half only for the H1 market (whose lambdas are H1-total).
    const horizonSeconds = this.horizon === "H1" ? HALF_SECONDS : 2 * HALF_SECONDS;
    const frac = Math.min(1, elapsed / horizonSeconds);
    const remaining = 1 - frac;

    // Red-card multipliers (compound if multiple reds).
    const redSelfHome = Math.pow(RED_CARD_SELF, this.redHome);
    const redOppHome = Math.pow(RED_CARD_OPPONENT, this.redAway);
    const redSelfAway = Math.pow(RED_CARD_SELF, this.redAway);
    const redOppAway = Math.pow(RED_CARD_OPPONENT, this.redHome);

    // Momentum tilt from decayed pressure difference.
    const pHome = decay(this.pressureHome.value, ts - this.pressureHome.ts);
    const pAway = decay(this.pressureAway.value, ts - this.pressureAway.ts);
    const tilt = MOMENTUM_MAX_TILT * Math.tanh((pHome - pAway) / 3);
    const momHome = 1 + tilt;
    const momAway = 1 - tilt;

    const lh = this.lambdaHome0 * remaining * redSelfHome * redOppHome * momHome;
    const la = this.lambdaAway0 * remaining * redSelfAway * redOppAway * momAway;

    // The H1 market's horizon ends at halftime; FT's at full time.
    const horizonExhausted =
      this.horizon === "H1"
        ? this.phase >= Phase.HT && this.phase !== Phase.TXCS
        : this.phase >= Phase.F && this.phase !== Phase.TXCS;
    const scoreHome = this.horizon === "H1" && this.h1Frozen ? this.h1HomeGoals : this.homeGoals;
    const scoreAway = this.horizon === "H1" && this.h1Frozen ? this.h1AwayGoals : this.awayGoals;

    let probs: ProbTriple;
    if (!this.calibrated) {
      probs = { HOME: 1 / 3, DRAW: 1 / 3, AWAY: 1 / 3 };
    } else if (horizonExhausted) {
      // Market horizon passed: collapse to the observed result.
      probs = {
        HOME: scoreHome > scoreAway ? 1 : 0,
        DRAW: scoreHome === scoreAway ? 1 : 0,
        AWAY: scoreHome < scoreAway ? 1 : 0,
      };
    } else {
      probs = outcomeProbs(lh, la, scoreHome, scoreAway);
      if (this.pendingPenalty) {
        const withGoal =
          this.pendingPenalty === "HOME"
            ? outcomeProbs(lh, la, scoreHome + 1, scoreAway)
            : outcomeProbs(lh, la, scoreHome, scoreAway + 1);
        probs = mixPendingGoal(withGoal, probs, PENALTY_CONVERSION);
      }
    }

    return {
      probs,
      horizon: this.horizon,
      lambdaHomeRemaining: lh,
      lambdaAwayRemaining: la,
      elapsedFrac: frac,
      homeGoals: this.homeGoals,
      awayGoals: this.awayGoals,
      redCardsHome: this.redHome,
      redCardsAway: this.redAway,
      pendingPenalty: this.pendingPenalty,
      momentumFactorHome: momHome,
      momentumFactorAway: momAway,
      phase: this.phase,
      ready: this.calibrated,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decay(value: number, dtMs: number): number {
  if (dtMs <= 0) return value;
  return value * Math.pow(0.5, dtMs / 1000 / MOMENTUM_HALF_LIFE);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Map a scores record's participant field to HOME/AWAY (P1 is feed-home). */
function participantSide(ev: ScorePayload): "HOME" | "AWAY" | null {
  const p = ev.Participant ?? (ev as Record<string, unknown>)["participant"];
  if (p === 1 || p === "1" || p === "Participant1" || p === "P1" || p === "Home") return "HOME";
  if (p === 2 || p === "2" || p === "Participant2" || p === "P2" || p === "Away") return "AWAY";
  return null;
}

const PHASE_NAMES: Record<string, Phase> = {
  ns: Phase.NS, scheduled: Phase.NS, h1: Phase.H1, ht: Phase.HT, h2: Phase.H2,
  f: Phase.F, ft: Phase.F, finished: Phase.F, wet: Phase.WET, et1: Phase.ET1,
  htet: Phase.HTET, et2: Phase.ET2, fet: Phase.FET, wpe: Phase.WPE, pe: Phase.PE,
  fpe: Phase.FPE, i: Phase.I, interrupted: Phase.I, a: Phase.A, abandoned: Phase.A,
  c: Phase.C, cancelled: Phase.C, txcc: Phase.TXCC, txcs: Phase.TXCS, p: Phase.P,
  postponed: Phase.P,
};

function phaseOf(ev: ScorePayload): Phase | null {
  const raw =
    ev.Period ?? ev.period ?? ev.GameState ?? ev.gameState ?? (ev as Record<string, unknown>)["Phase"];
  if (typeof raw === "string" && PHASE_NAMES[raw.trim().toLowerCase()] !== undefined) {
    return PHASE_NAMES[raw.trim().toLowerCase()];
  }
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n)) return null;
  if (n >= 1 && n <= 19) return n as Phase;
  return null;
}

function pressureWeight(action: string, data: Record<string, unknown>): number {
  switch (action) {
    case "shot": {
      const outcome = String(data["Outcome"] ?? "");
      if (outcome === "OnTarget") return PRESSURE_WEIGHTS.shot_on_target;
      if (outcome === "Woodwork") return PRESSURE_WEIGHTS.shot_woodwork;
      if (outcome === "Blocked") return PRESSURE_WEIGHTS.shot_blocked;
      return PRESSURE_WEIGHTS.shot_off_target;
    }
    case "corner":
      return PRESSURE_WEIGHTS.corner;
    case "free_kick": {
      const kind = String(data["FreeKickType"] ?? "");
      if (kind === "HighDanger") return PRESSURE_WEIGHTS.freekick_highdanger;
      if (kind === "Danger") return PRESSURE_WEIGHTS.freekick_danger;
      return 0;
    }
    default:
      return 0;
  }
}
