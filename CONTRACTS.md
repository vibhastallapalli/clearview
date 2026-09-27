# Contracts

Source of truth: [`shared/src/contracts.ts`](shared/src/contracts.ts). This page is the readable version.
Example data: [`shared/fixtures/`](shared/fixtures). If you change a shape, change all three in one PR.

## Conventions

- Money: integer cents, fields end in `Minor` (`unitPriceMinor: 1000` = $10.00).
- Time: ISO 8601 UTC strings.
- Token: **CDT** (ClearDock test dollars), a classic SPL token on devnet with 2 decimals, so token base units == cents. Never called USDC.
- Mocked or simulated data says so: `extractedBy: "mock"`, `analyzedBy: "mock"`, `simulated: true`.
- AI outputs `sku: null` when it can't map a product. It never guesses.

## Core objects

| Object | Made by | Key fields |
|---|---|---|
| `Supplier` | seed data | `walletAddress` (verified; AI can never change it), `verified` |
| `ExtractedDocument` | AI (`analyzeDocument`) | `kind`, `lines[]`, `language`, `warnings[]`, `extractedBy` (`gemini`/`mock`/`cache`); v2: `source.url?`, `paymentAddress?`, `embeddedInstructions?` |
| `ExtractedLine` | AI | `sku`, `quantity`, `unit` (`bag`/`box`/`unit`/`g`/`kg`), `unitSizeGrams`, `unitPriceMinor`, `sourceText`, `confidence` |
| `CaptureSession` | server | `code` (in the QR URL), `expiresAt` (15 min) |
| `Capture` | server, from station or phone | `source`, `imageUrl`, `imageSha256`, `sensors[]` |
| `SensorReading` | hardware | `kind: "weight"`, `grams`, `simulated` |
| `ScanResult` | AI (`analyzeScan`) | `observed[]` (`sku`, `labelText`, `count`), `unreadable[]`, `analyzedBy` |
| `Comparison` | **code** (`compareOrder`) | `outcome` (`match`/`discrepancy`/`needs_info`), `lines[]`, `undisputedMinor`, `evidenceRevision`; v2: `flags?` (non-empty ⇒ `needs_info`) |
| `Approval` | owner | `evidenceRevision`, `recipient`, `amountMinor` |
| `Payment` | server + wallet | `status` (`awaiting_signature`/`submitted`/`confirmed`/`failed`/`unknown`), `recipient`, `amountMinor`, `mint`, `payer`, `lastValidBlockHeight`, `memo`, `signature`, `error`, `idempotencyKey`, `network: "devnet"` |
| `Order` | server | `status`, `evidenceRevision`, `comparison`, `approval`, `payment`, `escrow` (always `null` until Phase 2) |
| `PublicConfig` | server (`GET /config`) | `network`, `rpcUrl`, `mint`, `decimals: 2`, `tokenLabel`, `escrowProgramId` |
| `PaymentTransaction` | server | `transaction` (base64, unsigned), `lastValidBlockHeight` |

### Line verdicts

`match` · `missing` · `over` · `unexpected` · `billed_mismatch` · `price_mismatch` · `unknown`

### Order statuses

`needs_documents` → `analyzing` → `discrepancy` | `needs_info` | `ready_for_review` → `approved` → `awaiting_signature` → `payment_submitted` → `payment_confirmed` (or `payment_failed`)

## Core example (from the brief), as data

- PO: 3 × PROD-A bag, 500 g, $10 → `purchase_order.json`
- Invoice (Spanish): 1.5 kg PROD-A at $10/bag → `invoice.json` (code converts 1.5 kg ÷ 500 g = 3 bags)
- Delivery: 2 × PROD-A + 1 × PROD-B → `scan_core_example.json`
- Result: PROD-A `missing` ($10 at stake), PROD-B `unexpected`, `undisputedMinor: 2000`, outcome `discrepancy`

## HTTP API

