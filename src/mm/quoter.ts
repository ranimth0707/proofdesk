/**
 * Quoting engine: turns (model probability, consensus probability, match
 * state) into a two-sided quote per outcome, in probability space.
 *
 * Pricing rules (all constants documented, all deterministic):
 *
 *   mid    = w·model + (1-w)·consensus            (w = MODEL_WEIGHT)
 *   spread = BASE_SPREAD
 *          + K_DIVERGENCE · |model − consensus|   (disagreement is risk)
 *          + EVENT_SPREAD if inside an event window (goal/red/VAR/pen recent)
 *   bid    = mid − spread/2,  ask = mid + spread/2, clamped to [0.01, 0.99]
 *
 * Protection rules (when a real desk would pull quotes, we pull quotes):
 *   - divergence > SUSPEND_DIVERGENCE          → suspend (toxic flow risk:
 *     the market knows something our model does not, or vice versa)
 *   - phase not in {H1, HT, H2} or not in-play  → suspend
 *   - model not calibrated                      → suspend
 *   - near-certain prices (mid outside bounds)  → suspend (no edge left)
 */

import type { ModelSnapshot } from "../model/inplay.js";
import { Phase, type Outcome, type ProbTriple, type Quote } from "../types.js";

export const MODEL_WEIGHT = 0.6;
export const BASE_SPREAD = 0.015;
export const K_DIVERGENCE = 0.5;
export const EVENT_SPREAD = 0.02;
/** Seconds after a disruptive event during which spreads stay widened. */
export const EVENT_WINDOW_SECONDS = 60;
export const SUSPEND_DIVERGENCE = 0.12;
export const MAX_SPREAD = 0.08;
export const MIN_PRICE = 0.01;
export const MAX_PRICE = 0.99;
/** Only requote when the mid moved by at least this much. */
export const REQUOTE_THRESHOLD = 0.002;

const QUOTABLE_PHASES = new Set<Phase>([Phase.H1, Phase.HT, Phase.H2]);

export interface QuoteInputs {
  fixtureId: number;
  outcome: Outcome;
  ts: number;
  model: ModelSnapshot;
  consensus: ProbTriple;
  /** Wall-clock ms of the last disruptive event (goal, red card, VAR, penalty). */
  lastDisruptiveEventTs: number;
}

/**
 * Compute the quote for one outcome. Pure given its inputs — the caller
 * (Engine) assigns the sequential id so replays are bit-identical.
 */
export function computeQuote(inp: QuoteInputs): Quote {
  const m = inp.model.probs[inp.outcome];
  const c = inp.consensus[inp.outcome];
  const divergence = Math.abs(m - c);

  const inEventWindow = inp.ts - inp.lastDisruptiveEventTs < EVENT_WINDOW_SECONDS * 1000;

  let spread = BASE_SPREAD + K_DIVERGENCE * divergence + (inEventWindow ? EVENT_SPREAD : 0);
  spread = Math.min(spread, MAX_SPREAD);

  const mid = clamp(MODEL_WEIGHT * m + (1 - MODEL_WEIGHT) * c, MIN_PRICE, MAX_PRICE);
  const bid = clamp(mid - spread / 2, MIN_PRICE, MAX_PRICE);
  const ask = clamp(mid + spread / 2, MIN_PRICE, MAX_PRICE);

  let suspended = false;
  const reasons: string[] = [];

  if (!inp.model.ready) {
    suspended = true;
    reasons.push("model_not_calibrated");
  }
  if (!QUOTABLE_PHASES.has(inp.model.phase)) {
    suspended = true;
    reasons.push(`phase_${Phase[inp.model.phase] ?? inp.model.phase}_not_quotable`);
  }
  if (divergence > SUSPEND_DIVERGENCE) {
    suspended = true;
    reasons.push(`divergence_${divergence.toFixed(3)}_exceeds_${SUSPEND_DIVERGENCE}`);
  }
  if (mid <= MIN_PRICE + 0.005 || mid >= MAX_PRICE - 0.005) {
    suspended = true;
    reasons.push("price_near_certainty");
  }
  if (!suspended) {
    reasons.push(
      `base=${BASE_SPREAD}`,
      `div=${divergence.toFixed(3)}x${K_DIVERGENCE}`,
      inEventWindow ? `event_window+${EVENT_SPREAD}` : "no_event_window"
    );
  }

  return {
    id: "",
    ts: inp.ts,
    fixtureId: inp.fixtureId,
    outcome: inp.outcome,
    bid,
    ask,
    mid,
    spread: ask - bid,
    modelProb: m,
    consensusProb: c,
    reason: reasons.join(","),
    suspended,
  };
}

/** Whether a fresh quote differs enough from the standing one to replace it. */
export function shouldRequote(standing: Quote | undefined, fresh: Quote): boolean {
  if (!standing) return true;
  if (standing.suspended !== fresh.suspended) return true;
  return Math.abs(standing.mid - fresh.mid) >= REQUOTE_THRESHOLD;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
