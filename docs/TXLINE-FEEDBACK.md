# TxLINE API — integration feedback

Written while building ProofDesk during the World Cup hackathon (July 2026).

## What we liked

- **`Pct` on odds payloads is a gift.** De-margined implied probabilities
  straight from StablePrice meant our signal layer needed zero de-vigging code —
  the difference between an afternoon of margin-model debates and a one-line
  parse. This single field is the best-designed part of the schema for
  algorithmic consumers.
- **The scores feed is genuinely granular.** Shot outcomes (`OnTarget` /
  `Woodwork` / `Blocked`), free-kick danger tiers, VAR lifecycle, and the
  deterministic stat-key encoding made it possible to build an in-play model
  from the feed alone — no third-party enrichment.
- **`game_finalised` (statusId=100, period=100) is exactly right.** One
  unambiguous settlement marker regardless of extra time/penalties/abandonment
  removed a whole class of grading edge cases.
- **The runnable devnet examples repo saved hours.** `users.ts` +
  `subscription_scores_v2.ts` are effectively reference client code; we lifted
  the activation and `validateStatV2` account plumbing from them directly.
- **Free tier requiring only an on-chain subscribe** (no card, no sales call) is
  the smoothest data-vendor onboarding we've experienced.

## Friction we hit

1. **Devnet SOL is the real onboarding gate.** The public devnet faucet was dry
   for most of a day (429s from every endpoint/IP we tried), which blocked the
   free-tier `subscribe` transaction — the only step that needs SOL at all. A
   TxODDS-operated micro-faucet (0.01 SOL per hackathon wallet) or a
   pre-funded guest tier would remove the last piece of friction.
2. **JWT + API-token duality needs a prominent doc callout.** The
   `Authorization: Bearer <jwt>` + `X-Api-Token` pair, with different lifetimes
   and renewal paths, is easy to get wrong on stream reconnects. The docs do
   cover it, but a dedicated "credential lifecycle" page with a sequence diagram
   would prevent most first-hour 401/403 confusion.
3. **Odds market taxonomy is discovery-driven.** `SuperOddsType` values and
   market shapes must be learned from live payloads (docs explicitly say to
   branch on the payload). Fair enough — but a static enum reference of the
   SuperOddsType strings with example payloads per market would let integrators
   pre-write market selectors instead of logging and reverse-engineering.
4. **`Pct` as strings with `"NA"`.** Understandable for quarter-handicaps, but a
   nullable numeric field (or a separate `PctAvailable` flag) would avoid every
   consumer writing the same parse-and-filter shim.
5. **Historical window (2 weeks → 6 hours ago) has a same-day gap.** For a match
   that finished 2 hours ago there is no replayable record yet; during a
   tournament, same-day replays are exactly what analysts want. Shrinking the
   6-hour lower bound would help.

## Wishlist

- WebSocket alternative to SSE for burst-heavy in-play windows.
- A "consensus components" endpoint: number of books contributing to a
  StablePrice tick, for confidence weighting.
- Server-side fixture filter on the streams (`?fixtureId=`) to cut bandwidth for
  single-match tools.
