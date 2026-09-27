import assert from "node:assert/strict";
import { test } from "node:test";
import type { Comparison, Order, ScanResult } from "@cleardock/shared";
import { initialState, linesFor, scanLines, scanned } from "./demo";

const comparison = {
  lines: [{ sku: "A", description: "Product A 500 g", unitPriceMinor: 1000, ordered: 3, billed: 3, observed: 2 }],
} as Comparison;
const order = (o: Partial<Order>) => ({ order: { comparison: null, latestScanId: null, ...o } as Order });
const scan = { observed: [{ count: 2, labelText: "Product A" }], analyzedBy: "gemini" } as ScanResult;

test("a real scan makes one line per ordered unit and claims the unseen ones", () => {
  const lines = scanLines(order({ comparison, latestScanId: "scan_1" }))!;
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => l.claim), [false, false, true]);
  assert.equal(lines.reduce((s, l) => s + l.priceMinor, 0), 3000);
});

test("no scan or no comparison means no real lines; only the demo falls back", () => {
  assert.equal(scanLines(order({ comparison })), null);
  assert.equal(scanLines(order({ latestScanId: "scan_1" })), null);
  assert.equal(linesFor(order({})).length, 3);
});

test("scanned() labels the fallback SIMULATED and uses the real scan when present", () => {
  const st = initialState(null);
  assert.equal(scanned(st).events!.at(-1)!.sim, true);
  const real = scanned(st, { ...order({ comparison, latestScanId: "scan_1" }), latestScan: scan });
  assert.equal(real.step, "report");
  assert.equal(real.events!.at(-1)!.sim, false);
  assert.match(real.events!.at(-1)!.detail, /Gemini saw 2 × Product A/);
});
