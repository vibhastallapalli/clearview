# Detector CSV proposal

Status: implemented and tested in an isolated integration preview; **shared contract acceptance pending**.
Read [the review, contract change request, plan and hardware questions](../samples/detector/REVIEW.md).
The exact integration implementation is [integration-request.patch](../samples/detector/integration-request.patch).

## Source of truth

- Trained station detector: what arrived, variant and visible condition.
- Gemini: PO and invoice extraction only. No station-photo fallback, cross-check or gap filling.
- Deterministic code: comparison and integer-cent calculations.
- Humans and wallet signatures: authorization. A signed claim releases its accepted portion; only the disputed portion stays held.

## Multipart station request

`POST /api/station/captures`, header `x-station-token`:

| Part | Type | Meaning |
|---|---|---|
| `orderId` | text | Selected server order ID |
| `image` | file | Exact evidence image bytes |
| `detectionsCsv` | file | UTF-8 CSV; **file part**, not normalized form text |
| `detectorMetadata` | JSON text | Binding and completion envelope below |
| `weightGrams`, `simulated`, `fixture` | existing fields | Existing meanings retained |

```json
{
  "format": "cleardock.csv.v1",
  "orderId": "ord_1001",
  "imageSha256": "<lowercase sha256 of the exact image bytes>",
  "csvSha256": "<lowercase sha256 of the exact CSV bytes>",
  "model": { "name": "<confirmed model name>", "version": "<confirmed version>" },
  "rowCount": 2,
  "frames": 1,
  "complete": true,
  "emptyTray": false,
  "synthetic": false
}
```

Provisional CSV example (labels must be confirmed by hardware):

```csv
item_id,class,confidence,damage
can-1,redbull_original_250ml,0.96,ok
can-2,redbull_sugarfree_250ml,0.92,damaged
```

Configure header names, delimiter, damage tokens, confidence threshold and accepted model version on the server through `CLEARDOCK_DETECTOR_CONFIG`. A ready example is `samples/detector/csv-config.proposed.json`; its model name/version explicitly identify synthetic input. Catalog `detectorClasses` supplies exact class-to-SKU mapping. Extra CSV columns are ignored; required columns must exist once. Duplicate item IDs, ragged/blank rows, malformed quotes, invalid UTF-8, unmapped damage tokens, invalid numeric values, mismatched hashes/counts/model/order, incomplete inference and multiple frames reject the **whole** upload.

Limits: 1 MB CSV and 500 item rows. Confidence uses decimal 0..1. Every item is retained in `items`; low confidence, unknown class or explicitly unknown condition requires review and prevents a trusted partial count. Hashes bind supplied evidence; they do not attest camera authenticity or detector accuracy.

An empty tray is a header-only CSV with `rowCount: 0`, `complete: true`, and `emptyTray: true`. It can produce a shortage. Zero rows without explicit empty-tray confirmation produce `needs_info`. Never mark a failed inference as a completed empty tray.

## Integrator application

After accepting the **Contract change requested** section of the review, from the branch root:

```powershell
git apply --check samples/detector/integration-request.patch
git apply samples/detector/integration-request.patch
npm test
npm run typecheck
npm run build
```

The patch also disables the dev station photo-only path, updates damage badges and signed claim reasons, adds document pack/total guards, and updates regression tests. Commit the approved shared definitions, CONTRACTS.md and shared fixtures together under integrator ownership. Until then, this branch provides the adapter and proposal only; it does not change the running application's station source.
