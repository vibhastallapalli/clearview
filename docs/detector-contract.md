# Station can detector: proposed contract and handoff

Status: **PROVISIONAL.** The catalog, class IDs and detector output below are proposals
written before the hardware teammate's answers came in. All fixtures are marked
`provisional` / `synthetic`. They check the adapter, **not** detector accuracy.

## Pipeline

| Step | Who | Output |
|---|---|---|
| PO / invoice → structured lines | Gemini (`analyzeDocument`) | `ExtractedDocument`. Code converts cases to single units |
| Tray photo → observed cans | Hardware teammate's detector, validated by `adaptDetections` | `observed[]`, `unreadable[]`, provenance |
| Compare quantities and prices | Code (`compareOrder`, unchanged) | `Comparison` |
| Approve, sign, pay | Humans | – |
| Phone photos | Nobody reads them | Raw proof for the supplier |

The AI never computes or authorizes payments. Detector counts and Gemini counts are never added together.

## Questions for the hardware teammate (open)

1. Exact can classes: brand, variant and size (e.g. Coke Classic 12 oz vs 7.5 oz mini vs Diet Coke).
2. Does the model identify products, or only detect a generic "can"? (A generic class maps to no SKU, so every result would be `needs_info`.)
3. Current output format and **one real sample result**.
4. Confidence score range, how unknown or uncertain detections appear, and the model name and version.
5. How is a capture triggered? If several frames are processed, how do you avoid counting the same can twice?
6. Loose cans on the tray, or packs and cases? (The documents are converted to single cans.)

## Proposed detector output: `cleardock.detections.v0`

Example: `samples/detector/detections.example.json`.

```json
{
  "format": "cleardock.detections.v0",
  "synthetic": false,
  "model": { "name": "cleardock-cans", "version": "2026-09-27a" },
  "orderId": "ord_1001",
  "imageSha256": "<sha256 of the exact JPEG uploaded as evidence>",
  "latencyMs": 85,
  "frames": [
    { "detections": [ { "classId": "coke_classic_12oz", "confidence": 0.93, "box": [102, 88, 140, 260] } ] }
  ]
}
```

- `frames` holds one or more views of the **same** tray load. They are never summed: every frame must
  report the same count per class, or that class goes to review.
- `box` is optional and ignored for now. Other extra fields are ignored.
- `synthetic: true` marks hand-written or fake-camera output. It is shown as SYNTHETIC in the scan notes.

## Adapter: `server/src/ai/detector.ts`

`adaptDetections(raw, { orderId, imageSha256 }, catalog?)` → `{ observed, unreadable, notes, detector }`

| Case | Result |
|---|---|
| Wrong format, missing model name/version, wrong order, wrong image hash, 0 or more than 30 frames, bad confidence or class | **Rejected** (throws). No partial result |
| Confident detections (≥ `MIN_CONFIDENCE` = 0.6, to be tuned on real captures) | Counted per class, then mapped to a SKU through `detectorClasses` |
| Class not in the catalog (e.g. a generic `can`) | Count kept with `sku: null`, so the comparison marks it `unknown` and returns `needs_info` |
| Low-confidence detection (covered or partial label) | Not counted. Added to `unreadable`, so `needs_info` |
| Frames disagree on a count | Class not counted. Added to `unreadable`, so `needs_info` |
| No detections at all (empty or irrelevant frame) | Added to `unreadable`, so `needs_info`. Never "everything missing" |

`crossCheck(detectorObserved, geminiObserved)`: this only applies if Gemini also reads labels on the
same station photo. Gemini's role is a second opinion only. Any per-SKU difference becomes an `unreadable`
review item, and neither side is picked. The recommended default is **not** to run Gemini on the station photo
once the detector is live.

## Required server wiring (Account 1)

In the station route, when the station posts a multipart `detections` JSON field alongside `image`:

```ts
const d = adaptDetections(JSON.parse(req.body.detections), { orderId: order.id, imageSha256: sha256(file.buffer) });
const scan: ScanResult = { id, orderId: order.id, captureId, analyzedBy: "detector", analyzedAt: now(),
  observed: d.observed, unreadable: d.unreadable, notes: d.notes /* + d.detector once the contract has it */ };
// then as today: db.scans.push(scan); latestScanId; evidenceChanged(order)
```

**Path selection, per capture:** the existing Gemini station path stays exactly as it is and remains the
default. Only a capture that carries a `detections` field uses the detector path, and that capture skips
`analyzeScan`. A rejected detector result is a 400 with the adapter's message. It never silently falls back
to Gemini, and Gemini never fills in for it.

**Provenance:** do not wire this until `AnalysisSource` includes `"detector"`. Never store a detector result
as `"gemini"`, `"mock"` or `"cache"` as a stand-in.

**Catalog:** the adapter and the Gemini prompt read `shared/fixtures/products.json` (still coffee, unchanged).
`CLEARDOCK_PRODUCTS_FILE=<path>` points one process at another catalog. The soda eval uses it with the
PROVISIONAL `samples/detector/products.proposed.json`. Nothing global changes until the team agrees on the
soda dataset and on how existing demo orders are kept.

