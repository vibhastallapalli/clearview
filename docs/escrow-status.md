# Escrow status (P4, branch `sol/escrow`)

Hard stop 6:00 pm. **Go** = the happy path plus at least 2 must-fail tests pass **on devnet**. Otherwise escrow becomes a "What's next" line and P4 joins demo prep.

## Now (Sat 2:10 pm)

| Piece | State |
|---|---|
| Anchor program (`solana/escrow`) | ✅ Compiles in Solana Playground. Program ID `2tVuzMGuXEX6ZcvBdDroKr163z3Y8B7fJubwGuqUBv4J` |
| Test suite (8 tests) | ✅ Written and typechecked. Loaded in Playground, not yet run |
| Devnet deploy | ⛔ Blocked: deploy wallet `2MDRPMZVyVjhF1Kc81BrruHqbyc1PFS2EwZGXwxPbSmH` has 0 SOL (public faucet rate-limited). Needs ~5 devnet SOL |
| Server route `POST /api/orders/:id/escrow/events` | ✅ Written. Decoder verified offline; live check pending deploy |
| Web `EscrowPanel` | ✅ Read-only state card built. Signing buttons wait on P2's wallet stack |
| Push to GitHub | ✅ `sol/escrow` pushed |

## Gates

- [x] 2:30: program compiles in Solana Playground
- [ ] Deployed to devnet
- [ ] Tests pass on devnet (evidence below)
- [ ] 6:00 go/no-go call

## Go/no-go evidence (fill from the Playground test run)

| Test | Result | Example tx |
|---|---|---|
| Happy path: fund → accept_all | | |
| Demo split: claim $10, settle refunds $10 | | |
| Must fail: non-buyer releases funds | | |
| Must fail: payout to a non-supplier account | | |
| Must fail: second payout | | |
| Must fail: settlement doesn't add up | | |
| Must fail: settle without supplier signature | | |
| Must fail: buyer releases held funds alone | | |

## Integration requests

**P1 (integrator):**
1. Merge Contracts v2 (on `sol/payments`) to `main`. Its `EscrowRecord` matches the local copy in `server/src/escrow.ts` and `web/src/escrow/EscrowPanel.tsx` field for field. P4 then switches both to the shared import.
2. Mount the router in `server/src/index.ts`, before the error handler:
   ```ts
   import { escrowRouter } from "./escrow.ts";
   app.use(escrowRouter);
   ```
3. Add `ESCROW_PROGRAM_ID=2tVuzMGuXEX6ZcvBdDroKr163z3Y8B7fJubwGuqUBv4J` to `.env.example`, and have `publicConfig()` in `server/src/solana/tx.ts` return it as `escrowProgramId` (currently hardcoded `null`).
4. The route rejects escrows that don't pay the seeded supplier wallet, so `DEMO_SUPPLIER_WALLET` must be set (it already overrides the fixture).

**P2 (web):**
1. Render `<EscrowPanel detail={data} />` in `OrderPage.tsx` under `PaymentPanel`. It renders nothing when an order has no escrow.
2. Once `@solana/web3.js` and the wallet adapter are in `web/package.json`, P4 adds the fund/claim/settle buttons in `web/src/escrow/` on top of your wallet context.

## Demo mechanics (if go)

- The escrow is keyed by `sha256("PO-1001")`, so the server can prove which order it belongs to.
- `settle` needs both signatures in one transaction. For the demo, both wallets sign in sequence in one browser before the blockhash expires (~60 s). Holding a partially-signed settlement offer server-side is roadmap.

## If cut at 6:00

"What's next" line: *On-chain escrow: funds held per order; the buyer can release or claim, and disputed money moves only when buyer and supplier both sign the same split (program built and tested, not in the live demo).*
