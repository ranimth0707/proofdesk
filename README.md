# ProofDesk

**Live dashboard (deployed, runs 24/7): https://stomach-eight-yacht-whether.trycloudflare.com**
*(Cloudflare Quick Tunnel — no uptime SLA; if it's briefly unreachable, `npm run replay` below reproduces the identical session locally in under a minute.)*

**An autonomous in-play market maker whose every quote and every settlement is cryptographically verifiable.**

ProofDesk consumes both TxLINE World Cup feeds — the scout-sourced **scores stream** and the **StablePrice odds consensus** — prices the full-time 1X2 market with its own deterministic in-play model, quotes a two-sided book, simulates fills against informed flow, and settles every position against **TxLINE's on-chain Merkle roots** via `validateStatV2`. Every quote batch is hashed and anchored to Solana **before outcomes are known**, so the desk's track record cannot be retro-fitted — not even by us.

```
scout event (red card, 61')      StablePrice consensus reprices
        │                                   │
        ▼                                   ▼
   t=0s: model reprices …… 30-90s later: consensus catches up
        └───────────── the desk quotes inside that window ─────────────┘
```

TxLINE anchors its data on-chain so consumers don't have to trust the publisher.
ProofDesk extends the same property to the *trading layer built on top of it* — a
market operator could hand this to a counterparty and say: *audit everything,
trust nothing.*

Built for the TxLINE **Trading Tools and Agents** track.

---

## Judge Path (3 minutes, no credentials, no funds)

```bash
npm install                      # Node ≥ 22.5 (uses built-in node:sqlite — zero native deps)
cp policy.example.json data/policy.json
npm test                         # 23 unit tests: model math, quoting, book, fail-closed gate
npm run judge-trace              # synthetic match through the REAL engine — every decision printed
npx tsx scripts/make-sample-session.ts   # deterministic recorded session (seeded PRNG)
npm run replay -- --speed 200    # replay through the identical decision path
# open http://localhost:8787     # dashboard: model vs consensus, quotes, fills, PnL, proofs
```

`judge-trace` prints the full decision trail on one screen: calibration, quotes
with spread reasoning, an adverse fill, a red-card repricing, gate refusals
(position cap, exposure cap), and a settlement. Rerun it — the output is
byte-identical. **Determinism is a test**, not a claim: the e2e test replays the
same frames twice and asserts equal canonical activity hashes.

### Live Path (World Cup free tier)

```bash
# wallet needs a little SOL on the chosen network (fees only — the tier is free)
PROOFDESK_NETWORK=devnet npm run activate    # on-chain subscribe → sign → API token
npm run judge-status                         # PASS/FAIL readiness on one screen
npm start                                    # autonomous: feed → model → quote → gate → anchor → settle
npm run verify-anchors                       # independent audit: ledger re-hash vs on-chain memos
```

`PROOFDESK_NETWORK=mainnet SERVICE_LEVEL=12 npm run activate` switches to the
real-time mainnet tier (also free for the World Cup).

---

## What the desk does

1. **Calibrates** per fixture from the last pre-kickoff StablePrice 1X2 triple:
   inverts the consensus into Poisson goal intensities (λ_home, λ_away) by
   deterministic grid search (`solveLambdas`, round-trip-tested).
2. **Prices in-play** off the scout feed: remaining-time decay, red-card
   multipliers (−32% own attack / +12% opponent), bounded momentum from shots /
   dangerous free kicks / corners (±12% max, 5-min half-life), pending-penalty
   mixture at the documented 76% conversion rate. All constants are named,
   documented, and bounded — no learned state, no randomness.
3. **Quotes** each outcome two-sided in probability space:
   `mid = 0.6·model + 0.4·consensus`, `spread = 1.5pp + 0.5·|model−consensus| +
   2pp during event windows`. Pulls quotes on toxic divergence (>12pp), dead
   phases, and near-certainty — the same protections a human desk runs.
4. **Fills adversarially**: a standing quote is only ever filled when the
   consensus *moves through it* — every fill is against informed flow by
   construction, so reported PnL is a worst-case lower bound, not a
   cherry-picked simulation.
5. **Enforces limits fail-closed**: no policy file → the engine refuses to
   start. Position caps, per-fixture gross exposure, daily fill caps, cooldowns,
   kill-switch file. No bypass flag exists in the codebase.
6. **Anchors** all quotes/fills as SHA-256 hashes in SPL Memo transactions every
   60s, and **settles** each fixture from the `game_finalised` record, proving
   the exact final score against TxLINE's on-chain daily Merkle root with a
   `validateStatV2` simulation (`.view()`, costless).

Once started there is no human in the loop — no approval steps, no manual
inputs, no interactive prompts.

## Architecture

```
┌──────────────────────────── TxLINE ────────────────────────────┐
│  /odds/stream (SSE)                  /scores/stream (SSE)      │
│  StablePrice consensus               scout events               │
└───────────────┬──────────────────────────────┬─────────────────┘
                ▼                              ▼
        ┌─ consensus tracker ─┐      ┌─ in-play model ──────────┐
        │ 1X2 Pct triple      │      │ Poisson + phase clock +  │
        │ pre-match → calibr. │      │ cards/momentum/penalty   │   src/model
        └─────────┬───────────┘      └───────────┬──────────────┘
                  └────────────┬─────────────────┘
                               ▼
                     ┌─ quoter (src/mm) ─┐   spread = f(divergence, events)
                     │ two-sided quotes  │   fills = consensus crossing (adverse)
                     └────────┬──────────┘
                              ▼
                  ┌─ risk gate (src/risk) ─┐  FAIL-CLOSED: no policy → no start
                  │ caps · cooldown · kill │  every refusal logged with reason
                  └────────┬───────────────┘
                           ▼
              ┌─ ledger (node:sqlite) ─┐  quotes · fills · positions ·
              │ src/ledger             │  settlements · anchors · raw frames
              └───┬──────────────┬─────┘
                  ▼              ▼
     ┌─ anchorer (60s tick) ─┐  ┌─ settler ──────────────────────┐
     │ SHA-256 → SPL Memo    │  │ game_finalised → book settle → │
     │ pre-outcome, on-chain │  │ validateStatV2 vs Merkle root  │
     └───────────────────────┘  └────────────────────────────────┘
                  ▼
      dashboard (SSE out) + replay engine (same ingest path)
```

## Trust model — why "verifiable" is not a buzzword here

| Claim | Mechanism | Check it yourself |
|---|---|---|
| The desk really quoted X at time T | quote-batch hashes land in Solana memos before match outcomes exist | `npm run verify-anchors` re-derives every hash from the ledger and compares on-chain |
| Settlement used the real final score | exact score proven against TxLINE's on-chain daily scores Merkle root | `validateStatV2` simulation logged per settlement, PDA + seq recorded |
| Replay equals live behavior | replay feeds recorded frames through the identical `Engine.ingest()` path | e2e test asserts identical canonical hashes across runs |
| Limits can't be bypassed | gate constructor throws without policy; executor path has no override | `tests/gate-engine.test.ts` |

## Evidence map

| Requirement | Where |
|---|---|
| Live TxLINE ingestion (SSE, both feeds) | `src/txline/stream.ts`, wired in `src/main.ts` |
| Deterministic decision logic | `src/model/poisson.ts`, `src/model/inplay.ts`, `src/mm/quoter.ts` |
| Autonomous operation (JWT renewal, reconnect, watchdog, crash recovery) | `src/txline/auth.ts`, `src/txline/stream.ts`, `Engine` position restore |
| Fail-closed risk engine | `src/risk/gate.ts` |
| On-chain anchoring + audit | `src/anchorlog/anchor.ts`, `scripts/verify-anchors.ts` |
| Merkle-proof settlement | `src/settle/settlement.ts` |
| Replay/simulated feed support | `src/replay/replayer.ts`, `scripts/make-sample-session.ts` |
| Tests | `tests/*.test.ts` (23) |

## TxLINE endpoints used

- `POST /auth/guest/start` — guest JWT (+ runtime renewal on 401)
- on-chain `subscribe` (program `6pW64…` devnet / `9ExbZ…` mainnet) + `POST /api/token/activate` — free-tier activation
- `GET /api/fixtures/snapshot` — fixture metadata
- `GET /api/odds/snapshot/{fixtureId}`, `GET /api/odds/stream` (SSE) — StablePrice consensus (`Pct` de-margined probabilities)
- `GET /api/scores/snapshot|updates/{fixtureId}`, `GET /api/scores/stream` (SSE) — scout events, phases, `game_finalised`
- `GET /api/scores/historical/{fixtureId}` — session material for replays
- `GET /api/scores/stat-validation?fixtureId&seq&statKeys=1,2` + on-chain `validateStatV2` `.view()` — settlement proofs

## Feedback for the TxODDS team

What worked well and what we hit — see [docs/TXLINE-FEEDBACK.md](docs/TXLINE-FEEDBACK.md).

## Demo video

*(link in the Superteam Earn submission)* — script at [docs/DEMO-SCRIPT.md](docs/DEMO-SCRIPT.md).

## License

MIT
