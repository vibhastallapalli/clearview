# ClearDock order escrow (Phase 2, devnet)

Standalone Anchor program. Rules: [`../../docs/escrow-rulebook.md`](../../docs/escrow-rulebook.md).
Spec table: [`../README.md`](../README.md). Status/progress log: [`../../docs/escrow-status.md`](../../docs/escrow-status.md).

This is its own Anchor workspace (own `package.json`, not part of the root npm
workspace) so it can be built/tested independently of the web app and server.

## Instructions

| Instruction | Signer(s) | Effect |
|---|---|---|
| `fund(order_id_hash, amount, supplier, terms_hash)` | buyer | Locks `amount` of the devnet test token in a program-owned vault PDA for `supplier`. |
| `accept_all()` | buyer | Releases the full remaining vault balance to the stored supplier. |
| `claim(accepted_amount, claimed_amount)` | buyer | Releases `accepted_amount` to the supplier now; keeps `claimed_amount` locked pending settlement. |
| `settle(to_supplier, to_buyer)` | buyer **and** supplier | Pays out a split of the locked amount both parties signed off on. `to_supplier + to_buyer` must equal the locked amount exactly. |

Every payout goes only to the token accounts stored on the escrow record
(`WrongDestination` otherwise). Status is tracked on-chain (`Funded` →
`Claimed`/`Released` → `Settled`) so a second payout on an already-settled or
released escrow fails (`InvalidStatus`).

## Building / testing

No local Rust/Anchor toolchain was available on this machine during the
hackathon, so this program was authored here, then compiled, tested and
deployed to devnet via [Solana Playground](https://beta.solpg.io) (browser
IDE, matches the team plan's 2:30 compile gate). To reproduce locally with a
normal Anchor install:

```bash
cd solana/escrow
yarn install        # or npm install
anchor build
anchor test          # local validator: happy path + must-fail cases
anchor deploy --provider.cluster devnet
```

## Demo split (matches the rulebook's worked example)

$30 order, one bag missing:
1. `fund` locks 3000 (cents) from buyer -> vault, supplier = seeded supplier wallet.
2. `claim(accepted_amount=2000, claimed_amount=1000)` — buyer accepts $20 of goods (paid to supplier immediately), disputes $10.
3. Supplier agrees. `settle(to_supplier=0, to_buyer=1000)`, signed by **both** buyer and supplier — the disputed $10 refunds to the buyer.

## Test coverage (`tests/escrow.ts`)

- Happy path: `fund` → `accept_all` pays the supplier in full.
- Demo split above, end to end.
- Wrong signer cannot release funds.
- Settle amounts that don't sum to the locked amount are rejected.
- Settle without the supplier's signature is rejected.
- A changed destination token account is rejected.
- A second payout on an already-released escrow is rejected.

## Program ID

Devnet program ID: _TBD — filled in after deploy, see `docs/escrow-status.md`._
