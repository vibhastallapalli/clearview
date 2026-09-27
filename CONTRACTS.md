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
| POST | `/capture-sessions/:code/captures` | multipart `image`, `kind?` (`live` from the in-app camera; anything else is stored as `upload`) | `{ capture, proof, order }`. **Phone proof**, see below. 409 `conflict` if the order has no station scan yet |
| POST | `/station/captures` | header `x-station-token`; multipart `orderId`, `image`, `weightGrams?`, `simulated?`, `mockScenario?`, `fixture?` | `{ capture, scan, order }`. `fixture` (a sample path) marks a test image: stored as `capture.fixture`, label it SIMULATED. The **authoritative** delivery scan: sets `latestScanId`, recomputes the comparison, bumps `evidenceRevision`, voids approval. YOLO count fields (`totalCount`, `normalCount`, `damagedCount`) are **disabled this release**: malformed or inconsistent counts get 400; valid ones get 503 `not_implemented` and nothing is stored (they name no confirmed product class, so they are never mapped to a SKU or passed to Gemini) |
| POST | `/orders/:id/approve` | `{ evidenceRevision }` | `OrderDetail`, or 409 `stale_approval` |
| POST | `/orders/:id/payments` | | `OrderDetail` (idempotent per approval; 409 if `DEMO_TOKEN_MINT` unset) |
| POST | `/orders/:id/payments/transaction` | `{ payer }` | `PaymentTransaction`: **unsigned**. 409 if approval stale, payment submitted/confirmed/unknown, or another wallet's tx could still land; 503 if RPC down |
| POST | `/orders/:id/payments/submit` | `{ transaction }` (base64, **signed** by the buyer's wallet) | `OrderDetail`. Server checks it against the issued attempt, records the signature, broadcasts, then verifies. 409 (not broadcast) if the blockhash, fee payer or instructions changed |
| POST | `/orders/:id/payments/confirm` | `{ signature }` | `OrderDetail`: re-check a submitted payment. 409 on mismatch, reused or unknown signature |
| POST | `/orders/:id/escrow/events` | `{ action: "fund"|"accept_all"|"claim"|"settle", signature, escrowAddress? }` (`escrowAddress` required on the first event) | `OrderDetail` with `order.escrow` read from chain. Verifies the tx ran that instruction of `ESCROW_PROGRAM_ID` on that escrow, and the escrow account's order hash = `sha256(reference)`, supplier = verified wallet, mint = `DEMO_TOKEN_MINT`, buyer = `DEMO_BUYER_WALLET`. Same signature again = refresh. 409 on any mismatch; 501 if `ESCROW_PROGRAM_ID` unset |
| POST | `/dev/orders/:id/sample-proof` | `{ sample: "all_correct" \| "one_missing" \| "swapped" \| "label_covered" }` | `{ capture, proof, order }`. **Test aid, not for deployment** (like `/dev/reset`). Attaches that synthetic tray photo as an uploaded file (`kind: "upload"`) with `capture.fixture` set (label it SIMULATED). Same rules and 409 as a phone capture |
| POST | `/dev/reset` | | `{ ok, orderId, reference }`. Fresh demo order. An order that had a payment transaction is archived and the next one gets a new identity (`ord_1001_r2` / `PO-1001-R2`). 409 while a transaction could still land |

## Phone proof (station result stays authoritative)

- **Station scans decide.** Only `/station/captures` sets `order.latestCaptureId`/`latestScanId` and the comparison (the discrepancy). Gemini reads documents and station photos; code does the comparison.
- **Phone photos are raw proof for the supplier.** `/capture-sessions/:code/captures` stores the photo as a `PhoneProof` tied to the current station scan (`stationScanId`, `stationCaptureId`, `evidenceRevision`) and to the exact bytes (`imageSha256`). **No AI reads or labels it**: an AI verdict next to a photo would lend credibility to a doctored image. The supplier judges it. It never changes `latestScanId`, `comparison`, `evidenceRevision`, `status`, `approval`, `payment` or `escrow`, and it is allowed after payment.
- **Live photo vs additional evidence.** `kind: "live"` = taken with the in-app camera; `kind: "upload"` = a file picked on the device (screenshot, earlier photo, document): shown separately as "Additional evidence · uploaded files". The server stores `"live"` only when the request says exactly `kind=live`; anything else is `"upload"`. `kind` is **reported by the capture page, not cryptographically attested**; a modified client could mislabel an upload as live. Proofs saved before `kind` existed are treated as uploads.
- **Stale proof.** A later station scan does not rewrite old proofs. A proof whose `stationScanId !== order.latestScanId` was attached to an earlier station scan; show it as historical.
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

## Order terms (agreed before funding)

Separate from the settlement agreement below. Types: `OrderTerms`, `OrderTermsState`, `ORDER_TERMS_RULES`, `canonicalTerms`, `termsHashOf`, `orderTermsMessage`, `TERMS_PATHS` in `shared/src/contracts.ts`.

| Method + path (under `/api/orders/:id/terms`) | Body | Wallet signature |
|---|---|---|
| `GET` | – | – |
| `POST /preview` | `{ lines, inspectionHours }` → `{ version, terms, termsHash }`, changes nothing | – |
| `POST /propose` | `{ as, expectedRevision, lines, inspectionHours, walletSignature }` | proposer; counts as their approval |
| `POST /approve` | `{ as, version, termsHash, walletSignature }` | approver |

1. **What is signed.** The server builds the terms from its own facts (reference, program, mint, `DEMO_BUYER_WALLET`, verified supplier wallet) plus the proposed `lines` and `inspectionHours`, and the fixed `ORDER_TERMS_RULES`. `termsHash` = sha256 of `canonicalTerms`. Each party signs `orderTermsMessage(orderId, version, termsHash, terms)`, so a signature for one version never approves another.
2. **Versions.** Any proposal is a new version carrying only its proposer's approval. `agreed` = both approved the current version and no order fact changed since (else `stale`, with `staleReason`). Proposals carry `expectedRevision` (409 if stale; the same signed proposal again is not applied twice).
3. **Funding gate (server).** The first escrow event that links an escrow to the order (`/escrow/events`) is refused unless the terms are `agreed` and the chain escrow's `terms_hash`, total, mint, buyer and supplier equal the agreed terms. Linking freezes them (`funded`): no new versions or approvals. Later escrow events must still match the funded terms. The web fund path reads the terms fresh and passes `termsHash` as the program's `terms_hash`.
4. **What the program does and doesn't enforce.** `fund` stores `terms_hash` but doesn't check any signature (only the buyer signs `fund`). A buyer can fund directly on-chain with any hash; ClearDock then won't link that escrow to the order. Its funds can still only leave through the program's normal instructions (supplier payouts, or a settle both sign). Inspection window: starts at the first station scan after funding; **not enforced**, no automatic release or refund, no arbitration.
5. **Legacy.** An escrow linked before order terms existed shows `legacy`: nobody signed terms for it. Its events keep working; nothing is backfilled.
6. **Remedies ("what happens if you get it wrong").** `terms.remedies` is a signed refund percentage (0–100, whole) of a claimed line's price per issue: `missing`, `damaged`, `wrong_item`. Omitted in a proposal = `DEFAULT_REMEDIES` (100/100/100), shown in the preview and so still signed. After a claim is filed on an order funded with signed terms, `AgreementState.remedy` = `remedyDefault(...)`: per line floor(price × percent / 100) to the buyer, the rest of the held amount to the supplier. It is null for reason `other`, for legacy orders, and for terms signed before schedules existed (rules v1). It is the default settlement offer, not an automatic payout: moving held money still takes both signatures, and an offer refunding less than `remedy.toBuyerMinor` should be shown as departing from the signed terms.

## Dispute chat

Types: `ChatMessage`, `ChatState`, `ChatSession`, `ChatAssist`, `chatSessionMessage`, `numbersPreserved`, `CHAT_PATHS`.

| Method + path (under `/api/orders/:id/chat`) | Body | Auth |
|---|---|---|
| `GET` | – | – |
| `POST /session` | `{ as, issuedAt, nonce, walletSignature }` → `{ token, as, wallet, expiresAt }` | wallet signs `chatSessionMessage`; `issuedAt` within 10 min; nonce single-use |
| `POST /messages` | `{ text, aiAssisted }` | `Authorization: Bearer <token>` |
| `POST /assist` | `{ draft }` → `{ text, model, used, note }` | bearer token |

Messages are free text labelled with the signed-in party and wallet; they never move money or make offers. Text starting with `/` is refused: the web app parses `/offer`, `/counter`, `/accept`, `/reject` in code and sends them as wallet-signed agreement writes. `/assist` rewords a draft with `GEMINI_CHAT_MODEL` (default `gemini-3.1-flash-lite`); a rewrite that adds or changes any number is discarded (`used: false`). 501 without `GEMINI_API_KEY`. Sessions last 12 h; only token hashes are stored.

## Agreement (negotiating a claimed amount)

Types: `AgreementState`, `AgreementWrite`, `agreementMessage()`, `AGREEMENT_PATHS` in `shared/src/contracts.ts`. Every endpoint returns the whole `AgreementState`. Amounts are integer CDT minor units. Rules: [docs/escrow-rulebook.md](docs/escrow-rulebook.md). Key invariant: `toSupplierMinor + toBuyerMinor` equals the held amount, both settle signatures required.

| Method + path (under `/api/orders/:id/agreement`) | Body | Wallet signature |
|---|---|---|
| `GET` | – | – |
| `POST /claim` | `prepare_claim` write | buyer |
| `POST /claim/confirm` | `{ claimSignature }` | none: the claim tx is verified on devnet |
| `POST /offers` | `propose` write (a counter sets `replacesOfferId` to the open offer) | proposer |
| `POST /offers/:offerId/accept` · `/reject` | `accept` / `reject` write with the reviewed `version` and amounts | responder |
| `POST /settlement` | `record_settlement` write; a known `{ signature }` alone re-checks it | reporter (new signatures only) |

1. **Identity.** The body is the write plus `walletSignature`: base64 of Phantom `signMessage(agreementMessage(orderId, write))` (`web/src/wallet/phantom.ts` `signMessage`). The server verifies it against `order.escrow.buyer` / `.supplier`, which are set only from verified chain state. `as` alone is never trusted. Wrong or missing signature → 401. This proves which wallet acted, not which person or device.
2. **Claim.** Save the reviewed claim (station `scanId`, lines, `claimedMinor`, `proofIds`) *before* signing the on-chain claim, then call `/claim/confirm` with its signature. Any browser can then read the lines from `GET`. Confirm verifies program, escrow, `Claim` instruction and order binding, and requires the chain's `claimedMinor` to equal the saved claim. A filed claim can't change and is never rebuilt from a newer scan. `decisions` lists every reviewed line: the scan's `suggested` (seen → accept, not seen → claim) next to the buyer's `decided`; an override needs `overrideReason`, a followed suggestion must not have one, and the lines decided as claim must add up to `claimedMinor`. The scan recommends; the buyer confirms.
3. **Revisions.** Writes carry `expectedRevision`; a stale one gets 409 `conflict`. The same signed write sent again after it was applied returns the current state without applying it twice.
4. **Offers.** The split must equal exactly what the verified claim holds, and the escrow must still be `claimed`. `full_refund` = 0 to supplier, `full_release` = 0 to buyer, `split` = both > 0. Only the other party can counter, accept or reject an open offer. Superseded, rejected and accepted offers can't be answered. Accepting creates `settlement.status = "awaiting_signatures"`: nothing has moved.
5. **Settlement.** A new signature is saved as `submitted` *before* any devnet call. While one is `submitted` or `unknown`, another is refused (409). Re-check: not found and within `lastValidBlockHeight` → `submitted`; past it, never seen, and the escrow still holds the full amount → `failed`; failed on-chain, or not a `Settle` of this escrow → `failed`; RPC error, or settled with other amounts → `unknown`; chain shows exactly the agreed split → `confirmed` (also recorded as the escrow `settle` event). Every reported signature stays in `settlement.attempts`. Only `failed` allows a fresh transaction (fresh signatures).
6. **Not built.** Withdrawing an offer, renegotiating after acceptance, replacement/return logistics, moving partial settle signatures between devices (both are collected on one computer), auth on `GET`.
