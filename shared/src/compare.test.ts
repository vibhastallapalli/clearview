import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareOrder, toUnitCount } from "./compare.ts";
import type { ExtractedDocument, ScanResult } from "./contracts.ts";

const load = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as T;

const po = load<ExtractedDocument>("purchase_order.json");
const invoice = load<ExtractedDocument>("invoice.json");
const base = { orderId: "ord_1001", evidenceRevision: 1, purchaseOrder: po, invoice };

test("1.5 kg of 500 g bags equals three bags", () => {
  assert.equal(toUnitCount({ quantity: 1.5, unit: "kg", unitSizeGrams: 500 }), 3);
  assert.equal(toUnitCount({ quantity: 1.4, unit: "kg", unitSizeGrams: 500 }), null);
  assert.equal(toUnitCount({ quantity: 2, unit: "kg" }), null);
});

test("correct delivery is ready for review (English PO vs Spanish kg invoice)", () => {
  const c = compareOrder({ ...base, scan: load<ScanResult>("scan_match.json") });
  assert.equal(c.outcome, "match");
  assert.equal(c.undisputedMinor, 3000);
  assert.equal(c.billedTotalMinor, 3000);
});

test("core example: one A missing, one B unexpected; $20 undisputed, $10 discrepancy", () => {
  const c = compareOrder({ ...base, scan: load<ScanResult>("scan_core_example.json") });
  assert.equal(c.outcome, "discrepancy");
  const a = c.lines.find((l) => l.sku === "PROD-A")!;
  const b = c.lines.find((l) => l.sku === "PROD-B")!;
  assert.equal(a.verdict, "missing");
  assert.equal(a.discrepancyMinor, 1000);
  assert.equal(b.verdict, "unexpected");
  assert.equal(c.undisputedMinor, 2000);
});

test("unreadable evidence requests review", () => {
  const c = compareOrder({ ...base, scan: load<ScanResult>("scan_unreadable.json") });
  assert.equal(c.outcome, "needs_info");
});

test("no scan yet means needs_info, never match", () => {
  const c = compareOrder(base);
  assert.equal(c.outcome, "needs_info");
});

test("invoice price change is flagged", () => {
  const pricey: ExtractedDocument = {
    ...invoice,
    lines: invoice.lines.map((l) => ({ ...l, unitPriceMinor: 1200 })),
  };
  const c = compareOrder({ ...base, invoice: pricey, scan: load<ScanResult>("scan_match.json") });
  assert.equal(c.outcome, "discrepancy");
  assert.equal(c.lines[0].verdict, "price_mismatch");
  assert.equal(c.lines[0].discrepancyMinor, 600);
});
