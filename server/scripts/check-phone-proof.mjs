// Station scan -> discrepancy -> phone proof: the station result must survive, and the photo is stored as raw
// proof (kind "live", no AI fields). Needs a running server with no Gemini key (mock AI for the station scan):
//   PORT=3101 CLEARDOCK_DATA_DIR=$(mktemp -d) STATION_TOKEN=t GEMINI_API_KEY= npx tsx src/index.ts   (in server/)
//   BASE=http://localhost:3101 EXPECT_FIX=1 node server/scripts/check-phone-proof.mjs   (from the repo root)
import { readFileSync } from "node:fs";
const B = process.env.BASE || "http://localhost:3101";
const ROOT = process.env.ROOT || ".";
const j = async (r) => { const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t } } };
const file = (p, type) => new Blob([readFileSync(`${ROOT}/${p}`)], { type });
const post = async (path, form, headers = {}) => j(await fetch(B + path, { method: "POST", body: form, headers }));
const snap = (d) => ({
  latestScanId: d.order.latestScanId, evidenceRevision: d.order.evidenceRevision, status: d.order.status,
  outcome: d.order.comparison?.outcome, missing: d.order.comparison?.lines.filter((l) => l.verdict !== "match").map((l) => `${l.description}:${l.verdict}`),
  approval: !!d.order.approval, payment: d.order.payment, escrow: d.order.escrow,
  proofs: d.proofs?.map((p) => ({ id: p.id, stationScanId: p.stationScanId, rev: p.evidenceRevision, sha: p.imageSha256?.slice(0, 8), kind: p.kind, aiFields: Object.keys(p).filter((k) => !["capture", "captureId", "createdAt", "evidenceRevision", "id", "imageSha256", "kind", "orderId", "stationCaptureId", "stationScanId"].includes(k)), img: p.capture?.imageUrl })),
});

const [order] = (await j(await fetch(`${B}/api/orders`))).body;
const oid = order.id;
for (const [kind, p, type] of [["purchase_order", "samples/docs/po_en.pdf", "application/pdf"], ["invoice", "samples/docs/invoice_es.png", "image/png"]]) {
  const f = new FormData(); f.append("kind", kind); f.append("file", file(p, type), p.split("/").pop());
  const r = await post(`/api/orders/${oid}/documents`, f); if (r.status >= 300) console.log("doc", kind, r.status, r.body);
}
const early = new FormData(); early.append("image", file("samples/photos/synthetic/all_correct.jpg", "image/jpeg"), "early.jpg");
const code0 = (await j(await fetch(`${B}/api/orders/${oid}/capture-sessions`, { method: "POST" }))).body.url.split("/").pop();
const e = await post(`/api/capture-sessions/${code0}/captures`, early);
console.log(e.status === 409 ? "PASS: phone photo before any station scan is refused (409)" : `FAIL: early phone photo got ${e.status}`);
const st = new FormData(); st.append("orderId", oid); st.append("mockScenario", "core"); st.append("fixture", "samples/photos/synthetic/swapped.jpg"); st.append("image", file("samples/photos/synthetic/swapped.jpg", "image/jpeg"), "station.jpg");
const s = await post("/api/station/captures", st, { "x-station-token": "t" });
console.log("station capture", s.status, s.status < 300 ? "" : s.body);
const before = (await j(await fetch(`${B}/api/orders/${oid}`))).body;
console.log(before.latestCapture?.fixture ? `PASS: station capture labelled as fixture (${before.latestCapture.fixture})` : "FAIL: station fixture not labelled");
console.log("AFTER STATION ", JSON.stringify(snap(before)));

const { url } = (await j(await fetch(`${B}/api/orders/${oid}/capture-sessions`, { method: "POST" }))).body;
const code = url.split("/").pop();
const ph = new FormData(); ph.append("kind", "live"); ph.append("image", file("samples/photos/synthetic/all_correct.jpg", "image/jpeg"), "phone.jpg");
const p = await post(`/api/capture-sessions/${code}/captures`, ph);
console.log("phone capture  ", p.status, p.status < 300 ? "" : JSON.stringify(p.body));
const after = (await j(await fetch(`${B}/api/orders/${oid}`))).body;
console.log("AFTER PHONE   ", JSON.stringify(snap(after)));
const same = before.order.latestScanId === after.order.latestScanId && JSON.stringify(before.order.comparison) === JSON.stringify(after.order.comparison);
console.log(same ? "PASS: station scan and comparison preserved" : "FAIL: phone upload replaced the station scan/comparison");
if (process.env.EXPECT_FIX) {
  const pr = after.proofs?.[0];
  const untouched = JSON.stringify([before.order.status, before.order.evidenceRevision, before.order.approval, before.order.payment, before.order.escrow]) === JSON.stringify([after.order.status, after.order.evidenceRevision, after.order.approval, after.order.payment, after.order.escrow]);
  const ok = untouched && pr && pr.stationScanId === before.order.latestScanId && pr.stationCaptureId === before.order.latestCaptureId && pr.evidenceRevision === before.order.evidenceRevision && pr.imageSha256 === pr.capture.imageSha256 && pr.kind === "live" && !("assessment" in pr) && e.status === 409;
  console.log(untouched ? "PASS: status, revision, approval, payment, escrow unchanged" : "FAIL: phone proof changed order state");
  console.log(ok ? "PASS: raw live proof tied to its photo and station scan, no AI assessment" : "FAIL: proof missing, badly tied, or carries an AI assessment");
  process.exitCode = same && ok ? 0 : 1;
} else process.exitCode = same ? 0 : 1;
