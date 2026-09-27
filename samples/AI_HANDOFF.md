# Gemini receiving handoff — 2026-09-26

## Scope and branch evidence

Isolated checkout: `C:/Users/athav/clearview/.worktrees/ai-live`, branch `ai/live`.
Fetched remote tips: AI `834f38a`, receiving/escrow UI `608a567`, main `da6476c`.
Continued the existing implementation. No changes to web, shared contracts,
comparison code, server routes, payment code, active services, or integration data.
The attached team plan's multi-batch interface is a proposal, not the current API.

The smallest integration gap is in the newer receiving UI:
`web/src/escrow/DemoProvider.tsx:75` completes a timer after 2400 ms without
uploading anything. Its load function also completes interrupted scans on reload.
`scanned()` in `web/src/escrow/demo.ts` adds a fixed "Gemini saw 2 × Product A
and 1 × Product B" event. Neither is evidence from Gemini.

## What changed in this handoff

- Validate scan counts, labels, confidence, unreadable list and notes before use.
  Confidence below 0.8 is a conservative review gate, not a calibrated probability:
  preserve the observation with null SKU and an explicit uncertainty entry.
- Reject missing document safety fields and empty extraction; uncertain document
  lines, fractional package quantities and unsafe integer prices remain unknown.
  Document source hashes are computed from actual bytes.
- Validate before writing cache; only transient failures (network, timeout, 429,
  5xx) may fall back. Blocked, incomplete, invalid JSON and invalid structured
  responses cannot fall back. Authentication/configuration errors stay errors.
- Cache identity includes actual bytes, MIME type, model, prompt, schema and a
  validation-version marker. Old cache entries are intentionally not reused.
  Cache reads are revalidated and new capture IDs are preserved.
- Add regression tests and an isolated HTTP smoke-test script in samples.

## Actual evidence, not the previous headline

The historical `docs/ai-eval.md` claims 57/57 checks on five synthetic documents
and deterministic comparisons. Its four real delivery-photo cases were skipped.
Synthetic tray drawings were added later under `photos/synthetic/`; they are not
camera photos. No real delivery photos are present.

This session's live evaluation used `gemini-3.8-flash`:

| Evidence | Result |
| --- | --- |
| English synthetic PO PDF | 10 checks passed, fresh Gemini, 16.7 s |
| Spanish synthetic invoice PNG | 10 checks passed, fresh Gemini, 4.5 s |
| Their deterministic comparison with fixture delivery | 1 check passed, match |
| Wrong-price, wrong-quantity, injection documents | 3 extraction failures: HTTP 429 after retries |
| Four synthetic tray drawings | 4 scan failures: HTTP 429 after retries |
| Comparisons dependent on failed extractions | 3 skipped |
| Four real delivery photos | 4 skipped: not supplied |
| Total | **21/28 executed checks passed; 7 failed; 7 skipped; exit 1** |

This is not a successful live scan evaluation. HTTP 429 does not establish
whether the quota is per-minute or daily; inspect the key's project in AI Studio.
The existing evaluation spaces samples by only four seconds and retries at 2/5 s.

The HTTP smoke test with explicitly MOCK analysis passed document uploads and
three capture scenarios: match, swapped/discrepancy, covered/needs_info. It checked
source labels, capture/scan identity, incremented revision, null approval/payment,
and the refreshed order. Missing-only is skipped in mock mode because there is no
corresponding mock scenario. This verifies plumbing, not Gemini vision.
The live HTTP smoke test failed honestly at document upload with HTTP 502
`upstream_error`; no capture success is claimed.

Automated validation: `npm test`, `npm run typecheck`, `npm run build`.
Tests include shared comparison cases and server payment safety tests plus AI
regressions for malformed output, uncertain observations, ignored authority fields,
authentication/blocked/JSON errors, same-image cache, different-image rejection,
caller-supplied hash reuse, unsafe document values and explicit mock provenance.
Tests use stubbed Gemini transport, not a live model. No payment was submitted.

## Existing HTTP contract — frontend owner

All paths start with `/api`:

1. `POST /orders/:id/capture-sessions`, no body, returns HTTP 201
   `{ session: { id, orderId, code, createdAt, expiresAt }, url }`.
   Session expires after 15 minutes; `url` opens the existing phone capture page.
2. `POST /capture-sessions/:code/captures`, multipart FormData field `image`
   containing the actual JPEG/PNG File or Blob. Browser sets the multipart boundary;
   do not manually set Content-Type. Optional `mockScenario` is only for labelled
   mock mode (`match`, `core`, `unreadable`); omit it for live use.
3. Alternative station endpoint: `POST /station/captures`, header
   `x-station-token`, multipart `orderId`, `image`, optional `weightGrams`,
   `simulated` (`"true"`), `mockScenario`. Do not expose the station token in web code.
4. Success is HTTP 201:

   ```ts
   {
     capture: { id, orderId, sessionId, source, imageUrl, imageSha256, capturedAt, sensors },
     scan: {
       id, orderId, captureId, analyzedAt, analyzedBy,
       observed: [{ sku, labelText, count, confidence }], unreadable: string[], notes
     },
     order: { order, supplier, documents, latestCapture, latestScan } // OrderDetail!
   }
   ```

   The wrapper's `order` is an OrderDetail, not the bare Order. Render
   `response.order.order.comparison`; its outcomes are `match`, `discrepancy`,
   `needs_info`. Never generate comparison rows from local demo constants.
