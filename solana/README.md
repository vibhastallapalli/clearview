# Solana (devnet only)

No real funds. Our own test token, clearly labelled. **Never call it USDC.**

## Phase 1: direct payment (milestone)

Flow already in the server:
1. Owner approves → `Approval { recipient, amountMinor, evidenceRevision }`
2. `POST /api/orders/:id/payments` → `Payment { status: "awaiting_signature", idempotencyKey }` (repeat clicks return the same payment)

To build:
1. **Setup** (once): create an SPL test mint on devnet, a buyer wallet with test tokens, a supplier wallet. Put the mint in `.env` (`DEMO_TOKEN_MINT`) and the supplier address in `shared/fixtures/supplier.json`.
2. **Web:** connect Phantom/Solflare (devnet), build an SPL `transferChecked` from buyer ATA → supplier ATA for `amountMinor` (token decimals = 2 keeps cents exact), send, get the signature.
3. **Server:** `POST /api/orders/:id/payments/confirm { signature }` → fetch the tx from `SOLANA_RPC_URL`, check **mint, amount, recipient** match `order.payment`, then `payment_submitted` → `payment_confirmed`. Mismatch or timeout → `payment_failed` / `unknown`. Never mark confirmed without checking.
4. Show the Solana Explorer link (`?cluster=devnet`).
5. Stretch: batch several approved payments in one transaction.

Suggested libs: `@solana/web3.js`, `@solana/spl-token`, `@solana/wallet-adapter-react`.

## Phase 2: escrow (only after Phase 1 works)

Rules: [../docs/escrow-rulebook.md](../docs/escrow-rulebook.md). Anchor program, minimal instructions:

| Instruction | Signer | Effect |
|---|---|---|
| `fund` | buyer | lock order amount; store supplier address + terms hash |
| `accept_all` | buyer | release everything to stored supplier |
| `claim` | buyer | release accepted part now, lock claimed part |
| `settle` | buyer **and** supplier | pay out the split both signed (must sum to locked amount) |

Must fail: wrong signer, changed destination, second payout, settlement that doesn't sum.
