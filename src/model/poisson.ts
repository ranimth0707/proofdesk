/**
 * Poisson machinery for match-outcome pricing.
 *
 * The model: goals scored by each team over the remaining match time follow
 * independent Poisson processes with intensities λ_home, λ_away. The full-time
 * 1X2 probability is the sum over all remaining-score combinations added to
 * the current score. This is the standard baseline model of football analytics
 * (Maher 1982; Dixon & Coles 1997 refine it — we keep independence for
 * transparency and determinism, and note the known ~1-2% draw underestimate).
 *
 * Everything here is a pure function: same input, same output, no randomness.
 */

import type { ProbTriple } from "../types.js";

/** Truncation for score sums. P(X > 12) with λ ≤ 6 is < 1e-3 — negligible. */
export const MAX_GOALS = 12;

/** Poisson probability mass function P(X = k) for intensity lambda. */
export function pmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  // Iterative product avoids factorial overflow and stays exact enough for k ≤ 12.
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p = (p * lambda) / i;
  return p;
}

/**
 * Full-time outcome probabilities given remaining intensities and the current
 * score. Sums P(home adds i) * P(away adds j) over the truncated grid.
 */
export function outcomeProbs(
  lambdaHome: number,
  lambdaAway: number,
  currentHome = 0,
  currentAway = 0
): ProbTriple {
  const ph: number[] = [];
  const pa: number[] = [];
  for (let k = 0; k <= MAX_GOALS; k++) {
    ph.push(pmf(k, lambdaHome));
    pa.push(pmf(k, lambdaAway));
  }
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = ph[i] * pa[j];
      const finalHome = currentHome + i;
      const finalAway = currentAway + j;
      if (finalHome > finalAway) home += p;
      else if (finalHome === finalAway) draw += p;
      else away += p;
    }
  }
  // Renormalise the truncation remainder (< 1e-3) so the triple sums to 1.
  const total = home + draw + away;
  return { HOME: home / total, DRAW: draw / total, AWAY: away / total };
}

/**
 * Invert a pre-match 1X2 probability triple into full-match Poisson
 * intensities (λ_home, λ_away).
 *
 * Deterministic two-stage grid search minimising squared error against the
 * target triple: a coarse 0.05 grid over [0.05, 5.0], then a fine 0.005 grid
 * ±0.06 around the coarse optimum. No randomness, no iteration-order
 * sensitivity; the same consensus triple always produces the same intensities.
 */
export function solveLambdas(target: ProbTriple): {
  lambdaHome: number;
  lambdaAway: number;
  fitError: number;
} {
  const sq = (x: number) => x * x;
  const err = (lh: number, la: number): number => {
    const p = outcomeProbs(lh, la);
    return sq(p.HOME - target.HOME) + sq(p.DRAW - target.DRAW) + sq(p.AWAY - target.AWAY);
  };

  let best = { lh: 1.3, la: 1.1, e: Number.POSITIVE_INFINITY };
  for (let lh = 0.05; lh <= 5.0; lh += 0.05) {
    for (let la = 0.05; la <= 5.0; la += 0.05) {
      const e = err(lh, la);
      if (e < best.e) best = { lh, la, e };
    }
  }
  const coarse = best;
  for (let lh = coarse.lh - 0.06; lh <= coarse.lh + 0.06; lh += 0.005) {
    if (lh <= 0) continue;
    for (let la = coarse.la - 0.06; la <= coarse.la + 0.06; la += 0.005) {
      if (la <= 0) continue;
      const e = err(lh, la);
      if (e < best.e) best = { lh, la, e };
    }
  }
  return {
    lambdaHome: Number(best.lh.toFixed(3)),
    lambdaAway: Number(best.la.toFixed(3)),
    fitError: best.e,
  };
}

/**
 * Mix an outcome distribution with the same distribution shifted by one
 * pending goal for one side. Used for an awarded-but-untaken penalty:
 * result = pConvert * P(score+1) + (1-pConvert) * P(score).
 */
export function mixPendingGoal(
  withGoal: ProbTriple,
  withoutGoal: ProbTriple,
  pConvert: number
): ProbTriple {
  const w = Math.min(Math.max(pConvert, 0), 1);
  return {
    HOME: w * withGoal.HOME + (1 - w) * withoutGoal.HOME,
    DRAW: w * withGoal.DRAW + (1 - w) * withoutGoal.DRAW,
    AWAY: w * withGoal.AWAY + (1 - w) * withoutGoal.AWAY,
  };
}
