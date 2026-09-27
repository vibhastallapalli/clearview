import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeDocument } from "../../server/src/ai/analyze.ts";

if (!process.env.GEMINI_API_KEY) throw new Error("Live eval requires GEMINI_API_KEY. Mock extraction is not a pass.");
const expected = [["RB-ORIGINAL-250ML", 3, "unit", 250], ["RB-SUGARFREE-250ML", 2, "unit", 275]];
for (const [kind, filename] of [["purchase_order", "redbull_po.png"], ["invoice", "redbull_invoice.png"]] as const) {
  const data = readFileSync(new URL(filename, import.meta.url));
  const result = await analyzeDocument({ orderId: "RB-TEST-001", docId: kind, kind, filename, mimeType: "image/png", sha256: "", data });
  assert.equal(result.extractedBy, "gemini", "cached/mock result is not a fresh live evaluation");
  assert.deepEqual(result.lines.map((l) => [l.sku, l.quantity, l.unit, l.unitPriceMinor]).sort(), [...expected].sort());
  assert.equal(result.totalMinor, 1300);
  assert.equal(result.currency, "USD");
  assert.equal(result.orderReference, "RB-TEST-001");
  console.log(`${filename}: PASS (synthetic document, fresh Gemini extraction)`);
}
