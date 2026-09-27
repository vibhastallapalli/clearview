import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { compareOrder, type ExtractedDocument, type ScanResult } from "@cleardock/shared";
import { adaptDetections, crossCheck, type CatalogProduct } from "./detector.ts";

// PROVISIONAL catalog and SYNTHETIC detector output: these validate the adapter, not detector accuracy.
const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const catalog: CatalogProduct[] = read("../../../samples/detector/products.proposed.json");
const example = read("../../../samples/detector/detections.example.json");
const expect = { orderId: example.orderId, imageSha256: example.imageSha256 };

const det = (classId: string, confidence = 0.9) => ({ classId, confidence });
const coke = (n: number) => Array.from({ length: n }, () => det("coke_classic_12oz"));
const diet = (n: number) => Array.from({ length: n }, () => det("diet_coke_12oz"));
const result = (...frames: object[][]) => ({ ...example, frames: frames.map((detections) => ({ detections })) });

// Documents as they look after extraction: "1 × 6-pack" already converted to 6 units at the per-can price.
const doc = (kind: ExtractedDocument["kind"]): ExtractedDocument => ({
  id: kind, orderId: "ord_1001", kind,
  source: { filename: kind, mimeType: "image/png", sha256: "fixture" },
  paymentAddress: null, embeddedInstructions: [], supplierName: null, orderReference: "PO-1001",
  currency: "USD", language: "en", totalMinor: 800, warnings: [], extractedBy: "mock", extractedAt: "2026-09-27T00:00:00Z",
  lines: [
    { sku: "COKE-CLASSIC-12OZ", description: "Coca-Cola Classic 12 oz (1 × 6-pack = 6 units)", quantity: 6, unit: "unit", unitPriceMinor: 100, sourceText: "", confidence: 1 },
    { sku: "DIET-COKE-12OZ", description: "Diet Coke 12 oz", quantity: 2, unit: "unit", unitPriceMinor: 100, sourceText: "", confidence: 1 },
  ],
});

function compare(raw: unknown) {
  const adapted = adaptDetections(raw, expect, catalog);
  // analyzedBy "detector" is a requested contract change; the comparison never reads it.
  const scan = { ...adapted, id: "scan", orderId: "ord_1001", captureId: "cap", analyzedBy: "detector", analyzedAt: "" } as unknown as ScanResult;
  return { adapted, cmp: compareOrder({ orderId: "ord_1001", evidenceRevision: 1, purchaseOrder: doc("purchase_order"), invoice: doc("invoice"), scan }) };
}
const verdicts = (c: ReturnType<typeof compareOrder>) => Object.fromEntries(c.lines.map((l) => [l.sku ?? l.description, l.verdict]));

test("correct delivery matches, with provenance and SYNTHETIC label", () => {
  const { adapted, cmp } = compare(example);
  assert.equal(cmp.outcome, "match");
  assert.deepEqual(adapted.detector, { model: "cleardock-cans@PROVISIONAL-0", frames: 1, latencyMs: 85, synthetic: true });
  assert.match(adapted.notes, /SYNTHETIC/);
});

test("repeated frames of the same tray are not added together", () => {
  const { adapted, cmp } = compare(result([...coke(6), ...diet(2)], [...coke(6), ...diet(2)], [...diet(2), ...coke(6)]));
  assert.equal(adapted.observed.find((o) => o.sku === "COKE-CLASSIC-12OZ")?.count, 6);
  assert.equal(cmp.outcome, "match");
});

test("frames that disagree go to review, not to the higher or lower count", () => {
  const { adapted, cmp } = compare(result([...coke(6), ...diet(2)], [...coke(5), ...diet(2)]));
  assert.equal(adapted.observed.some((o) => o.sku === "COKE-CLASSIC-12OZ"), false);
  assert.match(adapted.unreadable[0], /disagree.*6, 5/);
  assert.equal(cmp.outcome, "needs_info");
});

test("one missing can is a discrepancy", () => {
  const { cmp } = compare(result([...coke(5), ...diet(2)]));
  assert.equal(cmp.outcome, "discrepancy");
  assert.equal(verdicts(cmp)["COKE-CLASSIC-12OZ"], "missing");
  assert.equal(cmp.lines.find((l) => l.sku === "COKE-CLASSIC-12OZ")?.discrepancyMinor, 100);
});

test("wrong size and wrong brand are swaps: missing + unexpected", () => {
  for (const wrong of ["coke_classic_7_5oz", "pepsi_12oz"]) {
    const { cmp } = compare(result([...coke(5), det(wrong), ...diet(2)]));
    assert.equal(cmp.outcome, "discrepancy");
    assert.equal(verdicts(cmp)["COKE-CLASSIC-12OZ"], "missing");
    assert.equal(cmp.lines.find((l) => l.verdict === "unexpected")?.observed, 1);
  }
});

test("extra can is a discrepancy", () => {
  const { cmp } = compare(result([...coke(7), ...diet(2)]));
  assert.equal(cmp.outcome, "discrepancy");
  assert.equal(verdicts(cmp)["COKE-CLASSIC-12OZ"], "over");
});

test("covered label (low confidence) is never counted and never matches", () => {
  const { adapted, cmp } = compare(result([...coke(5), det("coke_classic_12oz", 0.3), ...diet(2)]));
  assert.equal(adapted.observed.find((o) => o.sku === "COKE-CLASSIC-12OZ")?.count, 5);
  assert.match(adapted.unreadable.join(), /low-confidence/);
  assert.equal(cmp.outcome, "needs_info");
});

test("generic or unmapped class keeps its count but blocks as unknown", () => {
  const { adapted, cmp } = compare(result([...coke(5), det("can"), ...diet(2)]));
  assert.deepEqual(adapted.observed.find((o) => o.sku === null)?.count, 1);
  assert.equal(cmp.outcome, "needs_info");
});

test("empty or irrelevant frame is needs_info, not 'everything missing'", () => {
  const { adapted, cmp } = compare(result([]));
  assert.deepEqual(adapted.observed, []);
  assert.match(adapted.unreadable[0], /no cans/);
  assert.equal(cmp.outcome, "needs_info");
});

test("malformed or mismatched results are rejected", () => {
  const bad: unknown[] = [
    null,
    { ...example, format: "yolo" },
    { ...example, model: { name: "x" } },
    { ...example, orderId: "ord_other" },
    { ...example, imageSha256: "f".repeat(64) },
    { ...example, frames: [] },
    { ...example, frames: [{}] },
    { ...example, latencyMs: -1 },
    result([det("coke_classic_12oz", 1.5)]),
    result([det("coke_classic_12oz", Number.NaN)]),
    result([{ confidence: 0.9 }]),
  ];
  for (const raw of bad) assert.throws(() => adaptDetections(raw, expect, catalog), /Detector output rejected/);
});

test("catalog mapping one class to two SKUs is refused", () => {
  const dup = [...catalog, { sku: "OTHER", detectorClasses: ["pepsi_12oz"] }];
  assert.throws(() => adaptDetections(example, expect, dup), /two SKUs/);
});

test("Gemini cross-check never picks a side: any difference is review", () => {
  const d = adaptDetections(example, expect, catalog).observed;
  assert.deepEqual(crossCheck(d, d), []);
  const gemini = [{ sku: "COKE-CLASSIC-12OZ", labelText: "Coca-Cola", count: 5, confidence: 0.95 }, d[1]];
  assert.match(crossCheck(d, gemini).join(), /COKE-CLASSIC-12OZ: detector 6, Gemini 5/);
});