Base `/api`. Errors are `{ error, code }` with `code` one of `not_found`, `bad_request`, `unauthorized`, `conflict`, `stale_approval`, `not_implemented`, `upstream_error`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | | `{ ok, ai: "gemini" \| "mock" }` |
| GET | `/config` | | `PublicConfig` |
| GET | `/orders` | | `Order[]` (+ `supplierName`) |
| GET | `/orders/:id` | | `OrderDetail` |
| POST | `/orders/:id/documents` | multipart `kind`, `file` | `OrderDetail` |
| POST | `/orders/:id/capture-sessions` | | `{ session, url }` (put `url` in the QR) |
| GET | `/capture-sessions/:code` | | `{ session, orderReference }` |
| POST | `/capture-sessions/:code/captures` | multipart `image`, `mockScenario?` | `{ capture, proof, order }`. **Phone proof**, see below. 409 `conflict` if the order has no station scan yet |
| POST | `/station/captures` | header `x-station-token`; multipart `orderId`, `image`, `weightGrams?`, `simulated?`, `mockScenario?` | `{ capture, scan, order }`. The **authoritative** delivery scan: sets `latestScanId`, recomputes the comparison, bumps `evidenceRevision`, voids approval |
| POST | `/orders/:id/approve` | `{ evidenceRevision }` | `OrderDetail`, or 409 `stale_approval` |
| POST | `/orders/:id/payments` | | `OrderDetail` (idempotent per approval; 409 if `DEMO_TOKEN_MINT` unset) |
| POST | `/orders/:id/payments/transaction` | `{ payer }` | `PaymentTransaction`: **unsigned**. 409 if approval stale, payment submitted/confirmed/unknown, or another wallet's tx could still land; 503 if RPC down |
| POST | `/orders/:id/payments/submit` | `{ transaction }` (base64, **signed** by the buyer's wallet) | `OrderDetail`. Server checks it against the issued attempt, records the signature, broadcasts, then verifies. 409 (not broadcast) if the blockhash, fee payer or instructions changed |
| POST | `/orders/:id/payments/confirm` | `{ signature }` | `OrderDetail`: re-check a submitted payment. 409 on mismatch, reused or unknown signature |
| POST | `/orders/:id/escrow/events` | `{ action: "fund"|"accept_all"|"claim"|"settle", signature, escrowAddress? }` (`escrowAddress` required on the first event) | `OrderDetail` with `order.escrow` read from chain. Verifies the tx ran that instruction of `ESCROW_PROGRAM_ID` on that escrow, and the escrow account's order hash = `sha256(reference)`, supplier = verified wallet, mint = `DEMO_TOKEN_MINT`, buyer = `DEMO_BUYER_WALLET`. Same signature again = refresh. 409 on any mismatch; 501 if `ESCROW_PROGRAM_ID` unset |
| POST | `/dev/reset` | | `{ ok, orderId, reference }`. Fresh demo order. An order that had a payment transaction is archived and the next one gets a new identity (`ord_1001_r2` / `PO-1001-R2`). 409 while a transaction could still land |

## Phone proof (station result stays authoritative)

- **Station scans decide.** Only `/station/captures` sets `order.latestCaptureId`/`latestScanId` and the comparison (the discrepancy).
- **Phone photos are proof.** `/capture-sessions/:code/captures` stores the photo as a `PhoneProof` tied to the current station scan (`stationScanId`, `evidenceRevision`). It never changes `latestScanId`, `comparison`, `evidenceRevision`, `status`, `approval`, `payment` or `escrow`, and it is allowed after payment.
- **Assessment.** The server runs the scan model on the phone photo, then **code** compares its per-product counts with the station scan: `agrees`, `differs` or `unreadable`. `status` is `pending` → `complete`, or `failed` (with `error`) if the model call fails; the photo is kept either way. Mock AI results have `analyzedBy: "mock"` and must be labelled.
- **Stale proof.** A later station scan does not rewrite old proofs. A proof whose `stationScanId !== order.latestScanId` was assessed against an earlier station scan; show it as such.
- **Retrieval.** `GET /orders/:id` returns `proofs: PhoneProofView[]` (newest first, each with its `capture.imageUrl`). Buyer and supplier read the same endpoint; there are no per-role views yet.
- Photos taken before this change keep whatever they set at the time. Nothing is migrated or deleted.

## Payment flow (server ↔ web)

1. `POST /approve { evidenceRevision }` → order `approved`.
2. `POST /payments` → payment `awaiting_signature` with `recipient`, `amountMinor`, `mint`, `memo`.
3. `POST /payments/transaction { payer }` → unsigned tx: create supplier ATA (idempotent) · `transferChecked` of `amountMinor` CDT · memo `ClearDock <PO> <paymentId>`. Buyer is fee payer and only signer; the server never signs. The same wallet asking again while the blockhash is valid gets the **same bytes**, so double clicks and retries after a wallet rejection can land at most once.
4. Web: `Transaction.from(bytes)` → wallet adapter **`signTransaction`** (sign only; never `sendTransaction`) → `POST /payments/submit { transaction: base64(signed.serialize()) }`. The server refuses to broadcast if the wallet changed the blockhash, fee payer or instructions (compute-budget additions are allowed), records the signature, then broadcasts.
5. The server (and later `POST /payments/confirm { signature }`) fetches
6. `submitted` = not found yet: POST `/confirm` with the same signature again. `unknown` = broadcast response lost or RPC unreachable, or a transaction with our memo landed with a foreign blockhash (then manual review: no retry is possible). `failed` + `error` = rejected before broadcast, landed wrong, failed on-chain, or expired without landing. A *new* transaction is only issued once the previous one's blockhash has expired and it provably didn't land.
7. Explorer: `https://explorer.solana.com/tx/<signature>?cluster=devnet`.

**Evidence changes after a transaction is issued.** A signed transfer can't be recalled. Document and capture uploads return 409 while an issued transaction could still land (until its `lastValidBlockHeight` passes, about 60–90 s, and the server has checked it didn't land), and always once the payment is `submitted`, `unknown` or `confirmed`. A confirmed payment stays confirmed; later problems go to Phase 2 claims.

