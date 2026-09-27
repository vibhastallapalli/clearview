import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_REMEDIES, remedyDefault, type ClaimLine } from "./contracts.ts";

const line = (claimedMinor: number, reason: ClaimLine["reason"]): ClaimLine => ({ sku: null, description: `${reason} can`, claimedMinor, reason });

test("the signed schedule sets the default split of a held claim, in whole cents", () => {
  const schedule = { missing: 100, damaged: 50, wrong_item: 75 };
  const r = remedyDefault([line(1000, "missing"), line(333, "damaged"), line(199, "wrong_item")], 1532, schedule, 3)!;
  // 1000 + floor(166.5) + floor(149.25) = 1000 + 166 + 149; the remainder goes to the supplier.
  assert.deepEqual([r.toBuyerMinor, r.toSupplierMinor, r.termsVersion], [1315, 217, 3]);
  assert.deepEqual(r.basis.map((b) => [b.reason, b.refundPercent, b.refundMinor]), [["missing", 100, 1000], ["damaged", 50, 166], ["wrong_item", 75, 149]]);
  assert.equal(remedyDefault([line(1000, "missing")], 1000, DEFAULT_REMEDIES, 1)!.toSupplierMinor, 0);
});

test("no default for a reason the schedule doesn't cover, or a claim bigger than what's held", () => {
  assert.equal(remedyDefault([line(1000, "missing"), line(100, "other")], 1100, DEFAULT_REMEDIES, 1), null);
  assert.equal(remedyDefault([line(1000, "missing")], 999, DEFAULT_REMEDIES, 1), null);
});