5. `GET /orders/:id` returns OrderDetail. Existing OrderPage polls every 2 seconds.
   After upload replace detail with `response.order`, then refetch; on phone capture
   let polling pick up the new evidence revision. Ignore older/out-of-order fetch
   responses. Check `latestScan.captureId === latestCapture.id` and current revision.

### Required states and provenance

- Selecting/taking a photo is not analysis. Show its preview separately, disable
  duplicate submission, then show Uploading/Analyzing until the actual request ends.
  The server status is `analyzing` during the model call. Default timeout is 30 s
  per attempt, at most 3 attempts with 2 s and 5 s retry delays (~97 s plus overhead).
- On HTTP 502 `{ code: "upstream_error", error }`, show the error and a Retry action.
  No success banner, completed report, acceptance or settlement from a timer.
  410 means expired capture session: request a new one. 409 means evidence/payment
  conflict: refetch and explain the lock; do not retry around it automatically.
- Retry explicitly resubmits the same File/Blob; the endpoint is not idempotent,
  so it creates another capture/revision on success. After a lost HTTP response,
  refetch first to see whether that exact photo already completed.
- `analyzedBy: "gemini"` means this call succeeded live; `"mock"` means fixture
  observations, not the uploaded image; `"cache"` means a previous validated Gemini
  result for the exact same bytes/configuration after a transient live failure.
  Show a visible GEMINI / MOCK / CACHED label, notes and cached timestamp warning.
  Documents use the same meanings via `extractedBy` and `warnings`.
- The old UI only renders scan notes when source is mock, which hides cache warnings.
  Preserve and display provenance in the new receiving UI and every report/event.
- A different file cannot hit the prior file's cache. While a new request is pending
  or fails, the existing server may retain old latestCapture/latestScan/comparison.
  Label these as PREVIOUS EVIDENCE, never as analysis of the new preview. Do not
  enable acceptance from the old comparison while status is analyzing/needs_info.
- Remove timer completion AND reload auto-completion in DemoProvider. Replace the
  fixed `scanned()` event with a summary derived from the returned observations;
  do not hydrate authoritative receiving evidence from persisted demo lines.
- Match means ready for owner review. It cannot authorize a payment, choose the
  trusted supplier wallet, claim package contents, or establish physical delivery.
  Keep approval and wallet signatures separate; use server integer minor amounts.

## Integrator requests (not edited here)

No shared contract change is required for the existing single-photo success path.
For robust failed/pending capture presentation across refreshes, persist an active
capture/analysis attempt with error and status in the order detail (or invalidate
the previous comparison immediately when starting a new attempt). Serialize or
version concurrent uploads so an older request cannot overwrite a newer capture.
These are route/store/shared-contract changes owned by the integrator.

`evidenceChanged()` currently omits `verifiedWallet` when calling compareOrder,
even though compareOrder supports it. The integrator should pass the verified
supplier address, so a printed payment address can be checked deterministically.
The model must never set that trusted address. Existing behavior flags printed
addresses as lacking a verified wallet rather than silently trusting them.

Coordinate the above with the frontend owner before claiming the current escrow
receiving UI is live. Multi-batch endpoints/types from the team plan are not present
and are not needed to close this single-photo integration gap.

## Run locally and human input

The isolated ignored `.env` already contains Gemini settings copied privately from
the original checkout. No key was printed or committed. It sets PORT=3107; the smoke
test instead picks a free port, creates a temporary database, and stops only its own
child server. No active integration service was restarted or reset.

If replacing the quota-limited key: open [Google AI Studio API keys](https://aistudio.google.com/apikey),
select/create a project and create an API key, then enter it locally as
`GEMINI_API_KEY=...` in this isolated checkout's `.env`. Keep `GEMINI_MODEL=gemini-3.8-flash`.
Never paste it in chat or commit it. Follow [Google's key setup instructions](https://ai.google.dev/gemini-api/docs/api-key).
The [official model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
confirms image/PDF input and structured outputs; actual document calls here verified
the existing v1beta generateContent, inline_data and responseSchema request format.

From the isolated checkout:

```powershell
npm test
npm run typecheck
npm run build
node --env-file=.env --import tsx samples/check-capture-api.mts --mock
node --env-file=.env --import tsx samples/check-capture-api.mts
cd server
..\node_modules\.bin\tsx.cmd --env-file=../.env scripts/eval-ai.ts
```

Needed: quota available for live scans; four real delivery photos with ground truth
(all present, one missing, wrong-product replacement, label covered). Current sample
expectations are **three bags of PROD-A**, not three distinct SKUs: confirm the actual
order if different. Store real photos at samples/photos/{all_correct,one_missing,
swapped,label_covered}.jpg only when they really are camera photos. Synthetic drawings
must stay under photos/synthetic. Labels do not prove contents or physical delivery.

Still unverified: live synthetic and real-photo scan accuracy, real camera quality,
browser upload-to-report behavior in the newer receiving UI, and end-to-end payment
or escrow on this change. These cannot be marked passed from the mock HTTP test.
