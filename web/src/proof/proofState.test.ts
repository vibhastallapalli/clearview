import assert from "node:assert/strict";
import { test } from "node:test";
import { isHistorical, splitProofs } from "./proofState";

test("only proofs explicitly marked live count as live photos; everything else is additional evidence", () => {
  const { live, uploads } = splitProofs([{ id: "a", kind: "live" }, { id: "b", kind: "upload" }, { id: "c" }, { id: "d", kind: "LIVE" }]);
  assert.deepEqual(live.map((p) => p.id), ["a"]);
  assert.deepEqual(uploads.map((p) => p.id), ["b", "c", "d"]);
});

test("a proof attached to an earlier station scan is historical", () => {
  assert.equal(isHistorical({ stationScanId: "scan_1" }, "scan_1"), false);
  assert.equal(isHistorical({ stationScanId: "scan_1" }, "scan_2"), true);
});
