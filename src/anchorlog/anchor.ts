/**
 * On-chain anchoring of desk activity.
 *
 * Every ANCHOR_INTERVAL the engine gathers all quotes and fills not yet
 * covered by an anchor, canonicalises them to JSON, hashes with SHA-256 and
 * commits the hash to Solana as an SPL Memo transaction:
 *
 *     PDESK|v1|<session>|<anchorSeq>|<sha256hex>
 *
 * Because the memo lands on-chain *before* match outcomes are known, the
 * desk's track record is tamper-evident: nobody (including us) can retro-fit
 * quotes after seeing results. `npm run verify-anchors` re-derives every hash
 * from the ledger and checks it against the on-chain memo — the same
 * trust-but-verify posture TxLINE itself uses for its data.
 *
 * Anchoring is best-effort by design: if the chain is unreachable the desk
 * keeps trading and the anchor row stays 'pending' for the next tick.
 * (Trading halts belong to the risk gate, not the audit trail.)
 */

import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { MEMO_PROGRAM_ID } from "../config.js";
import type { Ledger } from "../ledger/db.js";
import { makeLog } from "../log.js";
import type { Fill, Quote } from "../types.js";

const log = makeLog("anchor");

export function canonicalPayload(quotes: Quote[], fills: Fill[]): string {
  // Canonical form: sorted by (ts, id), fixed key order, no whitespace.
  const q = quotes.map((x) => [x.id, x.ts, x.fixtureId, x.outcome, r6(x.bid), r6(x.ask), x.suspended ? 1 : 0]);
  const f = fills.map((x) => [x.id, x.ts, x.fixtureId, x.outcome, x.side, r6(x.price), x.qty]);
  return JSON.stringify({ v: 1, quotes: q, fills: f });
}

export function payloadHash(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

export function memoText(session: string, seq: number, hash: string): string {
  return `PDESK|v1|${session}|${seq}|${hash}`;
}

export class Anchorer {
  constructor(
    private ledger: Ledger,
    private conn: Connection,
    private keypair: Keypair,
    private session: string,
    private onAnchored?: (seq: number, sig: string, hash: string) => void
  ) {}

  /** Anchor all uncovered activity. Returns the tx signature or null when idle/offline. */
  async tick(): Promise<string | null> {
    const { quotes, fills } = this.ledger.unanchoredActivity();
    if (quotes.length === 0 && fills.length === 0) return null;

    const payload = canonicalPayload(quotes, fills);
    const hash = payloadHash(payload);
    const coverage = JSON.stringify({ quotes: quotes.map((q) => q.id), fills: fills.map((f) => f.id) });
    const seq = this.ledger.createAnchor(Date.now(), "activity", hash, coverage);

    try {
      const sig = await this.sendMemo(memoText(this.session, seq, hash));
      this.ledger.markAnchorSent(seq, sig);
      this.ledger.coverActivityByAnchor(
        seq,
        quotes.map((q) => q.id),
        fills.map((f) => f.id)
      );
      log.info(`anchor #${seq}: ${quotes.length} quotes + ${fills.length} fills → ${sig}`);
      this.onAnchored?.(seq, sig, hash);
      return sig;
    } catch (e) {
      this.ledger.markAnchorFailed(seq, String(e));
      log.warn(`anchor #${seq} failed (will retry next tick):`, String(e).slice(0, 120));
      return null;
    }
  }

  /** Anchor a settlement record (called once per settled fixture). */
  async anchorSettlement(fixtureId: number, detail: object): Promise<string | null> {
    const payload = JSON.stringify({ v: 1, kind: "settlement", fixtureId, detail });
    const hash = payloadHash(payload);
    const seq = this.ledger.createAnchor(Date.now(), "settlement", hash, JSON.stringify({ fixtureId }));
    try {
      const sig = await this.sendMemo(memoText(this.session, seq, hash));
      this.ledger.markAnchorSent(seq, sig);
      this.onAnchored?.(seq, sig, hash);
      return sig;
    } catch (e) {
      this.ledger.markAnchorFailed(seq, String(e));
      return null;
    }
  }

  private async sendMemo(text: string): Promise<string> {
    const ix = new TransactionInstruction({
      keys: [{ pubkey: this.keypair.publicKey, isSigner: true, isWritable: false }],
      programId: new PublicKey(MEMO_PROGRAM_ID),
      data: Buffer.from(text, "utf8"),
    });
    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.conn, tx, [this.keypair], { commitment: "confirmed" });
  }
}

function r6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
