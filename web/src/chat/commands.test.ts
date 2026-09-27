import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "./commands";

// Chat commands are parsed by code, never by AI. Held = $10.00.
test("offer commands become exact splits of the held amount", () => {
  assert.deepEqual(parseCommand("/offer 5", 1000), { type: "offer", kind: "split", toSupplierMinor: 500, toBuyerMinor: 500 });
  assert.deepEqual(parseCommand("/offer $2.50 to supplier", 1000), { type: "offer", kind: "split", toSupplierMinor: 250, toBuyerMinor: 750 });
  assert.deepEqual(parseCommand("/counter refund 7.25", 1000), { type: "offer", kind: "split", toSupplierMinor: 275, toBuyerMinor: 725 });
  assert.deepEqual(parseCommand("/offer full refund", 1000), { type: "offer", kind: "full_refund", toSupplierMinor: 0, toBuyerMinor: 1000 });
  assert.deepEqual(parseCommand("/offer full release", 1000), { type: "offer", kind: "full_release", toSupplierMinor: 1000, toBuyerMinor: 0 });
  assert.deepEqual(parseCommand("/offer 0", 1000), { type: "offer", kind: "full_refund", toSupplierMinor: 0, toBuyerMinor: 1000 });
});

test("answers, plain text and bad commands", () => {
  assert.deepEqual(parseCommand("/accept", 1000), { type: "accept" });
  assert.deepEqual(parseCommand(" /REJECT ", 1000), { type: "reject" });
  assert.equal(parseCommand("can you do 5?", 1000), null);
  for (const bad of ["/offer 12", "/offer refund 11", "/offer five", "/offer 5.005", "/offer -3", "/pay 5", "/accept 5"])
    assert.equal(parseCommand(bad, 1000)?.type, "error", bad);
  assert.equal(parseCommand("/offer 5", null)?.type, "error");
});
