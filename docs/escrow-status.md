# Escrow status (P4, branch `sol/escrow`)

Hard stop 6:00 pm. **Go** = the happy path plus at least 2 must-fail tests pass **on devnet**. Otherwise escrow becomes a "What's next" line and P4 joins demo prep.

## Verdict (Sat 5:35 pm): PASS on devnet

Deployed to **devnet**, and all 8 tests pass there as well as on a local validator. That meets the go criterion (happy path plus ≥2 must-fail tests on devnet). The UI is not wired and nothing is merged to `main`.

| Piece | State |
|---|---|
| Program | **`Bk4DD3mGCJRFATHTnLqyoxiWDm65nfMcPfE7oduiQzAt`** on devnet ([Explorer](https://explorer.solana.com/address/Bk4DD3mGCJRFATHTnLqyoxiWDm65nfMcPfE7oduiQzAt?cluster=devnet)). Deployed in slot 504547831, deploy tx [`2eqxBhEr…`](https://explorer.solana.com/tx/2eqxBhErWxdcQm6Gmmsu664ArJmWNYMqH6dyZbmn6Qrf1KYyxhUkYE9DJghLTRifLV4RersxGoVNKj3iCzKBQSKx?cluster=devnet). Upgrade authority `BdqrAai14xaJC6AWxNtVaWDfVVCBxs42c4EuYbKrM89G` |
| Build | Anchor 0.30.1 / Solana 1.18.17 (Docker `backpackapp/build:v0.30.1`). `escrow.so` is 316,616 bytes, sha256 `b7e2381af92f8947e8eafb24ffd39eebb4754e7912a076ea4df3bfda59dbc159`. The on-chain program data (dumped with `solana program dump`) has the same hash |
| Old program ID | `2tVuzMGuXEX6ZcvBdDroKr163z3Y8B7fJubwGuqUBv4J` was never deployed, and its keypair exists only in the original Playground browser. It's retired: don't deploy it |
| Server route / `EscrowPanel` | Unchanged and not wired yet (see integration requests) |

The key files live on the deploying laptop, outside the repo, in `~/.cleardock/`: `escrow-deployer.json` (fee payer and upgrade authority) and `escrow-program-keypair.json`. They are never committed or printed.

## Local results (local validator, not devnet)

Run Sat Sep 26 ~4:50 pm against the exact `escrow.so` above, loaded at `Bk4DD3…`. Each run creates a fresh test mint (2 decimals) plus fresh buyer, supplier and stranger wallets.

Success tests check real token balances and the decoded escrow account after each transaction. Must-fail tests work in three steps:
1. Snapshot **every** token balance (vault, buyer, supplier, stranger) and the whole escrow account.
2. Require the program's own error code.
3. Require the snapshot to be identical afterwards.

| # | Test | Local | Rejected by (program error) | Devnet |
|---|---|---|---|---|
| 1 | fund 3000 → `accept_all`: supplier +3000, buyer −3000, vault 0, status `released` | ✅ pass | n/a | ✅ pass (below) |
| 2 | fund 3000 → `claim(2000, 1000)`: supplier +2000, vault 1000, status `claimed` → `settle(0, 1000)` signed by both: buyer gets 1000 back, vault 0, status `settled`, released 2000 / claimed 1000 / refunded 1000 | ✅ pass | n/a | ✅ pass (below) |
| 3 | Stranger signs `accept_all` | ✅ pass | `Unauthorized` (`has_one = buyer`) | ✅ pass (below) |
| 4 | Buyer pays out to a token account the supplier doesn't own | ✅ pass | `WrongDestination` | ✅ pass (below) |
| 5 | Second `accept_all` after release | ✅ pass | `InvalidStatus`; supplier paid exactly once | ✅ pass (below) |
| 6 | `settle` that doesn't add up (under: 0+900, over: 100+1000) | ✅ pass | `AmountMismatch` (both) | ✅ pass (below) |
| 7 | Buyer submits `settle` with the supplier's signer flag removed | ✅ pass | `AccountNotSigner` (error 3010, account `supplier`) | ✅ pass (below) |
| 8 | Buyer calls `accept_all` on claimed (disputed) funds | ✅ pass | `InvalidStatus` | ✅ pass (below) |

Rejections happen at preflight simulation. The program runs there and returns the error code, so no failed transaction lands on chain, and there's no signature to link.

Other local checks: `npm run typecheck` in `solana/escrow` passes. Repo-wide `npm test` (6/6), `npm run typecheck` and `npm run build` pass.

## Devnet results

Run Sat Sep 26 ~5:32 pm against the deployed program, using the same suite as the local run: a fresh test mint (2 decimals, not USDC) plus fresh buyer, supplier and stranger wallets. Result: **8 passing**. Amounts are in minor units (3000 = 30.00 test token).

Success tests assert token balances and the decoded escrow account after every transaction. Must-fail tests assert the program's own error code, then an identical snapshot of every token balance and the escrow account. Rejections happen in preflight simulation, which runs the deployed program, so a rejected transaction has no signature. The links for those rows are the setup transactions for that escrow.

I checked the `accept_all` and `settle` signatures independently with `getTransaction`. Both confirmed with `err: null`, and their logs read "released 3000 to supplier" and "0 to supplier, 1000 back to buyer".

| # | Test | Devnet | Evidence |
|---|---|---|---|
| 1 | fund → `accept_all`: supplier +3000, buyer −3000, vault 0, `released` | ✅ pass | [`2hP2rfG7…`](https://explorer.solana.com/tx/2hP2rfG7o642v2VHDqJ7yLonU3JYUWTCYmuRT7csKH4y5CLAtWvq44UZLNE1mFoYRVRVM5DQs8WaPvQomQFuEvST?cluster=devnet) → [`zjkcz2KB…`](https://explorer.solana.com/tx/zjkcz2KB8k4KkkFS3uXKg9vuSEBuUWEh5tc435BEA3xomkE9Yx5mjom66a5GzndQwJhtQYAAdVdpKCk11dx2M61?cluster=devnet) |
| 2 | fund 3000 → `claim(2000, 1000)` → `settle(0, 1000)`: supplier +2000, buyer net −2000, vault 0, `settled` | ✅ pass | [`3EiQNhXB…`](https://explorer.solana.com/tx/3EiQNhXBan7NTuJX47JcjJHZTgNxEgVvn8Qshv31qLzDriMNL6npkhwSo8LNBuYakDY62RE4RKyRdfQvpKcNrm5X?cluster=devnet) → [`QeS1MS6Z…`](https://explorer.solana.com/tx/QeS1MS6Zz1Vz5EPhozX6UUjkQxfgv8VMGNkkxP449up1hkpCaB5dqh6yM4e8tCTDi1M2CCC7BNPDXz9opu4sKZ8?cluster=devnet) → [`5rz6vixt…`](https://explorer.solana.com/tx/5rz6vixtb5oFWrWbrqwVpqGxNrHC6bYxB5YqgUBx2CqHAyW1RM4GxobGZLQDQaKEzAAngF4QSPK8TDAkkJT1emEZ?cluster=devnet) |
| 3 | Stranger signs `accept_all` | ✅ rejected: `Unauthorized` | fund [`2r4wWiUB…`](https://explorer.solana.com/tx/2r4wWiUBuUsUME6azdnV7KkbrXhD5Wbyf64kXTQbpJF4xAhdqwdwmpuWd3j5bidyL1no73xgUWQyM8sfzHnJJrWv?cluster=devnet) |
| 4 | Payout to a non-supplier token account | ✅ rejected: `WrongDestination` | fund [`3XCDEaXB…`](https://explorer.solana.com/tx/3XCDEaXBhpWTG8i4hLstN82M4EQe99npVG8xZYVaApnxQvKNeTykjMdnrTdos6muSo1D6Ny2b2SS1wCC2VNAaXBw?cluster=devnet) |
| 5 | Second `accept_all` | ✅ rejected: `InvalidStatus`; supplier paid once | fund [`5No2p4N9…`](https://explorer.solana.com/tx/5No2p4N996JN5LQvJSTX8jmJS3ZjP4qn4ZVQXahpf5qKPh4CU2c4Nb6imJzfE7e2S4dybbJ2FdVCTEBB9KntGu7x?cluster=devnet), first release [`MdyQ8TL5…`](https://explorer.solana.com/tx/MdyQ8TL5toBq7UUvFdysjGtLWYF4GfbHaaVLp9Udhu8pVtb7bfchxrWesvzvTLSne5SKr38ScZ5AkYtv46gtmzn?cluster=devnet) |
| 6 | `settle` under (0+900) and over (100+1000) | ✅ rejected: `AmountMismatch` ×2 | fund [`4cTdWGmm…`](https://explorer.solana.com/tx/4cTdWGmmkrUBp7dYoasPMKAowkYaaU3Eo7fFakpXCmKy7ThDUxLc66Gth4YayLJJo8YfPineA7m9CTWUxq26fABS?cluster=devnet), claim [`4rKoyWRT…`](https://explorer.solana.com/tx/4rKoyWRTFbyLXuTdRjfNEfXcReSub6DCaxs65jDb8nWQnwhJAcDYA6jwE2QtvKyM7vRfE8NX3B9SozPQ7avD842r?cluster=devnet) |
| 7 | `settle` without supplier signature | ✅ rejected: `AccountNotSigner` (3010, account `supplier`) | fund [`3BCkfhS5…`](https://explorer.solana.com/tx/3BCkfhS5dsgBFdjwRRiCiK1p3NCFmD26Bqr5oF2y49NubNbYCxdYnTSWJkew2BaVHwhcPqZTtajqizpH2LJicaGN?cluster=devnet), claim [`4Mg1zdEy…`](https://explorer.solana.com/tx/4Mg1zdEykr6PkjbsDkpQyYqTz5D37WMpvmS1YPeSM7aqq8StCQagZJBzGKNT5CAAWsbsUbypXkKRs7ZTLayL8wZp?cluster=devnet) |
| 8 | Buyer `accept_all` on claimed funds | ✅ rejected: `InvalidStatus` | fund [`5EmMbb9k…`](https://explorer.solana.com/tx/5EmMbb9kZzuA53KaYqxwmtdqSH3YyJpnN1WtoQsAeVEqfqtNZDHZbpAyoXRPPp1HhjuXQu5SbgQW8NNAy2ayqKf6?cluster=devnet), claim [`4dD9VnSa…`](https://explorer.solana.com/tx/4dD9VnSajcXqrjgCZEHsCz7yEPQfttGTDuXhf4TUFP73DXYPQyaGknkUku5K4qsoVnpq4s5oN6smUtqSs6S7HiBz?cluster=devnet) |

The public devnet RPC rate-limited the run (HTTP 429, auto-retried); no test was affected.

## Rerun on devnet

From `solana/escrow` (needs Node ≥ 20.19; the deploy wallet spends ~0.2 SOL per run):

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.cleardock/escrow-deployer.json   npx ts-mocha -p ./tsconfig.json -t 1000000 'tests/**/*.test.ts'
```

To redeploy after a program change, run `anchor build` in `backpackapp/build:v0.30.1`, then `bash deploy-devnet.sh` in the same image with `~/.cleardock` mounted at `/k`. The script checks the network is devnet first. `Cargo.lock` is pinned to crates that build with that image.

## Integration requests (devnet passed; ready for these)

**P1 (integrator):**
1. `ESCROW_PROGRAM_ID=Bk4DD3mGCJRFATHTnLqyoxiWDm65nfMcPfE7oduiQzAt` in `.env.example` (**changed** from the `2tVuz…` in the earlier request), and have `publicConfig()` return it as `escrowProgramId`.
2. Mount the router in `server/src/index.ts`, before the error handler:
   ```ts
   import { escrowRouter } from "./escrow.ts";
   app.use(escrowRouter);
   ```
3. Contracts v2's `EscrowRecord` matches the local copy in `server/src/escrow.ts` and `web/src/escrow/EscrowPanel.tsx` field for field. Once it's on `main`, P4 switches both to the shared import.
4. `DEMO_SUPPLIER_WALLET` must be set: the route rejects escrows that don't pay the verified supplier.

**P2 (web):** render `<EscrowPanel detail={data} />` under `PaymentPanel` in `OrderPage.tsx` (renders nothing without an escrow). Signing buttons come after go.

## Demo mechanics (if go)

- The escrow is keyed by `sha256("PO-1001")`, so the server can prove which order it belongs to.
- `settle` needs both signatures in one transaction. For the demo, both wallets sign in sequence in one browser before the blockhash expires (~60 s). Holding a partially-signed settlement offer server-side is roadmap.

## If cut at 6:00

"What's next" line: *On-chain escrow: funds held per order; the buyer can release or claim, and disputed money moves only when buyer and supplier both sign the same split (program built and tested on a local validator, not deployed in the live demo).*
