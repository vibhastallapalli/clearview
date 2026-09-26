# ClearDock order escrow (devnet)

Anchor program for Phase 2 of ClearDock. Rules: [`docs/escrow-rulebook.md`](../../docs/escrow-rulebook.md).
Progress and go/no-go: [`docs/escrow-status.md`](../../docs/escrow-status.md).

**Program ID (devnet):** `2tVuzMGuXEX6ZcvBdDroKr163z3Y8B7fJubwGuqUBv4J`

Devnet only, CDT test token only. Never call it USDC.

## What it enforces

The buyer can act alone only in ways that pay the supplier. Held money moves only when both parties sign.

| Instruction | Signers | Effect |
|---|---|---|
| `fund(order_id_hash, amount, terms_hash)` | buyer | Locks `amount` in a vault PDA; stores buyer, supplier, mint, terms hash. `order_id_hash = sha256(order reference)`. |
| `accept_all()` | buyer | Pays the full amount to the stored supplier. |
| `claim(accepted_amount, claimed_amount)` | buyer | Pays `accepted_amount` to the supplier now; holds `claimed_amount`. The two must equal the order amount. |
| `settle(to_supplier, to_buyer)` | buyer **and** supplier | Pays out the held amount exactly as both signed. The split must equal the held amount. |

Guarantees (each covered by a test):

- Payouts go only to token accounts owned by the stored supplier/buyer (`WrongDestination`).
- Only the stored buyer can accept or claim (`Unauthorized`); `settle` needs both signatures (`AccountNotSigner`).
- Each escrow pays out once: `accept_all` → `Released`, `claim` → `Claimed` → `settle` → `Settled` (`InvalidStatus` otherwise).
- A settlement must account for every held unit (`AmountMismatch`).
- Held amounts come from the escrow's own accounting, not the vault balance, so stray deposits can't change a split.

Not built (parked in `ROADMAP.md`): deposits, timeouts, auto-release, arbitration. Accounts stay open after payout as an on-chain record.

## Tests

`tests/escrow.test.ts` runs unchanged under `anchor test` and in Solana Playground:

1. Happy path: `fund` → `accept_all` pays the supplier in full.
2. Demo split: $30 order, $10 claimed, $20 paid now, settlement refunds $10.
3. Must fail: non-buyer releases funds.
4. Must fail: payout to an account the supplier doesn't own.
5. Must fail: second payout from the same escrow.
6. Must fail: settlement that doesn't add up.
7. Must fail: buyer settles without the supplier's signature (the program, not the client, rejects it).
8. Must fail: buyer releases held funds alone after a claim.

Test wallets are funded from the provider wallet, not airdrops, so the suite runs on devnet.

## Run it

**Solana Playground (how it was built and deployed):** open [beta.solpg.io](https://beta.solpg.io), create an Anchor project, paste `programs/escrow/src/lib.rs` and `tests/escrow.test.ts`, then Build → Deploy → Test. Deploying needs about 5 devnet SOL in the Playground wallet.

**Local Anchor CLI (0.30.1):**

```bash
cd solana/escrow
npm install
anchor keys sync     # only if you deploy under a different program keypair
anchor test          # local validator
```

`npm run typecheck` checks the tests without a validator.

## Demo split (rulebook example)

1. Buyer funds 3000 (cents) for order `PO-1001` → vault holds $30.
2. Buyer scans, one bag missing: `claim(2000, 1000)` → supplier gets $20 now, $10 held.
3. Supplier agrees to refund: `settle(0, 1000)`, signed by both → buyer gets $10 back.

## App integration

`server/src/escrow.ts` exposes `POST /api/orders/:id/escrow/events { action, signature, escrowAddress? }`. It confirms the transaction ran this program on this escrow, then reads the escrow account itself (never client-reported amounts). It also checks that the escrow's order hash matches the order reference and that it pays the verified supplier wallet. `web/src/escrow/EscrowPanel.tsx` shows that state.

The Playground wallet `2MDRPMZVyVjhF1Kc81BrruHqbyc1PFS2EwZGXwxPbSmH` is the program's upgrade authority, and it lives in that browser's local storage. Don't clear site data for beta.solpg.io in that browser.