**Signing policy (why sign-only).** Expiry is only provable for the blockhash ClearDock issued. A wallet that sends the transaction itself may re-blockhash it, and the new copy stays valid after ours expires. So only `/payments/submit` is supported. A transaction carrying our memo that lands with another blockhash freezes the payment (`unknown`) instead of allowing a retry. Rejecting a transaction in the server never un-sends one already on-chain.

**Recovering an unreported transaction.** Before an expired attempt is released, the server pages through the buyer CDT account's signatures back to the issue time and fetches any that carry the payment memo. If it can't reach the issue time (RPC down, more than 500 buyer transactions), the attempt stays open. Attempts live in `server/data/db.json`, so they survive restarts and `POST /dev/reset` (which archives orders instead of reusing their identity). Deleting that file removes the protection. To rehearse another payment, call `POST /dev/reset` and use the returned `orderId` (e.g. `python station.py --order ord_1001_r2`).

**Approval gates.** Only `outcome: "match"` with no `flags`, a verified supplier, and a supplier wallet equal to `DEMO_SUPPLIER_WALLET` when that is set.

**Config.** `DEMO_TOKEN_MINT` is the only mint setting; the browser gets it from `GET /config`. `DEMO_SUPPLIER_WALLET` seeds the supplier's wallet.

## Escrow (Phase 2, program on devnet)

Program `ESCROW_PROGRAM_ID` (also in `GET /config` as `escrowProgramId`). The escrow PDA is `["escrow", buyer, sha256(order.reference)]`, the vault is `["vault", escrow]`. The browser builds and signs escrow transactions (see `solana/escrow`), then reports each one to `/escrow/events`. An order with an escrow can't also be paid directly (`/payments` → 409), and a demo reset archives it (the reference is single-use because the PDA is keyed by it).

## Phase 2 (types exist, nothing built)

`EscrowRecord`, `Claim`, `ClaimLine`, `SettlementOffer`, `SettlementKind`. Rules: [docs/escrow-rulebook.md](docs/escrow-rulebook.md). Key invariant: `toSupplierMinor + toBuyerMinor` equals the locked amount, both signatures required.
