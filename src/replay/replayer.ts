/**
 * Replay engine.
 *
 * Live sessions record every raw SSE frame verbatim into the ledger
 * (`frames` table). Replay reads those frames back and feeds them through
 * the *same* `Engine.ingest()` path with original inter-frame timing
 * (scaled by `speed`), so a replayed match exercises bit-identical decision
 * logic — the point being that judges reviewing after the tournament can
 * watch the desk behave exactly as it did live.
 *
 * Frames can come from the same DB or from an exported session DB shipped
 * in the repo (data/sample-session.db).
 */

import { Ledger } from "../ledger/db.js";
import type { Engine } from "../engine.js";
import { makeLog } from "../log.js";

const log = makeLog("replay");

export interface ReplayOptions {
  /** Time multiplier: 10 = ten times faster than reality. */
  speed: number;
  /** Cap on inter-frame gap after scaling, ms (dead-air compression). */
  maxGapMs: number;
}

export async function replay(
  sourceLedger: Ledger,
  engine: Engine,
  opts: ReplayOptions = { speed: 10, maxGapMs: 5000 }
): Promise<void> {
  const frames = sourceLedger.frames();
  if (frames.length === 0) {
    log.warn("no recorded frames in source ledger — nothing to replay");
    return;
  }
  log.info(`replaying ${frames.length} frames at ${opts.speed}x (gap cap ${opts.maxGapMs}ms)`);

  let prevTs = frames[0].recvTs;
  let played = 0;
  for (const frame of frames) {
    const gap = Math.max(0, frame.recvTs - prevTs) / opts.speed;
    prevTs = frame.recvTs;
    if (gap > 0) await sleep(Math.min(gap, opts.maxGapMs));
    engine.ingest(frame.stream, frame.recvTs, frame.data);
    played++;
    if (played % 500 === 0) log.info(`…${played}/${frames.length} frames`);
  }
  log.info(`replay complete: ${played} frames`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
