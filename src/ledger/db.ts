/**
 * Ledger: append-only SQLite persistence for everything the desk does.
 *
 * Uses node:sqlite (built into Node ≥ 22.5) — zero native dependencies.
 *
 * The ledger is the source of truth for:
 *   - the anchoring pipeline (rows are hashed and committed to Solana),
 *   - crash recovery (positions are rebuilt on restart),
 *   - the replay engine (raw stream frames are recorded verbatim),
 *   - the dashboard and judge-trace scripts.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type {
  Fill,
  GateDecision,
  Position,
  Quote,
  RecordedFrame,
  Settlement,
} from "../types.js";

export class Ledger {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS frames (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        recv_ts INTEGER NOT NULL,
        stream TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quotes (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        fixture_id INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        bid REAL, ask REAL, mid REAL, spread REAL,
        model_prob REAL, consensus_prob REAL,
        reason TEXT, suspended INTEGER NOT NULL,
        anchored_seq INTEGER
      );
      CREATE TABLE IF NOT EXISTS fills (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        fixture_id INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        side INTEGER NOT NULL,
        price REAL NOT NULL,
        qty REAL NOT NULL,
        quote_id TEXT,
        consensus_prob REAL,
        anchored_seq INTEGER
      );
      CREATE TABLE IF NOT EXISTS positions (
        fixture_id INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        qty REAL NOT NULL,
        avg_price REAL NOT NULL,
        realized_pnl REAL NOT NULL,
        PRIMARY KEY (fixture_id, outcome)
      );
      CREATE TABLE IF NOT EXISTS settlements (
        fixture_id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        home_goals INTEGER, away_goals INTEGER,
        winner TEXT, seq INTEGER,
        pnl REAL,
        proof_status TEXT NOT NULL DEFAULT 'pending',
        proof_detail TEXT,
        anchor_sig TEXT
      );
      CREATE TABLE IF NOT EXISTS anchors (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        coverage TEXT NOT NULL,
        tx_sig TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS gate_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        fixture_id INTEGER,
        outcome TEXT,
        policy TEXT NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  // -- raw stream recording (replay source) -------------------------------

  recordFrame(recvTs: number, stream: "odds" | "scores", data: string): void {
    this.db
      .prepare(`INSERT INTO frames (recv_ts, stream, data) VALUES (?, ?, ?)`)
      .run(recvTs, stream, data);
  }

  frames(): RecordedFrame[] {
    return this.db
      .prepare(`SELECT seq, recv_ts AS recvTs, stream, data FROM frames ORDER BY seq`)
      .all() as unknown as RecordedFrame[];
  }

  frameCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM frames`).get() as { n: number };
    return row.n;
  }

  // -- desk activity ------------------------------------------------------

  saveQuote(q: Quote): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO quotes
         (id, ts, fixture_id, outcome, bid, ask, mid, spread, model_prob, consensus_prob, reason, suspended)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        q.id, q.ts, q.fixtureId, q.outcome, q.bid, q.ask, q.mid, q.spread,
        q.modelProb, q.consensusProb, q.reason, q.suspended ? 1 : 0
      );
  }

  saveFill(f: Fill): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO fills
         (id, ts, fixture_id, outcome, side, price, qty, quote_id, consensus_prob)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(f.id, f.ts, f.fixtureId, f.outcome, f.side, f.price, f.qty, f.quoteId, f.consensusProb);
  }

  savePosition(p: Position): void {
    if (p.qty === 0 && p.realizedPnl === 0) {
      this.db
        .prepare(`DELETE FROM positions WHERE fixture_id = ? AND outcome = ?`)
        .run(p.fixtureId, p.outcome);
      return;
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO positions (fixture_id, outcome, qty, avg_price, realized_pnl)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(p.fixtureId, p.outcome, p.qty, p.avgPrice, p.realizedPnl);
  }

  deleteFixturePositions(fixtureId: number): void {
    this.db.prepare(`DELETE FROM positions WHERE fixture_id = ?`).run(fixtureId);
  }

  positions(): Position[] {
    return (
      this.db
        .prepare(
          `SELECT fixture_id AS fixtureId, outcome, qty, avg_price AS avgPrice, realized_pnl AS realizedPnl
           FROM positions`
        )
        .all() as unknown as Position[]
    );
  }

  saveSettlement(s: Settlement): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO settlements
         (fixture_id, ts, home_goals, away_goals, winner, seq, pnl, proof_status, proof_detail, anchor_sig)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        s.fixtureId, s.ts, s.homeGoals, s.awayGoals, s.winner, s.seq, s.pnl,
        s.proofStatus, s.proofDetail ?? null, s.anchorSig ?? null
      );
  }

  settlements(): Settlement[] {
    return this.db
      .prepare(
        `SELECT fixture_id AS fixtureId, ts, home_goals AS homeGoals, away_goals AS awayGoals,
                winner, seq, pnl, proof_status AS proofStatus, proof_detail AS proofDetail,
                anchor_sig AS anchorSig
         FROM settlements ORDER BY ts`
      )
      .all() as unknown as Settlement[];
  }

  saveGateBlock(ts: number, fixtureId: number | null, outcome: string | null, d: GateDecision): void {
    this.db
      .prepare(`INSERT INTO gate_blocks (ts, fixture_id, outcome, policy, reason) VALUES (?, ?, ?, ?, ?)`)
      .run(ts, fixtureId, outcome, d.policy, d.reason);
  }

  gateBlocks(limit = 100): unknown[] {
    return this.db
      .prepare(
        `SELECT ts, fixture_id AS fixtureId, outcome, policy, reason
         FROM gate_blocks ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }

  // -- anchoring ----------------------------------------------------------

  /** Rows (quotes+fills) not yet covered by an anchor, canonically ordered. */
  unanchoredActivity(): { quotes: Quote[]; fills: Fill[] } {
    const quotes = this.db
      .prepare(
        `SELECT id, ts, fixture_id AS fixtureId, outcome, bid, ask, mid, spread,
                model_prob AS modelProb, consensus_prob AS consensusProb, reason,
                suspended
         FROM quotes WHERE anchored_seq IS NULL ORDER BY ts, id`
      )
      .all() as unknown as (Quote & { suspended: number | boolean })[];
    const fills = this.db
      .prepare(
        `SELECT id, ts, fixture_id AS fixtureId, outcome, side, price, qty,
                quote_id AS quoteId, consensus_prob AS consensusProb
         FROM fills WHERE anchored_seq IS NULL ORDER BY ts, id`
      )
      .all() as unknown as Fill[];
    return {
      quotes: quotes.map((q) => ({ ...q, suspended: Boolean(q.suspended) })),
      fills,
    };
  }

  createAnchor(ts: number, kind: string, payloadHash: string, coverage: string): number {
    const res = this.db
      .prepare(`INSERT INTO anchors (ts, kind, payload_hash, coverage) VALUES (?, ?, ?, ?)`)
      .run(ts, kind, payloadHash, coverage);
    return Number(res.lastInsertRowid);
  }

  markAnchorSent(seq: number, txSig: string): void {
    this.db.prepare(`UPDATE anchors SET tx_sig = ?, status = 'sent' WHERE seq = ?`).run(txSig, seq);
  }

  markAnchorFailed(seq: number, reason: string): void {
    this.db.prepare(`UPDATE anchors SET status = ? WHERE seq = ?`).run(`failed:${reason.slice(0, 80)}`, seq);
  }

  coverActivityByAnchor(seq: number, quoteIds: string[], fillIds: string[]): void {
    const qStmt = this.db.prepare(`UPDATE quotes SET anchored_seq = ? WHERE id = ?`);
    for (const id of quoteIds) qStmt.run(seq, id);
    const fStmt = this.db.prepare(`UPDATE fills SET anchored_seq = ? WHERE id = ?`);
    for (const id of fillIds) fStmt.run(seq, id);
  }

  anchors(): unknown[] {
    return this.db
      .prepare(`SELECT seq, ts, kind, payload_hash AS payloadHash, coverage, tx_sig AS txSig, status FROM anchors ORDER BY seq`)
      .all();
  }

  // -- misc ---------------------------------------------------------------

  setMeta(key: string, value: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  recentQuotes(limit = 60): Quote[] {
    const rows = this.db
      .prepare(
        `SELECT id, ts, fixture_id AS fixtureId, outcome, bid, ask, mid, spread,
                model_prob AS modelProb, consensus_prob AS consensusProb, reason, suspended
         FROM quotes ORDER BY ts DESC LIMIT ?`
      )
      .all(limit) as unknown as (Quote & { suspended: number | boolean })[];
    return rows.map((q) => ({ ...q, suspended: Boolean(q.suspended) }));
  }

  recentFills(limit = 60): Fill[] {
    return this.db
      .prepare(
        `SELECT id, ts, fixture_id AS fixtureId, outcome, side, price, qty,
                quote_id AS quoteId, consensus_prob AS consensusProb
         FROM fills ORDER BY ts DESC LIMIT ?`
      )
      .all(limit) as unknown as Fill[];
  }

  close(): void {
    this.db.close();
  }
}
