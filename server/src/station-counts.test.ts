import assert from "node:assert/strict";
import { test } from "node:test";
import { parseYoloCounts } from "./station-counts.ts";

const post = (total: unknown, normal: unknown, damaged: unknown) => ({ totalCount: total, normalCount: normal, damagedCount: damaged });

test("a post without YOLO fields is not a YOLO post", () => {
  assert.equal(parseYoloCounts({ orderId: "ord_1", weightGrams: "1500" }), null);
});

test("a valid soda can tray parses to counts only: no product, no confidence", () => {
  assert.deepEqual(parseYoloCounts(post("6", "5", "1")), { total: 6, normal: 5, damaged: 1 });
  assert.deepEqual(parseYoloCounts(post("0", "0", "0")), { total: 0, normal: 0, damaged: 0 });
});

test("malformed counts are refused", () => {
  const bad: unknown[][] = [
    ["abc", "0", "0"], ["NaN", "0", "0"], ["Infinity", "0", "0"], ["-1", "-1", "0"], ["1.5", "1.5", "0"],
    ["1e3", "1e3", "0"], ["", "0", "0"], ["0x10", "16", "0"], ["99999999999999999", "99999999999999999", "0"],
    ["3", undefined, "0"], [3, 3, 0], [["3"], "3", "0"],
  ];
  for (const b of bad) assert.throws(() => parseYoloCounts(post(b[0], b[1], b[2])), /nonnegative whole number/, JSON.stringify(b));
});

test("counts that don't add up are refused", () => {
  assert.throws(() => parseYoloCounts(post("6", "5", "2")), /must equal/);
  assert.throws(() => parseYoloCounts(post("6", "4", "1")), /must equal/);
});
