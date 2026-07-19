/**
 * Fail-closed risk gate.
 *
 * Every value-affecting proposal (posting a quote, accepting a fill) passes
 * through `check*` before it reaches the book or the ledger. The gate is
 * fail-closed in the Aegis sense:
 *
 *   - No policy file           → constructor throws. The engine will not
 *     start without explicit limits.
 *   - Missing/invalid limit    → throws at load, not at trade time.
 *   - Kill-switch file present → every proposal is refused.
 *
 * There is no bypass flag anywhere in the codebase; the only way to trade
 * bigger is to edit the policy file and restart.
 */

import fs from "node:fs";
import path from "node:path";
import { Phase, type GateDecision, type Outcome } from "../types.js";
import type { Book } from "../mm/book.js";

export interface PolicyConfig {
  /** Max |position| per (fixture, outcome), in contracts. */
  maxAbsPositionPerOutcome: number;
  /** Max Σ|qty·price| capital at risk per fixture. */
  maxGrossExposurePerFixture: number;
  /** Max fills accepted per UTC day across all fixtures. */
  maxDailyFills: number;
  /** Minimum seconds between fills on the same (fixture, outcome). */
  fillCooldownSec: number;
  /** Contracts per fill. */
  unitSize: number;
  /** Path (relative to policy file) whose existence halts all trading. */
  killSwitchFile: string;
}

const REQUIRED_KEYS: (keyof PolicyConfig)[] = [
  "maxAbsPositionPerOutcome",
  "maxGrossExposurePerFixture",
  "maxDailyFills",
  "fillCooldownSec",
  "unitSize",
  "killSwitchFile",
];

export class MissingPolicyConfigError extends Error {}

export class RiskGate {
  readonly policy: PolicyConfig;
  private readonly killSwitchPath: string;
  private fillsToday = 0;
  private fillsDay = "";
  private lastFillTs = new Map<string, number>();

  constructor(policyPath: string) {
    if (!fs.existsSync(policyPath)) {
      throw new MissingPolicyConfigError(
        `Risk policy file not found at ${policyPath}. ProofDesk is fail-closed: ` +
          `it refuses to run without explicit limits. Copy policy.example.json and edit it.`
      );
    }
    const raw = JSON.parse(fs.readFileSync(policyPath, "utf8")) as Partial<PolicyConfig>;
    for (const key of REQUIRED_KEYS) {
      if (raw[key] === undefined || raw[key] === null) {
        throw new MissingPolicyConfigError(`Risk policy missing required key "${key}" in ${policyPath}`);
      }
    }
    const numeric: (keyof PolicyConfig)[] = REQUIRED_KEYS.filter((k) => k !== "killSwitchFile");
    for (const key of numeric) {
      const v = raw[key];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        throw new MissingPolicyConfigError(`Risk policy key "${key}" must be a non-negative number`);
      }
    }
    this.policy = raw as PolicyConfig;
    this.killSwitchPath = path.resolve(path.dirname(policyPath), this.policy.killSwitchFile);
  }

  /** A quote may be posted: only sanity + kill-switch (quotes carry no risk until filled). */
  checkQuote(fixtureId: number, phase: Phase): GateDecision {
    if (this.killSwitchActive()) return deny("kill-switch", `kill-switch file present: ${this.killSwitchPath}`);
    if (
      phase === Phase.I ||
      phase === Phase.A ||
      phase === Phase.C ||
      phase === Phase.TXCC ||
      phase === Phase.TXCS ||
      phase === Phase.P
    ) {
      return deny("phase-suspension", `phase ${Phase[phase]} forbids quoting on fixture ${fixtureId}`);
    }
    return allow("quote-sanity");
  }

  /** A fill may be accepted onto the book. */
  checkFill(
    book: Book,
    fixtureId: number,
    outcome: Outcome,
    side: 1 | -1,
    price: number,
    ts: number
  ): GateDecision {
    if (this.killSwitchActive()) return deny("kill-switch", `kill-switch file present: ${this.killSwitchPath}`);

    const day = new Date(ts).toISOString().slice(0, 10);
    if (day !== this.fillsDay) {
      this.fillsDay = day;
      this.fillsToday = 0;
    }
    if (this.fillsToday >= this.policy.maxDailyFills) {
      return deny("daily-fill-cap", `daily fill cap ${this.policy.maxDailyFills} reached`);
    }

    const key = `${fixtureId}:${outcome}`;
    const last = this.lastFillTs.get(key) ?? 0;
    const sinceSec = (ts - last) / 1000;
    if (sinceSec < this.policy.fillCooldownSec) {
      return deny(
        "fill-cooldown",
        `cooldown: ${sinceSec.toFixed(1)}s since last fill < ${this.policy.fillCooldownSec}s`
      );
    }

    const pos = book.position(fixtureId, outcome);
    const nextQty = (pos?.qty ?? 0) + side * this.policy.unitSize;
    if (Math.abs(nextQty) > this.policy.maxAbsPositionPerOutcome) {
      return deny(
        "position-limit",
        `|position| would be ${Math.abs(nextQty)} > ${this.policy.maxAbsPositionPerOutcome} on ${key}`
      );
    }

    const gross = book.grossExposure(fixtureId) + this.policy.unitSize * price;
    if (gross > this.policy.maxGrossExposurePerFixture) {
      return deny(
        "exposure-limit",
        `gross exposure would be ${gross.toFixed(2)} > ${this.policy.maxGrossExposurePerFixture} on fixture ${fixtureId}`
      );
    }

    return allow("fill-limits");
  }

  /** Record an accepted fill so cooldowns and caps advance. */
  onFillAccepted(fixtureId: number, outcome: Outcome, ts: number): void {
    this.fillsToday += 1;
    this.lastFillTs.set(`${fixtureId}:${outcome}`, ts);
  }

  killSwitchActive(): boolean {
    return fs.existsSync(this.killSwitchPath);
  }
}

function allow(policy: string): GateDecision {
  return { allowed: true, policy, reason: "ok" };
}
function deny(policy: string, reason: string): GateDecision {
  return { allowed: false, policy, reason };
}
