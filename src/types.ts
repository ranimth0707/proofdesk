/**
 * Domain types shared across the ProofDesk engine.
 *
 * Naming follows the TxLINE wire schema (PascalCase fields) for payloads
 * that come off the feed, and camelCase for everything we derive.
 */

/** One odds record from /api/odds/* or the odds SSE stream. */
export interface OddsPayload {
  FixtureId: number;
  MessageId: string;
  Ts: number;
  Bookmaker: string;
  BookmakerId: number;
  SuperOddsType: string;
  GameState?: string;
  InRunning: boolean;
  MarketParameters?: string;
  MarketPeriod?: string;
  PriceNames?: string[];
  Prices?: number[];
  /** Implied probabilities, de-margined by StablePrice. Strings "52.632" or "NA". */
  Pct?: string[];
}

/** One scores record from /api/scores/* or the scores SSE stream. */
export interface ScorePayload {
  FixtureId?: number;
  fixtureId?: number;
  Seq?: number;
  seq?: number;
  Ts?: number;
  ts?: number;
  Action?: string;
  action?: string;
  Participant?: string | number;
  StatusId?: number;
  statusId?: number;
  Period?: number;
  period?: number;
  GameState?: string | number;
  gameState?: string | number;
  Stats?: Record<string, number>;
  stats?: Record<string, number>;
  Data?: Record<string, unknown>;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Fixture metadata from /api/fixtures/snapshot. */
export interface FixturePayload {
  FixtureId: number;
  Participant1: string;
  Participant2: string;
  Participant1IsHome: boolean;
  StartTime: number | string;
  CompetitionId?: number;
  Competition?: string;
  GameState?: number;
  [k: string]: unknown;
}

/** The three outcomes of the full-time 1X2 market. */
export type Outcome = "HOME" | "DRAW" | "AWAY";
export const OUTCOMES: Outcome[] = ["HOME", "DRAW", "AWAY"];

/** Probability triple over 1X2, always sums to ~1. */
export interface ProbTriple {
  HOME: number;
  DRAW: number;
  AWAY: number;
}

/** Soccer game phases, per TxLINE soccer feed encoding. */
export enum Phase {
  NS = 1,
  H1 = 2,
  HT = 3,
  H2 = 4,
  F = 5,
  WET = 6,
  ET1 = 7,
  HTET = 8,
  ET2 = 9,
  FET = 10,
  WPE = 11,
  PE = 12,
  FPE = 13,
  I = 14,
  A = 15,
  C = 16,
  TXCC = 17,
  TXCS = 18,
  P = 19,
}

/** A two-sided quote on one binary outcome contract (prices in probability space, 0..1). */
export interface Quote {
  id: string;
  ts: number;
  fixtureId: number;
  outcome: Outcome;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  modelProb: number;
  consensusProb: number;
  /** Why the spread is what it is — audit trail for judges and ops. */
  reason: string;
  suspended: boolean;
}

/** A simulated fill against our quote (adverse flow: consensus moved through us). */
export interface Fill {
  id: string;
  ts: number;
  fixtureId: number;
  outcome: Outcome;
  /** +1 we bought (paid bid-side), -1 we sold (received ask-side). */
  side: 1 | -1;
  price: number;
  qty: number;
  quoteId: string;
  consensusProb: number;
}

/** Net position per (fixture, outcome). */
export interface Position {
  fixtureId: number;
  outcome: Outcome;
  qty: number;
  avgPrice: number;
  realizedPnl: number;
}

/** Result of settling one fixture from a game_finalised record. */
export interface Settlement {
  fixtureId: number;
  ts: number;
  homeGoals: number;
  awayGoals: number;
  winner: Outcome;
  seq: number;
  pnl: number;
  /** Devnet validateStatV2 simulation outcome. */
  proofStatus: "pending" | "proven" | "failed" | "unavailable";
  proofDetail?: string;
  anchorSig?: string;
}

/** Risk gate decision — every quote/fill proposal passes through this. */
export interface GateDecision {
  allowed: boolean;
  policy: string;
  reason: string;
}

/** Envelope recorded for every raw stream frame (basis of the replay engine). */
export interface RecordedFrame {
  seq: number;
  /** Wall-clock ms when we received the frame. */
  recvTs: number;
  stream: "odds" | "scores";
  data: string;
}

export interface EngineEvent {
  type:
    | "odds"
    | "score"
    | "quote"
    | "fill"
    | "settlement"
    | "anchor"
    | "gate_block"
    | "model"
    | "status";
  ts: number;
  payload: unknown;
}