## Contract changes requested (Account 1)

1. `AnalysisSource` gains `"detector"`.
2. `ScanResult.detector?: { model: string; frames: number; latencyMs: number | null; synthetic: boolean }`
   for provenance. Until then it only appears in `notes`.
3. Catalog, **only after** the team agrees on the soda dataset and hardware confirms real class labels:
   add the agreed can SKUs with `detectorClasses` (proposal: `samples/detector/products.proposed.json`,
   every entry marked `provisional`). Keep the coffee SKUs and existing demo orders working. Add, don't replace.
4. Optional, later: `LineItem.packSize`, so a case keeps its printed price. Until then extraction converts
   "1 × 6-pack @ $6.00" into 6 units @ $1.00. If the case price doesn't divide evenly, or the pack size isn't
   printed, the line goes to review. It is never treated as 1 can.
5. `compareOrder`: when `scan.unreadable` is non-empty, a line still shows "observed 5 → missing 1".
   The outcome is correctly `needs_info`, but the UI should not present that per-line count as confident.
6. **Config bug, not a contract change:** `.env.example` (and the local `.env`) set `GEMINI_MODEL=gemini-2.5-flash`.
   On 2026-09-27 that model returned **404 "no longer available to new users"** for our key, so a server
   started with that setting fails every live Gemini call. Remove the line (the code default is
   `gemini-3.8-flash`, which returned real results) or set it to `gemini-3.8-flash`.

## Station-guard (ai/station-guard @ 3c7cfbc)

Cherry-picked onto this branch (it only touches `server/src/ai/**`). Gemini station scans now return
`showsDelivery`. A floor or wall photo becomes a single `unreadable` entry and returns `needs_info`, instead of
"all cans missing". The detector adapter behaves the same way for zero detections.

## What was tested, and what wasn't

| Evidence | Kind | Result |
|---|---|---|
| Adapter + `compareOrder`: correct, missing, wrong size, wrong brand, extra, covered, unmapped class, empty, repeated frames, disagreeing frames, 11 malformed inputs, duplicate catalog class, cross-check | Unit tests, **synthetic** detector JSON, **provisional** catalog | 12/12 pass |
| Case → unit conversion, missing pack size, indivisible case price, total mismatch warning | Unit tests, **stubbed** Gemini responses | pass |
| `cans_po_en.pdf` (English PO, 1 × 6-pack + 2 cans) | **Live Gemini** `gemini-3.8-flash`, fresh (no cache), 16.2 s | 11/11: 6 × COKE-CLASSIC-12OZ @ 100, 2 × DIET-COKE-12OZ @ 100, total 800 |
| `cans_invoice_es_no_pack.png` ("1 caja", no pack size) | **Live Gemini**, fresh, 7.1 s | 8/8: case line kept as unknown (never 1 can), Gemini also warned "pack size not printed"; with the PO + synthetic detector scan → `needs_info` as expected |
| `cans_invoice_es.png` (matching Spanish invoice) | Live Gemini | **Not completed**: 503 "high demand" in run 1, then 429 quota on three later attempts. PO + matching invoice → `match` is unverified live |
| `gemini-2.5-flash` (the model in `.env.example`) | Live Gemini | 404 for all three: model unavailable to this key (see request 6) |
| Real detector output, real captures, accuracy, latency | – | **Blocked on hardware** |

Raw evidence: `samples/detector/eval-results.gemini-3.8-flash.json` (run 1). Rerun with
`node --env-file=<private key file> --import tsx samples/detector/eval-docs.mts --write` once quota resets.
These are 3 synthetic documents on a provisional catalog: evidence the extraction path works, not an accuracy figure.

### Real-capture evaluation to run once hardware is ready

Use photos that were **not** in the training data. For each capture, record the expected SKU counts, the
detector output, the comparison outcome, the `unreadable` entries and the latency:
correct delivery · one missing can · wrong variant/brand · extra can · covered or partly hidden label · empty/irrelevant frame.
A few successful demo runs are not an accuracy figure.

## For Account 4 (presentation, plain words)

- **Gemini** reads the purchase order and invoice and turns them into lines: product, quantity, unit, price.
  Code then turns "one 6-pack" into 6 cans. If the pack size isn't printed, a person has to check it.
- **The detector** (our hardware teammate's model) looks at the tray photo and says which cans it sees.
  If it's unsure, sees an unknown can, or sees nothing at all, the result says "needs review". It never says "zero".
- **Plain code** compares ordered vs billed vs seen, and computes any missing value in cents. No AI decides a payment.
- **People** approve and sign. Phone photos are shown to the supplier as-is. No AI judges them.
- **Actually tested so far:** the adapter and comparison, using made-up detector outputs. Live Gemini read the
  synthetic can PO correctly and refused to guess a case with no pack size. The matching invoice hasn't
  finished a live run yet (Gemini quota). **Not tested:** the real detector on real photos. Don't claim detector
  accuracy, and don't call 2 documents an accuracy result.
