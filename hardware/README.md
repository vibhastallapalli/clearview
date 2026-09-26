# Receiving station

Goal: drop the delivery on the tray → get a result, no typing. The owner only opens the app when it's red.

## Setup
- Camera on a fixed stand pointing straight down at a marked tray. Same height, angle and light every time.
- Packages separated, labels facing up.
- Optional ONE sensor: a scale under the tray (tare + tolerance). Barcode scanner only if one is lying around.

## Run
```bash
pip install opencv-python requests pyserial
python station.py --order ord_1001 --fake-weight 1500   # SPACE to capture
```
It POSTs to `/api/station/captures` (see CONTRACTS.md). The order screen updates within ~2 s.

In MOCK mode (no Gemini key) add `--mock core` to return the core-example result.

## Next
1. Auto-capture when the scale reading is stable for ~1 s
2. Status light from the returned `status`
3. Weight check: expected vs measured, within tolerance

## Limits (say them)
Labels don't prove contents. Weight doesn't prove authenticity. Simulated readings are labelled.
