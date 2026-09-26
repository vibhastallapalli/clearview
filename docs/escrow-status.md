# Escrow status (P4, branch `sol/escrow`)

Hard stop 6:00 pm. **Go** = the happy path plus at least 2 must-fail tests pass **on devnet**. Otherwise escrow becomes a "What's next" line and P4 joins demo prep.

## Verdict (Sat 5:00 pm): BLOCKED on devnet SOL

All 8 tests pass on a **local** validator. Nothing has run on **devnet** yet: the deploy wallet holds 0 SOL and the public faucet refuses airdrops (rate limit).

| Piece | State |
|---|---|
| Program build | ✅ Built locally with Anchor 0.30.1 / Solana 1.18.17 (Docker `backpackapp/build:v0.30.1`). `escrow.so` 316,616 bytes, sha256 `b7e2381af92f8947e8eafb24ffd39eebb4754e7912a076ea4df3bfda59dbc159` |
| Program ID | **`Bk4DD3mGCJRFATHTnLqyoxiWDm65nfMcPfE7oduiQzAt`** (new). The old ID `2tVuzMGuXEX6ZcvBdDroKr163z3Y8B7fJubwGuqUBv4J` was never deployed (no account on devnet), and its keypair exists only in the original Playground browser, so it's retired |
| Test suite | ✅ 8/8 on a local `solana-test-validator` (below). ⛔ Not run on devnet |
| Devnet deploy | ⛔ Not deployed. Deploy wallet `BdqrAai14xaJC6AWxNtVaWDfVVCBxs42c4EuYbKrM89G` has 0 SOL, and `solana airdrop` fails with the rate-limit error. Needs **~5 devnet SOL** (≈2.2 SOL program rent, ≈2.2 SOL temporary buffer, plus test wallets) |
| Old Playground wallet | `2MDRPMZVyVjhF1Kc81BrruHqbyc1PFS2EwZGXwxPbSmH`: 0 SOL, no transactions on devnet |
| Server route / `EscrowPanel` | Unchanged; not wired (waits on go) |

The key files live on the deploying laptop, outside the repo, in `~/.cleardock/`: `escrow-deployer.json` (fee payer and upgrade authority) and `escrow-program-keypair.json`. They are never committed or printed.

## Local results (local validator, not devnet)

Run Sat Sep 26 ~4:50 pm against the exact `escrow.so` above, loaded at `Bk4DD3…`. Each run creates a fresh test mint (2 decimals) plus fresh buyer, supplier and stranger wallets.

Success tests check real token balances and the decoded escrow account after each transaction. Must-fail tests work in three steps:
1. Snapshot **every** token balance (vault, buyer, supplier, stranger) and the whole escrow account.
2. Require the program's own error code.
3. Require the snapshot to be identical afterwards.

| # | Test | Local | Rejected by (program error) | Devnet |
|---|---|---|---|---|
| 1 | fund 30 → `accept_all`: supplier +30, buyer −30, vault 0, status `released` | ✅ pass | n/a | not run |
| 2 | fund 30 → `claim(20, 10)`: supplier +20, vault 10, status `claimed` → `settle(0, 10)` signed by both: buyer gets 10 back, vault 0, status `settled`, released 20 / claimed 10 / refunded 10 | ✅ pass | n/a | not run |
| 3 | Stranger signs `accept_all` | ✅ pass | `Unauthorized` (`has_one = buyer`) | not run |
| 4 | Buyer pays out to a token account the supplier doesn't own | ✅ pass | `WrongDestination` | not run |
| 5 | Second `accept_all` after release | ✅ pass | `InvalidStatus`; supplier paid exactly once | not run |
| 6 | `settle` that doesn't add up (under: 0+900, over: 100+1000) | ✅ pass | `AmountMismatch` (both) | not run |
| 7 | Buyer submits `settle` with the supplier's signer flag removed | ✅ pass | `AccountNotSigner` (error 3010, account `supplier`) | not run |
| 8 | Buyer calls `accept_all` on claimed (disputed) funds | ✅ pass | `InvalidStatus` | not run |

Rejections happen at preflight simulation. The program runs there and returns the error code, so no failed transaction lands on chain, and there's no signature to link.

Other local checks: `npm run typecheck` in `solana/escrow` passes. Repo-wide `npm test` (6/6), `npm run typecheck` and `npm run build` pass.

## Devnet results

None yet. Fill this from the devnet run's `tx …` and `rejected as expected` lines; don't copy the local table.

| # | Result | Evidence (Explorer, `?cluster=devnet`) |
|---|---|---|
| deploy | | |
| 1–8 | | |

## To finish (one human step, then ~5 min)

1. **Human:** send ~5 devnet SOL to `BdqrAai14xaJC6AWxNtVaWDfVVCBxs42c4EuYbKrM89G`, from faucet.solana.com (GitHub login) or from a teammate's devnet wallet. Devnet only.
2. Deploy from `solana/escrow`. `deploy-devnet.sh` first checks that the genesis hash is devnet and prints the balance:
   ```bash
   docker run --rm -v ~/.cleardock:/k -v "$PWD:/work" -v escrow-target:/work/target backpackapp/build:v0.30.1 bash /work/deploy-devnet.sh
   ```
   (`escrow-target` is the Docker volume holding the build above. To rebuild, run `anchor build` in the same image. `Cargo.lock` is pinned to crates that build with Rust 1.79 / platform-tools 1.75.)
3. Run the suite on devnet from `solana/escrow` (needs Node ≥ 20.19, because `@solana/web3.js` pulls in an ESM-only `uuid`):
   ```bash
   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.cleardock/escrow-deployer.json \
     npx ts-mocha -p ./tsconfig.json -t 1000000 'tests/**/*.test.ts'
   ```
4. Record signatures above, then make the 6:00 go/no-go call.

## Integration requests (after devnet passes, not before)

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
