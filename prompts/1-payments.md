# Agent 1: Payments end to end (devnet)

**Branch:** `sol/payments` · **Owns:** `web/src/payment/**`, `server/src/solana/**`, `solana/scripts/**`, the `/api/orders/:id/payments/confirm` route

This is the critical path: when it's done, the first milestone works with a real devnet payment. Do Part A first; it produces the token and wallets Part B needs.

Paste this into Claude after cloning `https://github.com/vibhastallapalli/clearview`:

---

You are working on ClearDock, a hackathon project. Read CLAUDE.md, README.md, CONTRACTS.md and solana/README.md first and follow CLAUDE.md strictly.

Create branch `sol/payments` from `main`. Your job: real Solana **devnet** payments, server and browser. Do Part A, push, open a draft PR, then do Part B.

## Part A: devnet setup and server verification
1. `solana/scripts/setup-devnet.ts` (run with `npx tsx`): create or reuse keypairs for buyer and supplier (saved under `solana/.keys/`, already gitignored), airdrop devnet SOL, create an SPL test mint with **2 decimals** named "ClearDock Test Dollar (devnet)" (never "USDC"), mint 1,000.00 to the buyer. Print the mint, buyer and supplier addresses and the lines to paste into `.env` and `shared/fixtures/supplier.json`. Handle airdrop rate limits with a clear message.
2. `server/src/solana/verify.ts`: given a signature, fetch the transaction from `SOLANA_RPC_URL` and check it is a successful SPL transfer of exactly `payment.amountMinor` of `DEMO_TOKEN_MINT` to the recipient's token account for `payment.recipient`. Return a typed result: confirmed / pending / mismatch (with reason) / failed.
3. Replace the 501 in `POST /api/orders/:id/payments/confirm` (in `server/src/index.ts`; only that handler) to accept `{ signature }`, store it on `order.payment`, set `payment_submitted`, verify, then set `payment_confirmed` or `payment_failed` with the reason. Poll a few times for pending. Reject a signature already used by another order. Never mark confirmed without verification.
4. Add a `setup:devnet` script to the root package.json (the only root change you may make).
5. Write tests for verify.ts using recorded transaction JSON so they run offline.

## Part B: wallet signing in the browser (only inside `web/src/payment/`)
1. Wallet connect for Phantom and Solflare on devnet (use `@solana/wallet-adapter-react` + `@solana/web3.js` + `@solana/spl-token`). Wrap only the PaymentPanel, don't restructure the app.
2. When `order.payment.status === "awaiting_signature"`, show "Sign and send". Build an SPL `transferChecked` from the connected wallet's token account to `order.payment.recipient` for `order.payment.amountMinor` of the mint from `VITE_DEMO_TOKEN_MINT` (token decimals 2, so amountMinor is the raw amount). Create the recipient's associated token account if missing.
3. After sending, POST `/api/orders/:id/payments/confirm` with `{ signature }`. You built that route in Part A.
4. Show every state: not connected, wrong network, wallet rejected, insufficient balance, submitted (with Solana Explorer devnet link), confirmed, failed/unknown. Disable the button while sending so double clicks can't send twice.
5. Never let the UI change the recipient or amount; they come only from `order.payment`.

`VITE_DEMO_TOKEN_MINT` is already in `.env.example`.

Done when: approving the demo order, clicking "Sign and send" in Phantom/Solflare on devnet, and waiting a few seconds flips the order to "Payment confirmed" with an explorer link; and a wrong-amount or wrong-recipient signature is rejected. Run `npm test && npm run typecheck && npm run build` before pushing. Mark the PR ready for review. No AI attribution in commits or PRs.
