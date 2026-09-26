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
| POST | `/capture-sessions/:code/captures` | multipart `image`, `mockScenario?` | `{ capture, scan, order }` |
| POST | `/station/captures` | header `x-station-token`; multipart `orderId`, `image`, `weightGrams?`, `simulated?`, `mockScenario?` | `{ capture, scan, order }` |
| POST | `/orders/:id/approve` | `{ evidenceRevision }` | `OrderDetail`, or 409 `stale_approval` |
| POST | `/orders/:id/payments` | | `OrderDetail` (idempotent per approval; 409 if `DEMO_TOKEN_MINT` unset) |
| POST | `/orders/:id/payments/transaction` | `{ payer }` | `PaymentTransaction`: **unsigned**. 409 if approval stale, payment submitted/confirmed/unknown, or another wallet's tx could still land; 503 if RPC down |
| POST | `/orders/:id/payments/confirm` | `{ signature }` | `OrderDetail`, payment `submitted` / `confirmed` / `failed` / `unknown`. Same signature again = re-check. 409 on mismatch or reused signature |
| POST | `/dev/reset` | | reseeds demo data |

## Payment flow (server ↔ web)

1. `POST /approve { evidenceRevision }` → order `approved`.
2. `POST /payments` → payment `awaiting_signature` with `recipient`, `amountMinor`, `mint`, `memo`.
3. `POST /payments/transaction { payer }` → unsigned tx: create supplier ATA (idempotent) · `transferChecked` of `amountMinor` CDT · memo `ClearDock <PO> <paymentId>`. Buyer is fee payer and only signer; the server never signs. The same wallet asking again while the blockhash is valid gets the **same bytes**, so double clicks and retries after a wallet rejection can land at most once.
4. Web: `Transaction.from(Buffer.from(transaction, "base64"))` → wallet adapter `sendTransaction`.
5. `POST /payments/confirm { signature }`. Server fetches the tx at `confirmed` and checks: success; recentBlockhash of an issued attempt; buyer is fee payer, signer and transfer authority; exactly one `transferChecked` of the configured mint, 2 decimals, exact amount, buyer ATA → verified supplier ATA; supplier ATA owned by the supplier with exactly that balance delta; the memo. The memo alone never confirms.
6. `submitted` = not found yet, POST the same signature again. `unknown` = RPC unreachable, POST again. `failed` + `error` = landed wrong, failed on-chain, or expired without landing; a new transaction may then be issued.
7. Explorer: `https://explorer.solana.com/tx/<signature>?cluster=devnet`.

**Evidence changes after a transaction is issued.** A signed transfer can't be recalled. Document and capture uploads return 409 while an issued transaction could still land (until its `lastValidBlockHeight` passes, about 60–90 s, and the server has checked it didn't land), and always once the payment is `submitted`, `unknown` or `confirmed`. A confirmed payment stays confirmed; later problems go to Phase 2 claims.

## Phase 2 (types exist, nothing built)

`EscrowRecord`, `Claim`, `ClaimLine`, `SettlementOffer`, `SettlementKind`. Rules: [docs/escrow-rulebook.md](docs/escrow-rulebook.md). Key invariant: `toSupplierMinor + toBuyerMinor` equals the locked amount, both signatures required.
