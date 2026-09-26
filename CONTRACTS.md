# Contracts

Source of truth: [`shared/src/contracts.ts`](shared/src/contracts.ts). This page is the readable version.
Example data: [`shared/fixtures/`](shared/fixtures). If you change a shape, change all three in one PR.

## Conventions

- Money: integer cents, fields end in `Minor` (`unitPriceMinor: 1000` = $10.00).
- Time: ISO 8601 UTC strings.
- Mocked or simulated data says so: `extractedBy: "mock"`, `analyzedBy: "mock"`, `simulated: true`.
- AI outputs `sku: null` when it can't map a product. It never guesses.

## Core objects

| Object | Made by | Key fields |
|---|---|---|
| `Supplier` | seed data | `walletAddress` (verified; AI can never change it), `verified` |
| `ExtractedDocument` | AI (`analyzeDocument`) | `kind`, `lines[]`, `language`, `warnings[]`, `extractedBy` |
| `ExtractedLine` | AI | `sku`, `quantity`, `unit` (`bag`/`box`/`unit`/`g`/`kg`), `unitSizeGrams`, `unitPriceMinor`, `sourceText`, `confidence` |
| `CaptureSession` | server | `code` (in the QR URL), `expiresAt` (15 min) |
| `Capture` | server, from station or phone | `source`, `imageUrl`, `imageSha256`, `sensors[]` |
| `SensorReading` | hardware | `kind: "weight"`, `grams`, `simulated` |
| `ScanResult` | AI (`analyzeScan`) | `observed[]` (`sku`, `labelText`, `count`), `unreadable[]`, `analyzedBy` |
| `Comparison` | **code** (`compareOrder`) | `outcome` (`match`/`discrepancy`/`needs_info`), `lines[]`, `undisputedMinor`, `evidenceRevision` |
| `Approval` | owner | `evidenceRevision`, `recipient`, `amountMinor` |
| `Payment` | server + wallet | `status`, `idempotencyKey`, `signature`, `network: "devnet"` |
| `Order` | server | `status`, `evidenceRevision`, `comparison`, `approval`, `payment` |

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
| GET | `/orders` | | `Order[]` (+ `supplierName`) |
| GET | `/orders/:id` | | `OrderDetail` |
| POST | `/orders/:id/documents` | multipart `kind`, `file` | `OrderDetail` |
| POST | `/orders/:id/capture-sessions` | | `{ session, url }` (put `url` in the QR) |
| GET | `/capture-sessions/:code` | | `{ session, orderReference }` |
| POST | `/capture-sessions/:code/captures` | multipart `image`, `mockScenario?` | `{ capture, scan, order }` |
| POST | `/station/captures` | header `x-station-token`; multipart `orderId`, `image`, `weightGrams?`, `simulated?`, `mockScenario?` | `{ capture, scan, order }` |
| POST | `/orders/:id/approve` | `{ evidenceRevision }` | `OrderDetail`, or 409 `stale_approval` |
| POST | `/orders/:id/payments` | | `OrderDetail` (idempotent per approval) |
| POST | `/orders/:id/payments/confirm` | `{ signature }` | **501 until built** |
| POST | `/dev/reset` | | reseeds demo data |

## Phase 2 (types exist, nothing built)

`Claim`, `ClaimLine`, `SettlementOffer`, `SettlementKind`. Rules: [docs/escrow-rulebook.md](docs/escrow-rulebook.md). Key invariant: `toSupplierMinor + toBuyerMinor` equals the locked amount, both signatures required.
