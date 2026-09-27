/**
 * Live Gemini eval of the PROVISIONAL soda documents against samples/detector/expected-docs.json.
 *
 *   node --env-file=<private key file> --import tsx samples/detector/eval-docs.mts [--write] [docs/<file> ...]
 *
 * Uses the provisional soda catalog and a fresh temp data dir (no cache hits) in this process only.
 * Refuses to run without a key: mock output proves nothing. --write saves samples/detector/eval-results.<model>.json.
 * Every attempt, pass or fail (with 429 quota metadata), is appended to samples/detector/eval-attempts.jsonl.
 * One attempt per document: no automatic retries (GEMINI_NO_RETRY). Retry by rerunning, deliberately.
 */
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
process.env.CLEARDOCK_PRODUCTS_FILE = join(here, "products.proposed.json");
process.env.CLEARDOCK_DATA_DIR = mkdtempSync(join(tmpdir(), "cleardock-eval-"));
process.env.GEMINI_NO_RETRY = "1";
if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not loaded; refusing to report mock output as an eval.");

const { analyzeDocument } = await import("../../server/src/ai/analyze.ts");
const { geminiModel } = await import("../../server/src/ai/gemini.ts");
const { adaptDetections } = await import("../../server/src/ai/detector.ts");
const { compareOrder } = await import("@cleardock/shared");

const expected = JSON.parse(readFileSync(join(here, "expected-docs.json"), "utf8"));
const example = JSON.parse(readFileSync(join(here, "detections.example.json"), "utf8"));
const mime = (f: string) => (f.endsWith(".pdf") ? "application/pdf" : "image/png") as "application/pdf" | "image/png";

const results: any[] = [];
const log = (entry: object) => appendFileSync(join(here, "eval-attempts.jsonl"), JSON.stringify({ at: new Date().toISOString(), model: geminiModel(), ...entry }) + "\n");
const docs: Record<string, any> = {};
let failed = 0;
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
for (const exp of expected.documents.filter((e: any) => only.length === 0 || only.includes(e.file))) {
  const data = readFileSync(join(here, "..", exp.file));
  const t0 = Date.now();
  let doc: any;
  try {
    doc = await analyzeDocument({ orderId: "ord_1001", docId: exp.file, kind: exp.kind, filename: exp.file, mimeType: mime(exp.file), sha256: "", data });
  } catch (err) {
    failed++;
    const quota = (err as any).quota ?? null;
    results.push({ file: exp.file, error: (err as Error).message, latencyMs: Date.now() - t0 });
    log({ file: exp.file, ok: false, latencyMs: Date.now() - t0, error: (err as Error).message, quota });
    if (quota) console.log(`   quota: ${JSON.stringify(quota)}`);
    console.log(`FAIL ${exp.file}: ${(err as Error).message}`);
    continue;
  }
  docs[exp.file] = doc;
  const checks: [string, unknown, unknown][] = [
    ["extractedBy", doc.extractedBy, "gemini"],
    ["line count", doc.lines.length, exp.lines.length],
    ["totalMinor", doc.totalMinor, exp.totalMinor],
  ];
  exp.lines.forEach((e: any, i: number) => {
    const a = doc.lines[i] ?? {};
    checks.push([`line ${i + 1} sku`, a.sku, e.sku]);
    for (const k of ["quantity", "unit", "unitPriceMinor"]) if (k in e) checks.push([`line ${i + 1} ${k}`, a[k], e[k]]);
  });
  const bad = checks.filter(([, a, e]) => a !== e);
  failed += bad.length;
  log({ file: exp.file, ok: true, extractedBy: doc.extractedBy, latencyMs: Date.now() - t0, passed: checks.length - bad.length, checks: checks.length, mismatches: bad, doc });
  console.log(`${bad.length ? "FAIL" : "PASS"} ${exp.file} (${doc.extractedBy}, ${Date.now() - t0} ms): ${checks.length - bad.length}/${checks.length}`);
  for (const [name, a, e] of bad) console.log(`   ${name}: got ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`);
  results.push({
    file: exp.file,
    extractedBy: doc.extractedBy,
    latencyMs: Date.now() - t0,
    passed: checks.length - bad.length,
    checks: checks.length,
    mismatches: bad.map(([name, got, want]) => ({ name, got, want })),
    lines: doc.lines.map((l: any) => ({ sku: l.sku, description: l.description, quantity: l.quantity, unit: l.unit, unitPriceMinor: l.unitPriceMinor, sourceText: l.sourceText })),
    totalMinor: doc.totalMinor,
    warnings: doc.warnings,
  });
}

// Comparison with a SYNTHETIC detector scan (the example fixture), to check document outcomes end to end.
const d = adaptDetections(example, { orderId: example.orderId, imageSha256: example.imageSha256 });
const scan = { ...d, id: "scan", orderId: "ord_1001", captureId: "cap", analyzedBy: "detector", analyzedAt: "" } as any;
const po = docs[expected.documents.find((e: any) => e.kind === "purchase_order").file];
for (const exp of expected.documents.filter((e: any) => e.outcome && results.some((r) => r.file === e.file))) {
  const inv = docs[exp.file];
  if (!po || !inv) { console.log(`SKIP outcome ${exp.file}: extraction failed`); continue; }
  const outcome = compareOrder({ orderId: "ord_1001", evidenceRevision: 1, purchaseOrder: po, invoice: inv, scan }).outcome;
  if (outcome !== exp.outcome) failed++;
  console.log(`${outcome === exp.outcome ? "PASS" : "FAIL"} outcome PO + ${exp.file} + synthetic detector scan: ${outcome} (expected ${exp.outcome})`);
  results.find((r) => r.file === exp.file).outcome = { got: outcome, want: exp.outcome, scan: "SYNTHETIC detector fixture" };
}

console.log(`model ${geminiModel()}, ${failed === 0 ? "all checks passed" : `${failed} failed check(s)`}`);
if (process.argv.includes("--write"))
  writeFileSync(join(here, `eval-results.${geminiModel()}${only.length ? ".partial" : ""}.json`), JSON.stringify({ ranAt: new Date().toISOString(), model: geminiModel(), catalog: "PROVISIONAL products.proposed.json", results }, null, 2) + "\n");
process.exitCode = failed ? 1 : 0;
