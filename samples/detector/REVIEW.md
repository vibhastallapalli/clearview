# Station detector integration review and handoff

## Status

Reviewed live GitHub heads on 2026-09-27:

- `integration/agreement`: `7b49a90855e8e5f7038aecde93a0d0a6b133f5fb`.
- `ai/detector`: `def012ffdaf2e662151459a0808a0586255dd363`.
- New branch: `ai/detector-csv`, based on the integration head above. `origin/main` is already its ancestor.

**The branch contains a tested CSV adapter, provisional Red Bull catalog/config, generated test documents, and an executable integration patch. The station route is NOT switched by the branch alone.** The patch contains the dependent route, shared contract/comparison, document extraction, and web claim changes. It was applied and tested in a separate preview. The branch's `shared/` files remain unchanged as requested. Do not deploy the adapter-only branch as if Gemini station analysis were disabled.

This separation follows AGENTS.md's shared-file ownership rule and the explicit request to propose contracts without merging them. No contract changes were merged. `integration-request.patch` is concrete implementation, not pseudocode; its first integration step requires integrator acceptance.

## Review findings

### P1: Gemini currently determines received quantities

[Station ingestion](https://github.com/vibhastallapalli/clearview/blob/7b49a90855e8e5f7038aecde93a0d0a6b133f5fb/server/src/index.ts#L117) calls `analyzeScan`, persists its output, sets `latestScanId`, and recomputes the comparison. Both authenticated `/station/captures` and `/dev/orders/:id/station-photo` reach it. [analyzeScan](https://github.com/vibhastallapalli/clearview/blob/7b49a90855e8e5f7038aecde93a0d0a6b133f5fb/server/src/ai/analyze.ts#L125) calls Gemini, falls back to an exact-image Gemini cache for transient failures, or uses mock counts without a key. These are all authoritative under the existing route.

**Change:** require detector CSV for both ingestion routes; reject a missing or bad CSV. Remove the Gemini photo prompt/schema/validator and make the old `analyzeScan` entry point reject without making a request. Restrict document extraction to PO/invoice. No optional Gemini photo fallback or cross-check.

### P1: No damage path; web claims lose the actual reason

`ObservedItem` has no condition; `compareOrder` treats every observed unit as acceptable. A damaged but present can can therefore match and contribute to `undisputedMinor`. [claimWrite](https://github.com/vibhastallapalli/clearview/blob/7b49a90855e8e5f7038aecde93a0d0a6b133f5fb/web/src/agreement/claim.ts#L8) hard-codes `reason: "missing"`, even when the buyer overrides a seen item because it is damaged. The shared `ClaimLine.reason` union and server validation already support `damaged`.

**Change:** retain per-item condition, aggregate present and damaged counts separately, and carry damage through comparison, unit review, and the signed claim. A present damaged can never becomes a missing can. Mixed shortage and damage retain both counts/amounts. Claimable damage is capped after crediting good units, so extra damaged cans cannot inflate a claim beyond ordered units.

### P1: Document warnings do not necessarily block comparison

The detector branch adds a printed-total mismatch warning, but [compareOrder](https://github.com/vibhastallapalli/clearview/blob/7b49a90855e8e5f7038aecde93a0d0a6b133f5fb/shared/src/compare.ts) does not use `warnings` or `totalMinor` to gate approval. Two identically misread documents can still match at an incorrect amount. The separate `ai/detector-total-guard` branch addresses lines exceeding the printed total but still allows a lower line sum with only a warning. It is a separate head, not part of `ai/detector` reviewed here.

**Change:** in the proposed extraction implementation, either direction of printed-total mismatch removes trusted SKU mappings and requires review. This deliberately sends tax/shipping/discount cases to review rather than inventing unsupported money rules. Pack multiplication must remain a safe integer; a case price that cannot divide exactly into integer cents requires review.

### P2: Provisional JSON adapter does not meet the CSV contract

[adaptDetections](https://github.com/vibhastallapalli/clearview/blob/def012ffdaf2e662151459a0808a0586255dd363/server/src/ai/detector.ts) only accepts `cleardock.detections.v0` JSON. There is no CSV parser, damage encoding, per-item identity, or Red Bull mapping. Multiple frames are compared by class totals, not tracked by physical item; equal totals cannot prove identical cans or conditions. It emits confidence `1` for accepted observations, losing the original confidence scores. Provenance combines model name/version and omits the image hash and row count from its returned detector object. Non-boolean `synthetic` values silently become false. Detection arrays are unbounded even though frame count is bounded.

Its `crossCheck` lets Gemini disagreement change `unreadable`, hence the comparison. That conflicts with the requested role even though it never adds Gemini counts to detector counts. Do not import it.

**Change:** strict UTF-8 CSV; configurable columns/delimiter/damage tokens; unique item IDs; bounded bytes and rows; finite 0..1 decimal confidence; complete single-frame metadata; exact order/image/CSV hash binding; configured model name/version; strict synthetic flag; row count agreement; duplicate class mappings rejected. Preserve each row and use the minimum accepted confidence for grouped observations. Malformed input throws before any result is returned. Valid uncertainty becomes `needs_info`.

### P2: Partial evidence can still look like confident shortages

Current comparison returns `needs_info` for unreadables but still emits numerical shortages. The web expands those into default claim selections. **Change:** a detector scan with uncertainty yields unknown observed quantities and no undisputed amount or suggested claim selections. A completed, explicitly empty tray can produce a full shortage; zero rows without that declaration require review.

### P2: Wallet-address check is not given its comparison input

`documentFlags` supports a verified wallet, but integration's `evidenceChanged` does not pass it. Any printed payment destination is therefore flagged as lacking a verified wallet, even when it matches the supplier. The proposed route patch passes the stored supplier wallet. Gemini still cannot change that wallet.

### Other existing limits to retain in the integration backlog

- Duplicate document lines with the same SKU are aggregated using the first unit price; later conflicting prices are not independently compared. Currency, order reference and generic warnings are not comprehensive comparison gates. Do not interpret schema validation as guaranteed correct document extraction.
- `/approve` is an unauthenticated app-state transition, not proof of owner identity. It does not move funds. Direct payment still requires a valid wallet signature.
- The claim API verifies the buyer's signature but trusts the signed `suggested`/decision descriptions; it does not recompute that claim audit trail from detector item IDs. It permits historical scans. This is a buyer assertion, not cryptographic proof of model output.
- Legacy stored Gemini scans are not rewritten by this patch. New comparison recomputations ignore them; new approvals/payment preparations and the web claim/acceptance preparation require detector evidence. Historical displays retain their source labels. Already signed transfers cannot be recalled; their existing verification/recovery paths remain available. Recapture legacy orders before starting new decisions.
- The default station token `change-me` is a demo default. Image/CSV hashes establish consistent binding, not that an honest camera/model produced the input. A station holding the token can fabricate both CSV and metadata.

## Every Gemini influence found

| Entry/output | Downstream effect | Authority boundary |
|---|---|---|
| PO/invoice `sku`, quantity, unit, package size, unit price | Deterministic tally, mismatch verdicts, billed total, undisputed value | Proposed payment amount depends on extracted facts; reviewer must inspect them |
| Document confidence or unknown SKU | Can make comparison require review | Cannot sign or approve |
| `paymentAddress`, `embeddedInstructions` | Blocking flags | Never replaces stored supplier wallet |
| `warnings`, printed total, currency/reference | Mostly displayed; not comprehensive current gates | Total gate strengthened in proposal |
| Gemini station `observed`, counts, unreadables | Authoritative latest scan, comparison, evidence revision, approval invalidation | Disabled for new captures in integration patch |
| Cached Gemini station results | Same effects as live counts, labelled cache | Disabled with the photo entry point |
| Missing API key | Labelled mock document/scan fixtures | No missing-key station fallback after patch |
| Extracted PO lines → `web/src/terms/terms.ts:initialDraft` | Initial proposed order terms and funding amount | Both parties approve current terms; buyer signs funding |
| Comparison → `scanLines` → `reviewedClaim` | Suggested accepted/claimed units and amounts | Buyer can override with a reason; buyer signs claim |
| Approval → direct payment attempt | Uses reviewed billed total, verified supplier, configured mint | Signed transaction intent checked before broadcast; chain receipt verified |
| Claim → escrow `claim` instruction | Releases accepted amount immediately and holds claimed amount | Buyer signature required; **filing a claim can release money** |
| Offers/settlement | Parties propose/accept a split; held total checked | Both buyer and supplier sign on-chain settlement |
| Phone photos | Stored raw with station-scan binding | No Gemini call; no count/comparison/payment mutation |

Inspected `server/src/ai/{analyze,gemini}.ts`, `server/src/{index,store,terms,agreement,escrow}.ts` relevant paths, `shared/src/{contracts,compare}.ts`, `web/src/{terms,escrow,agreement}` consumers, payment construction/verification paths and escrow `accept_all`, `claim`, `settle` source. This was not a full independent audit of every Solana instruction or production authentication.

## Concrete integration sequence

1. Integrator reviews **Contract change requested** below, then applies `integration-request.patch` onto this branch. It was checked against this exact integration base; recheck it if the base moves.
2. Keep the coffee catalog and add the two provisional 250 ml Red Bull variants. The patch combines shared coffee fixtures with `redbull.products.json`; it does not replace `shared/fixtures/products.json`. Volume is ml, never grams. Coffee class IDs equal the SKU only for synthetic regression inputs.
3. Hardware confirms the real labels/model/version and supplies the config file. Set `CLEARDOCK_DETECTOR_CONFIG` to its absolute path. Do not present the included synthetic config as the trained model's actual format.
4. Station posts multipart `orderId`, `image` file, `detectionsCsv` file, and `detectorMetadata` JSON text, with the station token. Byte-preserving CSV file upload is required: multipart text normalization can change hashes.
5. Route validates all input before persisting the capture or changing latest evidence. Existing evidence locks, revision bump and approval invalidation remain. Missing config returns 503; missing/malformed/misbound input returns 400. Unknown/low-confidence results persist as detector evidence requiring review, with no Gemini gap filling.
6. Run tests/typecheck/build and the live document eval. Recapture legacy Gemini orders. Test the real camera and trained model with held-out captures before claiming hardware accuracy. Review a damaged-can claim in the browser and rehearse devnet signing separately.

## Contract change requested

Exact TypeScript diffs are in `integration-request.patch`; shared files remain unchanged on this branch.

- `AnalysisSource`: add `"detector"`.
- `ObservedItem.damagedCount?: number`: subset of physically present `count`; integer `0 <= damagedCount <= count`. Absence means legacy data without reported damage, not evidence that a historical model checked damage.
- Add `DetectorMetadata`: `format: "cleardock.csv.v1"`, `orderId`, `imageSha256`, `csvSha256`, `model: { name, version }`, `rowCount`, `frames: 1`, `complete: true`, `emptyTray: boolean`, `synthetic: boolean`.
- Add `DetectorProvenance extends DetectorMetadata`: `mappingVersion`, `configSha256`, `catalogSha256`. These record the exact mapping used, not a calibrated confidence or model attestation.
- Add `DetectorItem`: `itemId`, `classId`, `sku: string | null`, `confidence`, `condition: "intact" | "damaged" | "unknown"`.
- `ScanResult`: optional `detector?: DetectorProvenance` and `items?: DetectorItem[]` for legacy compatibility. New detector route always supplies both. The local adapter types are provisional mirrors to let its tests compile before shared acceptance.
- `LineVerdict`: add `"damaged"`. `ComparisonLine`: add optional integer `damaged`, `missing`, `damagedMinor`, `missingMinor`. Mixed damage and shortage retain both; primary verdict remains missing when there is also shortage. `observed` includes damaged cans, `undisputedMinor` excludes them. Uncertain detector evidence uses `observed: null`.
- `ClaimLine.reason`: **no union change required**, `damaged` already exists. Fix the builder to preserve it. The existing signature serialization already includes the reason.
- HTTP: add the required CSV file/metadata fields and remove photo-only station fallback. Update CONTRACTS.md and shared fixtures together when the integrator adopts this proposal; include intact, damaged, mixed missing/damaged, unknown and explicit empty fixtures. Do not relabel detector output as Gemini/mock/cache to satisfy old types.

## Hardware questions

1. Send one real CSV and the exact headers, delimiter, quoting/encoding, item-ID field, and confidence range. Is each row a unique physical can?
2. What are the exact class strings for every Red Bull variant **and size**? Is a generic/unknown can a separate class?
3. How is damage encoded? Does it have its own confidence, and can the model return unknown/unassessed damage? The current proposal assumes row confidence covers both classification and condition.
4. Is one result one photo, or several frames? How are duplicate cans tracked across frames? The first adapter rejects multi-frame results.
5. Can the station reliably distinguish a completed empty tray from camera failure, occlusion, partial inference, or zero detections? Who sets `complete` and `emptyTray`?
6. What are model name/version, capture trigger, result-completion signal, and retry behavior? Can the station bind the selected order and SHA-256 of the exact uploaded image/CSV bytes before upload?

## Validation and limits

- Adapter: seven passing test groups, with multiple malformed/binding/config cases per group.
- Adapter-only branch with original shared contracts: 113 tests passed (12 shared, 73 server, 28 web), typecheck and production build passed. Its existing station behavior remains unchanged until the proposed integration patch is accepted.
- Separate integration preview: 114 tests passed (12 shared, 73 server, 29 web), typecheck passed, production build passed. Build retains the existing large-chunk warning.
- Covers missing, damaged, mixed missing/damaged, wrong variant, low confidence, unknown class/condition, malformed CSV, wrong order/image, hash mismatch, explicit/ambiguous empty trays, byte-preserving HTTP uploads, rejected-upload atomicity, no Gemini photo calls, phone-proof invariants, signed damage reason, and existing payment regressions.
- Red Bull PO and invoice PNGs are synthetic, generated by `generate_redbull.py`. Expected lines: Original 250 ml ×3 @250 cents; Sugarfree 250 ml ×2 @275 cents; total 1300 cents.
- Live Gemini eval: **not run; no API key in this task's environment**. After accepting the patch: `node --env-file=<private-env-file> --import tsx samples/detector/eval-redbull.mts`. It refuses mocks/cache as fresh live passes. Existing Gemini retry policy remains, so a transient failure may use more than one request per document.
- Real model accuracy, real CSV compatibility, physical damage detection, camera triggering, browser visual QA and a live wallet/escrow run are **unverified**. Synthetic parser tests are not detector accuracy measurements.

## GitHub branches inspected

GitHub listed 21 branches: `ai/detector`, `ai/detector-total-guard`, `ai/live`, `ai/phone-proof`, `ai/station-guard`, `design/glass`, `integration/agreement`, `integration/payments`, `integration/phone-proof`, `main`, `qa/phone-proof`, `sol/devnet`, `sol/escrow`, `sol/payments`, `ui`, `web/agreement`, `web/demo`, `web/escrow-live`, `web/phone-proof`, `web/securoserv-v2`, `web/ux-escrow-scan`. All six listed PRs were open; none was for `ai/detector`. The detector branch adds eight commits beyond the integration branch's ancestry, with 16 changed files. Other branches were inventoried, not exhaustively code-reviewed.
