import assert from "node:assert/strict";
import { test } from "node:test";
import type { Comparison, Order, ScanResult } from "@cleardock/shared";
import { OVERRIDE_REASON, STALE_EVIDENCE, initialState, linesFor, linesStale, reviewedClaim, scanLines, scanned, type DemoState } from "./demo";

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

test("a rescan while the report is open voids old choices and the transaction uses only the reviewed scan", () => {
  // Scan 1: 2 of 3 bags seen. The buyer reviews it and also claims bag 2.
  const first = { ...order({ comparison, latestScanId: "scan_1", evidenceRevision: 3 }), latestScan: scan };
  let st: DemoState = { ...initialState(null), ...scanned(initialState(null), first) };
  st = { ...st, lines: st.lines.map((l, i) => (i === 1 ? { ...l, claim: true } : l)) };
  assert.equal(linesStale(st, first), false);
  // Bag 2 was seen, so claiming it overrides the scan: refused until the buyer says why.
  assert.throws(() => reviewedClaim(st, first, 3000), { message: OVERRIDE_REASON });
  st = { ...st, lines: st.lines.map((l, i) => (i === 1 ? { ...l, reason: "bag torn" } : l)) };
  const before = reviewedClaim(st, first, 3000);
  assert.deepEqual(before.chain, { action: "claim", accepted: 1000, claimed: 2000 });
  assert.deepEqual(before.evidence, { scanId: "scan_1", revision: 3 });

  // Scan 2 lands (all 3 bags seen) while the report is still open.
  const rescanned = { lines: [{ ...comparison.lines[0], observed: 3 }] } as Comparison;
  const second = { ...order({ comparison: rescanned, latestScanId: "scan_2", evidenceRevision: 4 }), latestScan: scan };
  assert.equal(linesStale(st, second), true);
  assert.throws(() => reviewedClaim(st, second, 3000), { message: STALE_EVIDENCE });

  // Reviewing the new report replaces the lines and the old claim choices.
  st = { ...st, ...scanned(st, second) };
  assert.equal(linesStale(st, second), false);
  assert.deepEqual(st.lines.map((l) => l.claim), [false, false, false]);
  const after = reviewedClaim(st, second, 3000);
  assert.deepEqual(after.chain, { action: "accept_all" });
  assert.deepEqual(after.evidence, { scanId: "scan_2", revision: 4 });
});

test("a revision bump on the same scan also requires review; SIMULATED demo lines go stale once a real scan exists", () => {
  const first = { ...order({ comparison, latestScanId: "scan_1", evidenceRevision: 3 }), latestScan: scan };
  const st: DemoState = { ...initialState(null), ...scanned(initialState(null), first) };
  assert.equal(linesStale(st, { ...first, order: { ...first.order, evidenceRevision: 4 } }), true);
  const demo: DemoState = { ...initialState(null), ...scanned(initialState(null)) };
  assert.equal(linesStale(demo, order({})), false);
  assert.equal(linesStale(demo, first), true);
});

test("the report names cached AI results as cached and never calls an empty read a successful scan", () => {
  const detail = order({ comparison, latestScanId: "scan_1" });
  const cached = scanned(initialState(null), { ...detail, latestScan: { ...scan, analyzedBy: "cache" } as ScanResult });
  assert.match(cached.events!.at(-1)!.detail, /Cached Gemini result saw 2 × Product A/);
  const empty = scanned(initialState(null), { ...detail, latestScan: { ...scan, observed: [] } as ScanResult });
  assert.match(empty.events!.at(-1)!.detail, /read no packages\. Check the tray and scan again\./);
  assert.doesNotMatch(empty.events!.at(-1)!.detail, /saw/);
});
