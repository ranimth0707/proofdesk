# Demo video script (target: 4m30s)

Record at 1080p. Screen: dashboard + one terminal. Speak Indonesian or English —
judges are TxODDS + Superteam, English recommended.

## 0:00 – 0:35 — The problem (talking head or slide)

> "Sports trading tools have a trust problem. A bot shows you its track record —
> but the numbers live in its own database. It can backfill quotes, delete bad
> trades, and you'd never know. TxLINE solved this for *data* by anchoring every
> record on Solana. ProofDesk extends the same guarantee to the *trading layer*:
> an autonomous in-play market maker where every quote and every settlement is
> cryptographically verifiable."

## 0:35 – 1:20 — What it does (dashboard on screen, replay running)

Run beforehand: `npx tsx scripts/make-sample-session.ts && npm run replay -- --speed 60`

> "ProofDesk reads both TxLINE feeds. The scout feed — shots, cards, VAR,
> straight from the stadium — drives a deterministic Poisson model. The
> StablePrice consensus is the market. Watch the blue line: 61st minute, red
> card. The model reprices the instant the scout event lands. The consensus
> takes almost a minute to catch up. That window is where a market maker earns
> its spread — and the desk quotes straight through it."

Point at: model jump vs consensus lag on the chart, standing quotes, a fill
appearing, the gate refusals panel.

## 1:20 – 2:20 — Live on the real feed

Show `npm run judge-status` (all PASS), then `npm start` with the live World Cup
final feed; dashboard switches to the real fixture.

> "Fully autonomous: guest-JWT renewal, SSE reconnects, crash recovery from the
> ledger. No human input once started — the risk engine is the only adult in the
> room. It's fail-closed: delete the policy file and the desk refuses to boot."

Demo the kill switch: `touch data/KILL` → quotes stop, gate panel logs
kill-switch refusals → `rm data/KILL`.

## 2:20 – 3:30 — The proof layer (the differentiator)

> "Every 60 seconds the desk hashes its quotes and fills and commits the hash to
> Solana in a memo — *before* the match ends. Here's the anchor on the explorer.
> When TxLINE emits `game_finalised`, the desk settles the book and proves the
> exact final score against TxLINE's on-chain Merkle root with validateStatV2 —
> the same proof system TxLINE publishes for everyone."

Show: anchors panel → click explorer link → memo `PDESK|v1|…|hash`. Then:

```bash
npm run verify-anchors
```

> "Anyone can run this: it re-derives every hash from the ledger and checks it
> on-chain. Edit one row in the database and verification fails. Our track
> record is tamper-evident — trustless bookmaking as infrastructure."

## 3:30 – 4:10 — Engineering credibility (terminal)

```bash
npm test            # 23 tests
npm run judge-trace # full decision trail, deterministic
```

> "The whole decision path is deterministic — same frames in, byte-identical
> decisions out, and that's asserted in tests, not just claimed. Twenty-three
> unit tests cover the model math, the quoting rules, the book accounting, and
> the fail-closed gate."

## 4:10 – 4:30 — Close

> "ProofDesk is what TxLINE's on-chain anchoring makes possible: not just
> verifiable data, but verifiable *behavior* built on top of it. A trading team
> could deploy this desk tomorrow — and their counterparties wouldn't have to
> take their word for anything. Thanks."

## Recording checklist

- [ ] `data/` reset for a clean session (`rm -f data/proofdesk.db data/replay-*.db`)
- [ ] Terminal font ≥ 16pt, dashboard at 100% zoom, dark room lighting
- [ ] Have one anchor tx pre-confirmed so the explorer click is instant
- [ ] Live section recorded during the World Cup final (19 Jul ~19:00 UTC kickoff creates final-half live data before the 23:59 deadline) — if the live window is missed, run the replay of the recorded real session instead and say so honestly
