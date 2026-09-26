# Agent 2: Devnet setup and payment confirmation (server)

**Branch:** `sol/confirm` · **Owns:** `server/src/solana/**`, `solana/scripts/**`, the `/api/orders/:id/payments/confirm` route

Paste this into Claude after cloning `https://github.com/vibhastallapalli/clearview`:

---

You are working on ClearDock, a hackathon project. Read CLAUDE.md, README.md, CONTRACTS.md and solana/README.md first and follow CLAUDE.md strictly.

Create branch `sol/confirm` from `main`. Your job: the server side of real devnet payments.

1. `solana/scripts/setup-devnet.ts` (run with `npx tsx`): create or reuse keypairs for buyer and supplier (saved under `solana/.keys/`, already gitignored), airdrop devnet SOL, create an SPL test mint with **2 decimals** named "ClearDock Test Dollar (devnet)" (never "USDC"), mint 1,000.00 to the buyer. Print the mint, buyer and supplier addresses and the lines to paste into `.env` and `shared/fixtures/supplier.json`. Handle airdrop rate limits with a clear message.
2. `server/src/solana/verify.ts`: given a signature, fetch the transaction from `SOLANA_RPC_URL` and check it is a successful SPL transfer of exactly `payment.amountMinor` of `DEMO_TOKEN_MINT` to the recipient's token account for `payment.recipient`. Return a typed result: confirmed / pending / mismatch (with reason) / failed.
3. Replace the 501 in `POST /api/orders/:id/payments/confirm` (in `server/src/index.ts`; only that handler) to accept `{ signature }`, store it on `order.payment`, set `payment_submitted`, verify, then set `payment_confirmed` or `payment_failed` with the reason. Poll a few times for pending. Reject a signature already used by another order. Never mark confirmed without verification.
4. Add `npm run setup:devnet` to the root package.json in your PR description (integrator adds it).
5. Write tests for verify.ts using recorded transaction JSON so they run offline.

Done when: a real devnet transfer signature flips the order to "Payment confirmed", and a wrong-amount or wrong-recipient signature is rejected. Run `npm test && npm run typecheck && npm run build` before pushing. Open a PR to `main`. No AI attribution in commits or PRs.
