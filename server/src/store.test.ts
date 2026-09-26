/** Demo reset: a reference that had a payment transaction is archived, never shown as unpaid again. Uses a temp data dir. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLEARDOCK_DATA_DIR = mkdtempSync(join(tmpdir(), "cleardock-"));
const { db, resetDb } = await import("./store.ts");

test("reset reuses PO-1001 until a payment transaction was issued, then archives it and rehearses as PO-1001-R2", () => {
  assert.equal(resetDb().reference, "PO-1001");

  const paid = db.orders[0];
  paid.status = "payment_confirmed";
  db.paymentAttempts.push({ orderId: paid.id, status: "landed", signature: "sig1" } as (typeof db.paymentAttempts)[number]);
  db.documents.push({ id: "doc1", orderId: paid.id } as (typeof db.documents)[number]);

  const next = resetDb();
  assert.deepEqual([next.id, next.reference, next.status, next.payment], ["ord_1001_r2", "PO-1001-R2", "needs_documents", null]);
  assert.equal(db.archivedOrders[0].status, "payment_confirmed");
  assert.equal(db.paymentAttempts.length, 1);
  assert.deepEqual(db.documents.map((d) => d.id), ["doc1"]);

  assert.equal(resetDb().id, "ord_1001_r2"); // nothing issued on r2 yet: same identity is fine
  assert.equal(db.archivedOrders.length, 1);
});
