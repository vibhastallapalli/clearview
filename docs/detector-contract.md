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

Skip `analyzeScan` (Gemini) when `detections` is present. A rejected result is a 400 with the adapter's
message. It must never fall back to Gemini silently.

## Contract changes requested (Account 1)

1. `AnalysisSource` gains `"detector"`.
2. `ScanResult.detector?: { model: string; frames: number; latencyMs: number | null; synthetic: boolean }`
   for provenance. Until then it only appears in `notes`.
3. Catalog: replace `shared/fixtures/products.json` with the agreed can SKUs plus `detectorClasses`
   (proposal: `samples/detector/products.proposed.json`). This also changes the Gemini prompt's SKU list and
   the seeded PO/invoice/scan fixtures, which are still coffee.
4. Optional, later: `LineItem.packSize`, so a case keeps its printed price. Until then extraction converts
   "1 × 6-pack @ $6.00" into 6 units @ $1.00. If the case price doesn't divide evenly, or the pack size isn't
   printed, the line goes to review. It is never treated as 1 can.
5. `compareOrder`: when `scan.unreadable` is non-empty, a line still shows "observed 5 → missing 1".
   The outcome is correctly `needs_info`, but the UI should not present that per-line count as confident.

## Station-guard (ai/station-guard @ 3c7cfbc)

Cherry-picked onto this branch (it only touches `server/src/ai/**`). Gemini station scans now return
`showsDelivery`. A floor or wall photo becomes a single `unreadable` entry and returns `needs_info`, instead of
"all cans missing". The detector adapter behaves the same way for zero detections.

## What was tested, and what wasn't

| Evidence | Kind | Result |
|---|---|---|
| Adapter + `compareOrder`: correct, missing, wrong size, wrong brand, extra, covered, unmapped class, empty, repeated frames, disagreeing frames, 11 malformed inputs, duplicate catalog class, cross-check | Unit tests, **synthetic** detector JSON, **provisional** catalog | 12/12 pass |
| Case → unit conversion, missing pack size, indivisible case price, total mismatch warning | Unit tests, **stubbed** Gemini responses | pass |
| Can PO/invoice extraction with live Gemini | – | **Not run**: no `GEMINI_API_KEY` in local `.env` |
| Real detector output, real captures, accuracy, latency | – | **Blocked on hardware** |

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
- **Actually tested so far:** the adapter and comparison, using made-up detector outputs, plus extraction logic
  with simulated Gemini replies. **Not yet tested:** live Gemini on the can documents, and the real detector on
  real photos. Don't claim detector accuracy yet.
