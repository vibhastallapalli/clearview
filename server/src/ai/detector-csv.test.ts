import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { adaptDetectorCsv, type DetectorConfig } from "./detector-csv.ts";

const config: DetectorConfig = JSON.parse(readFileSync(new URL("../../../samples/detector/csv-config.proposed.json", import.meta.url), "utf8"));
const catalog = JSON.parse(readFileSync(new URL("../../../samples/detector/redbull.products.json", import.meta.url), "utf8"));
const image = Buffer.from("synthetic image bytes");
const sha = (s: Buffer) => createHash("sha256").update(s).digest("hex");
const header = "item_id,class,confidence,damage\r\n";
const row = "1,redbull_original_250ml,0.93,ok\r\n";
function run(csv = header + row, override = {}, cfg = config, products = catalog) {
  const bytes = Buffer.from(csv);
  const m = { format: "cleardock.csv.v1", orderId: "order", imageSha256: sha(image), csvSha256: sha(bytes),
    model: config.model, rowCount: csv.split(/\r?\n/).filter(Boolean).length - 1, frames: 1, complete: true, emptyTray: false, synthetic: true, ...override };
  return adaptDetectorCsv(bytes, m, { orderId: "order", image }, cfg, products);
}
test("one row per can, additive variants, damage retained and confidence is never inflated", () => {
  const result = run(header + row + "2,redbull_original_250ml,0.84,damaged\r\n3,redbull_sugarfree_250ml,0.91,ok\r\n");
  assert.deepEqual(result.observed.map((x) => [x.sku, x.count, x.damagedCount, x.confidence]), [["RB-ORIGINAL-250ML", 2, 1, 0.84], ["RB-SUGARFREE-250ML", 1, 0, 0.91]]);
  assert.equal(result.items.length, 3);
  assert.equal(result.detector.rowCount, 3);
  assert.equal(result.detector.imageSha256, sha(image));
  assert.equal(result.detector.synthetic, true);
});
test("uncertain class, confidence and condition all require review", () => {
  for (const line of [row.replace("0.93", "0.79"), row.replace("redbull_original_250ml", "unmapped"), row.replace(",ok", ",unknown")]) {
    const r = run(header + line);
    assert.equal(r.observed.length, 0);
    assert.equal(r.items.length, 1);
    assert.equal(r.unreadable.length, 1);
  }
  assert.equal(run(header + row.replace("0.93", "0.8")).observed.length, 1);
});
test("empty tray requires an explicit complete empty result", () => {
  assert.equal(run(header).unreadable.length, 1);
  assert.equal(run(header, { emptyTray: true }).unreadable.length, 0);
  assert.throws(() => run(header + row, { emptyTray: true }), /contradiction/);
});
test("binding, completeness, provenance, model and row-count failures reject", () => {
  for (const patch of [{ orderId: "other" }, { imageSha256: "a".repeat(64) }, { csvSha256: "b".repeat(64) },
    { complete: false }, { frames: 2 }, { rowCount: 2 }, { synthetic: "false" }, { model: { name: "other", version: "1" } }]) {
    assert.throws(() => run(header + row, patch), /rejected/);
  }
});
test("bad rows reject the whole file, including a valid prefix", () => {
  for (const bad of ["2,x,NaN,ok", "2,x,,ok", "2,x,1.1,ok", "2,x,-0.1,ok", "2,x,0x1,ok", "2,x,1e0,ok",
    "2,x,0.9,maybe", "2,,0.9,ok", "1,x,0.9,ok", "2,x,0.9", '2,"x,0.9,ok', '2,"x"oops,0.9,ok', ""]) {
    assert.throws(() => run(header + row + bad + "\r\n"), /rejected/);
  }
  assert.throws(() => run(header.replace("damage", "class") + row), /headers/);
});
test("CSV quoting, BOM, alternate columns and delimiter are configurable", () => {
  const cfg = { ...config, delimiter: ";" as const, columns: { itemId: "id", classId: "label", confidence: "score", damage: "condition" } };
  const r = run('\uFEFFid;label;score;condition\r\n"can;1";"redbull_original_250ml";0.9;ok\r\n', {}, cfg);
  assert.equal(r.items[0].itemId, "can;1");
});
test("config and catalog ambiguity reject; injected authority fields never survive", () => {
  assert.throws(() => run(undefined, {}, { ...config, minConfidence: NaN }), /configuration/);
  assert.throws(() => run(undefined, {}, config, [...catalog, { sku: "other", detectorClasses: ["redbull_original_250ml"] }]), /duplicate/);
  assert.throws(() => run(undefined, {}, config, [...catalog, catalog[0]]), /duplicate/);
  const r = run(undefined, { approved: true, amountMinor: 1 });
  assert.equal("approved" in r.detector, false);
  assert.equal("amountMinor" in r, false);
});
