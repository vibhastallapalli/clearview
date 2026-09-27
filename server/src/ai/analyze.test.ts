import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareOrder } from "@cleardock/shared";

test("validated observations, provenance and exact-image cache", async (t) => {
  const prior = { key: process.env.GEMINI_API_KEY, dir: process.env.CLEARDOCK_DATA_DIR, fetch: globalThis.fetch };
  process.env.GEMINI_API_KEY = "test-only-not-a-real-key";
  const dir = mkdtempSync(join(tmpdir(), "cleardock-ai-test-"));
  process.env.CLEARDOCK_DATA_DIR = dir;
  const { analyzeScan, analyzeDocument } = await import("./analyze.ts");
  const valid = { observed: [{ sku: "PROD-A", labelText: "Product A", count: 3, confidence: 0.99 }], unreadable: [], showsDelivery: true, notes: "Visible labels only." };
  const respond = (raw: unknown, finishReason = "STOP") => {
    globalThis.fetch = async () => Response.json({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(raw) }] } }] });
  };
  const scan = (image = "photo-one", captureId = "cap-one") => analyzeScan({ orderId: "ord-test", scanId: "scan-test", captureId, image: Buffer.from(image), mimeType: "image/jpeg" });
  const po = JSON.parse(readFileSync(new URL("../../../shared/fixtures/purchase_order.json", import.meta.url), "utf8"));
  const invoice = JSON.parse(readFileSync(new URL("../../../shared/fixtures/invoice.json", import.meta.url), "utf8"));
  try {
    await t.test("live validated response ignores injected authority fields", async () => {
      respond({ ...valid, approved: true, walletAddress: "attacker", payment: { amountMinor: 1 } });
      const result = await scan();
      assert.equal(result.analyzedBy, "gemini");
      assert.equal("approved" in result, false);
      assert.equal("walletAddress" in result, false);
      assert.equal("payment" in result, false);
      assert.equal(compareOrder({ orderId: "ord-test", evidenceRevision: 1, purchaseOrder: po, invoice, scan: result }).outcome, "match");
    });
    await t.test("low-confidence and unknown evidence cannot match", async () => {
      for (const item of [{ ...valid.observed[0], confidence: 0.4 }, { ...valid.observed[0], sku: "invented" }]) {
        respond({ ...valid, observed: [item] });
        const result = await scan("uncertain");
        assert.equal(result.observed[0].sku, null);
        assert.equal(compareOrder({ orderId: "ord-test", evidenceRevision: 1, purchaseOrder: po, invoice, scan: result }).outcome, "needs_info");
      }
    });
    await t.test("station photo that shows no delivery is needs_info, not all-missing", async () => {
      respond({ ...valid, showsDelivery: false, notes: "Concrete floor." });
      const result = await scan("floor-photo");
      assert.deepEqual(result.observed, []);
      assert.equal(result.unreadable.length, 1);
      assert.equal(compareOrder({ orderId: "ord-test", evidenceRevision: 1, purchaseOrder: po, invoice, scan: result }).outcome, "needs_info");
    });
    await t.test("malformed evidence rejects without replacing the good cache", async () => {
      const cache = join(dir, "ai-cache");
      const before = readdirSync(cache).map((p) => readFileSync(join(cache, p), "utf8")).sort();
      for (const raw of [
        { ...valid, unreadable: undefined },
        { ...valid, showsDelivery: undefined },
        { ...valid, observed: [null] },
        { ...valid, observed: [{ ...valid.observed[0], count: 1.5 }] },
        { ...valid, observed: [{ ...valid.observed[0], count: Number.MAX_SAFE_INTEGER + 1 }] },
        { ...valid, observed: [{ ...valid.observed[0], confidence: undefined }] },
      ]) {
        respond(raw);
        await assert.rejects(scan(), /AI output rejected/);
      }
      assert.deepEqual(readdirSync(cache).map((p) => readFileSync(join(cache, p), "utf8")).sort(), before);
    });
    await t.test("blocked, truncated and invalid JSON responses never use cache", async () => {
      respond(valid, "SAFETY");
      await assert.rejects(scan(), /incomplete/);
      respond(valid, "MAX_TOKENS");
      await assert.rejects(scan(), /incomplete/);
      globalThis.fetch = async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{" }] } }] });
      await assert.rejects(scan(), /invalid JSON/);
      globalThis.fetch = async () => new Response("", { status: 403 });
      await assert.rejects(scan(), /rejected the API key/);
    });
    await t.test("transient outage uses only exact-image cache with new capture identity", async () => {
      globalThis.fetch = async () => new Response("", { status: 503 });
      const result = await scan("photo-one", "cap-retry");
      assert.equal(result.analyzedBy, "cache");
      assert.equal(result.captureId, "cap-retry");
      assert.match(result.notes, /CACHED.*exact file/);
      await assert.rejects(scan("different-photo"), /server error 503/);
    });
    await t.test("document cache hashes bytes instead of trusting caller hash", async () => {
      const raw = { supplierName: "Synthetic", lines: po.lines, warnings: [], embeddedInstructions: [], paymentAddress: null, currency: "USD" };
      const doc = (data: string) => analyzeDocument({ orderId: "ord-test", docId: "doc-test", kind: "purchase_order", filename: "test.pdf", mimeType: "application/pdf", sha256: "same-untrusted-hash", data: Buffer.from(data) });
      respond(raw);
      await doc("first document");
      globalThis.fetch = async () => new Response("", { status: 503 });
      await assert.rejects(doc("new document"), /server error 503/);
    });
    await t.test("document uncertainty and unsafe cents stay untrusted", async () => {
      const doc = () => analyzeDocument({ orderId: "ord-test", docId: "doc-test", kind: "purchase_order", filename: "test.pdf", mimeType: "application/pdf", sha256: "untrusted", data: Buffer.from("validation document") });
      const raw = { lines: po.lines, warnings: [], embeddedInstructions: [], paymentAddress: null };
      for (const patch of [{ confidence: 0.2 }, { unitPriceMinor: Number.MAX_SAFE_INTEGER + 1 }, { quantity: 2.5, unit: "bag" }]) {
        respond({ ...raw, lines: [{ ...po.lines[0], ...patch }] });
        const result = await doc();
        assert.equal(result.lines[0].sku, null);
        assert.ok(result.warnings.length > 0);
        assert.notEqual(result.source.sha256, "untrusted");
      }
      for (const patch of [{ lines: [] }, { embeddedInstructions: undefined }, { paymentAddress: {} }]) {
        respond({ ...raw, ...patch });
        await assert.rejects(doc(), /AI output rejected/);
      }
    });
    await t.test("a case of cans is converted in code, never read as one can", async () => {
      const doc = () => analyzeDocument({ orderId: "ord-test", docId: "doc-test", kind: "invoice", filename: "t.png", mimeType: "image/png", sha256: "x", data: Buffer.from("case document") });
      const line = { sku: "PROD-A", description: "Cola 12 oz can, 6-pack", quantity: 2, unit: "box", packSize: 6, unitPriceMinor: 600, sourceText: "2 x 6-pack @ $6.00", confidence: 0.95 };
      const raw = { lines: [line], totalMinor: 1200, warnings: [], embeddedInstructions: [], paymentAddress: null };
      respond(raw);
      const ok = await doc();
      assert.deepEqual([ok.lines[0].quantity, ok.lines[0].unit, ok.lines[0].unitPriceMinor, ok.lines[0].sku], [12, "unit", 100, "PROD-A"]);
      assert.deepEqual(ok.warnings, []);
      for (const [patch, why] of [[{ packSize: null }, /size not stated/], [{ unitPriceMinor: 599 }, /does not divide evenly/]] as const) {
        respond({ ...raw, lines: [{ ...line, ...patch }] });
        const result = await doc();
        assert.equal(result.lines[0].sku, null);
        assert.match(result.warnings.join(), why);
      }
      respond({ ...raw, totalMinor: 1500 });
      assert.match((await doc()).warnings.join(), /differs from the sum of the lines, 1200/);
    });
    await t.test("429 keeps Google's quota metadata and nothing else", async () => {
      const violation = { quotaMetric: "m", quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaDimensions: { model: "x" }, quotaValue: "20" };
      const body = { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota", details: [
        { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ ...violation, extra: "dropped" }] },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "33s" },
        { "@type": "type.googleapis.com/google.rpc.ErrorInfo", metadata: { consumer: "projects/123" } },
      ] } };
      globalThis.fetch = async () => Response.json(body, { status: 429 });
      const err: any = await scan("quota-photo").catch((e) => e);
      assert.deepEqual(err.quota, { status: "RESOURCE_EXHAUSTED", message: "quota", violations: [violation], retryDelay: "33s" });
    });
    await t.test("no key is explicitly mock and never cached Gemini", async () => {
      delete process.env.GEMINI_API_KEY;
      const result = await scan();
      assert.equal(result.analyzedBy, "mock");
      assert.match(result.notes, /^MOCK/);
    });
  } finally {
    globalThis.fetch = prior.fetch;
    if (prior.key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prior.key;
    if (prior.dir === undefined) delete process.env.CLEARDOCK_DATA_DIR; else process.env.CLEARDOCK_DATA_DIR = prior.dir;
  }
});
