/** Live HTTP smoke test. Synthetic images prove plumbing, never camera quality.
 * From repo root: node --env-file=.env --import tsx samples/check-capture-api.mts
 * Starts/stops only its own child server with a fresh temporary database.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mock = process.argv.includes("--mock");
if (!mock) assert.ok(process.env.GEMINI_API_KEY, "Configure GEMINI_API_KEY locally; this test requires live Gemini.");
const source = mock ? "mock" : "gemini";
const reservation = createServer();
await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = (reservation.address() as { port: number }).port;
await new Promise<void>((resolve, reject) => reservation.close((err) => err ? reject(err) : resolve()));
const dataDir = mkdtempSync(join(tmpdir(), "cleardock-live-http-"));
const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: join(root, "server"), windowsHide: true,
  env: { ...process.env, ...(mock ? { GEMINI_API_KEY: "" } : {}), PORT: String(port), CLEARDOCK_DATA_DIR: dataDir },
  stdio: ["ignore", "ignore", "pipe"],
});
// Do not echo arbitrary server/model output or credentials.
child.stderr?.resume();
const base = `http://127.0.0.1:${port}/api`;
async function request(path: string, init?: RequestInit) {
  const res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(120_000) });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}, code ${body.code ?? "unknown"}`);
  return body;
}
function form(file: string, field: string, mime: string) {
  const fd = new FormData();
  fd.append(field, new Blob([readFileSync(join(root, "samples", file))], { type: mime }), file.split("/").at(-1)!);
  return fd;
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("Isolated server exited before becoming ready");
    try { ready = (await request("/health")).ai === source; } catch { /* startup */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, "Isolated live server ready");
  const orders = await request("/orders");
  const id = orders[0].id;
  for (const [file, kind, mime] of [["docs/po_en.pdf", "purchase_order", "application/pdf"], ["docs/invoice_es.png", "invoice", "image/png"]]) {
    const fd = form(file, "file", mime);
    fd.append("kind", kind);
    const detail = await request(`/orders/${id}/documents`, { method: "POST", body: fd });
    assert.equal(detail.documents.at(-1).extractedBy, source);
    console.log(`PASS ${source} document upload: ${file}`);
  }
  const { session } = await request(`/orders/${id}/capture-sessions`, { method: "POST" });
  let revision = (await request(`/orders/${id}`)).order.evidenceRevision;
  for (const [file, expected] of [["all_correct.jpg", "match"], ["one_missing.jpg", "discrepancy"], ["swapped.jpg", "discrepancy"], ["label_covered.jpg", "needs_info"]]) {
    if (mock && file === "one_missing.jpg") { console.log("SKIP missing-only: no corresponding mock scenario"); continue; }
    const fd = form(`photos/synthetic/${file}`, "image", "image/jpeg");
    if (mock) fd.append("mockScenario", file === "swapped.jpg" ? "core" : file === "label_covered.jpg" ? "unreadable" : "match");
    const result = await request(`/capture-sessions/${session.code}/captures`, { method: "POST", body: fd });
    assert.equal(result.scan.analyzedBy, source);
    assert.equal(result.scan.captureId, result.capture.id);
    assert.equal(result.order.order.comparison.outcome, expected);
    assert.equal(result.order.order.approval, null);
    assert.equal(result.order.order.payment, null);
    assert.ok(result.order.order.evidenceRevision > revision);
    revision = result.order.order.evidenceRevision;
    const refreshed = await request(`/orders/${id}`);
    assert.equal(refreshed.latestScan.id, result.scan.id);
    assert.equal(refreshed.latestCapture.imageSha256, result.capture.imageSha256);
    assert.equal(refreshed.order.comparison.outcome, expected);
    console.log(`PASS SYNTHETIC ${file}: upload -> ${source} -> ${expected} -> refreshed order; revision ${revision}`);
  }
  console.log("PASS isolated HTTP smoke test. Real delivery photos and receiving UI remain unverified.");
} finally {
  child.kill();
}

