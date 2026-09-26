# Agent 1: Wallet signing and devnet transfer (web)

**Branch:** `sol/wallet` · **Owns:** `web/src/payment/**` (you may add web dependencies)

Paste this into Claude after cloning `https://github.com/vibhastallapalli/clearview`:

---

You are working on ClearDock, a hackathon project. Read CLAUDE.md, README.md, CONTRACTS.md and solana/README.md first and follow CLAUDE.md strictly.

Create branch `sol/wallet` from `main`. Your job: make the owner able to sign the approved payment in a browser wallet on Solana **devnet**.

Build, only inside `web/src/payment/`:
1. Wallet connect for Phantom and Solflare on devnet (use `@solana/wallet-adapter-react` + `@solana/web3.js` + `@solana/spl-token`). Wrap only the PaymentPanel, don't restructure the app.
2. When `order.payment.status === "awaiting_signature"`, show "Sign and send". Build an SPL `transferChecked` from the connected wallet's token account to `order.payment.recipient` for `order.payment.amountMinor` of the mint from `VITE_DEMO_TOKEN_MINT` (token decimals 2, so amountMinor is the raw amount). Create the recipient's associated token account if missing.
3. After sending, POST `/api/orders/:id/payments/confirm` with `{ signature }`. That route belongs to Agent 2 and returns 501 until they finish; show that error honestly.
4. Show every state: not connected, wrong network, wallet rejected, insufficient balance, submitted (with Solana Explorer devnet link), confirmed, failed/unknown. Disable the button while sending so double clicks can't send twice.
5. Never let the UI change the recipient or amount; they come only from `order.payment`.

`VITE_DEMO_TOKEN_MINT` is already in `.env.example`. Done when: with a funded devnet wallet you can send a real transfer and see its signature and explorer link. Run `npm test && npm run typecheck && npm run build` before pushing. Open a PR to `main`. No AI attribution in commits or PRs.
