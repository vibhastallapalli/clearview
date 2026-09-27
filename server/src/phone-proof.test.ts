/**
 * Regression checks for station scans vs phone proof (CONTRACTS.md "Phone proof").
 *
 * Black-box: each test starts the real server as a child process on its own temp CLEARDOCK_DATA_DIR,
 * with mock AI for documents and station scans (GEMINI_API_KEY empty) and labelled fixture photos.
 * Phone photos are raw proof: no AI reads them, so nothing here depends on an AI result for them.
 *
 * Not covered here: live Gemini on station scans, the physical station (camera, scale, auto-capture).
 * Weight is uploaded with station captures but the comparison doesn't use it yet; nothing here checks weight.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import type { OrderDetail, PhoneProofView } from "@cleardock/shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, "..");
const REPO = join(SERVER_DIR, "..");

registerTests();


// ---------- harness ----------

interface Server {
  base: string;
  dataDir: string;
  stop(): Promise<void>;
}

const running = new Set<ChildProcess>();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

const supplierWallet = Keypair.generate().publicKey.toBase58();
const demoMint = Keypair.generate().publicKey.toBase58();

async function startServer(dataDir = mkdtempSync(join(tmpdir(), "cleardock-proof-"))): Promise<Server> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    CLEARDOCK_DATA_DIR: dataDir,
    STATION_TOKEN: "t",
    GEMINI_API_KEY: "",
    DEMO_SUPPLIER_WALLET: supplierWallet,
    DEMO_TOKEN_MINT: demoMint,
    ESCROW_PROGRAM_ID: "",
  };
  delete env.NODE_TEST_CONTEXT; // the child is a server, not a test reporter
  const args = ["--no-warnings", "--import", "tsx", join(HERE, "index.ts")];
  const child = spawn(process.execPath, args, { cwd: SERVER_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  running.add(child);
  let log = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 30_000);
    const onData = (b: Buffer) => {
      log += b.toString();
      if (log.includes("ClearDock server on")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("exit", (code) => reject(new Error(`server exited (${code}):\n${log}`)));
  });
  return {
    base: `http://localhost:${port}`,
    dataDir,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill();
        running.delete(child);
      }),
  };
}

after(() => {
  for (const c of running) c.kill();
});

const sha = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest("hex");
const fixture = (p: string) => readFileSync(join(REPO, p));
const PHOTOS = {
  allCorrect: "samples/photos/synthetic/all_correct.jpg",
  swapped: "samples/photos/synthetic/swapped.jpg",
  oneMissing: "samples/photos/synthetic/one_missing.jpg",
  labelCovered: "samples/photos/synthetic/label_covered.jpg",
};

async function call<T = any>(s: Server, method: string, path: string, body?: FormData | object, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body instanceof FormData) init.body = body;
  else if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const r = await fetch(s.base + path, init);
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, body: json as T };
}

const getDetail = async (s: Server, oid: string) => (await call<OrderDetail>(s, "GET", `/api/orders/${oid}`)).body;

/** Seeded order with PO + invoice attached (mock AI). */
async function orderWithDocs(s: Server): Promise<string> {
  const [order] = (await call(s, "GET", "/api/orders")).body;
  for (const [kind, p, type] of [
    ["purchase_order", "samples/docs/po_en.pdf", "application/pdf"],
    ["invoice", "samples/docs/invoice_es.png", "image/png"],
  ]) {
    const f = new FormData();
    f.append("kind", kind);
    f.append("file", new Blob([fixture(p)], { type }), p.split("/").pop());
    const r = await call(s, "POST", `/api/orders/${order.id}/documents`, f);
    assert.equal(r.status, 201, `document ${kind}: ${JSON.stringify(r.body)}`);
  }
  return order.id;
}

async function stationScan(s: Server, oid: string, scenario: "core" | "match", photo: string, weightGrams?: number) {
  const f = new FormData();
  f.append("orderId", oid);
  f.append("mockScenario", scenario);
  f.append("fixture", photo);
  if (weightGrams !== undefined) {
    f.append("weightGrams", String(weightGrams));
    f.append("simulated", "true");
  }
  f.append("image", new Blob([fixture(photo)], { type: "image/jpeg" }), "station.jpg");
  return call(s, "POST", "/api/station/captures", f, { "x-station-token": "t" });
}

async function captureSession(s: Server, oid: string) {
  const r = await call(s, "POST", `/api/orders/${oid}/capture-sessions`);
  assert.equal(r.status, 201);
  return { id: r.body.session.id as string, code: r.body.url.split("/").pop() as string };
}

async function phoneProof(s: Server, code: string, photo: string, kind: string | null = "live") {
  const f = new FormData();
  if (kind !== null) f.append("kind", kind);
  f.append("image", new Blob([fixture(photo)], { type: "image/jpeg" }), "phone.jpg");
  return call<{ capture: any; proof: PhoneProofView; order: OrderDetail }>(s, "POST", `/api/capture-sessions/${code}/captures`, f);
}

/** Everything a phone photo must never change. */
const authoritative = (d: OrderDetail) => ({
  latestCaptureId: d.order.latestCaptureId,
  latestScanId: d.order.latestScanId,
  comparison: d.order.comparison,
  evidenceRevision: d.order.evidenceRevision,
  status: d.order.status,
  approval: d.order.approval,
  payment: d.order.payment,
  escrow: d.order.escrow,
  latestCapture: d.latestCapture,
  latestScan: d.latestScan,
});

/** Phone proof is raw evidence: exactly these fields, no AI verdict of any kind. */
function assertRawProof(p: PhoneProofView, kind: "live" | "upload") {
  assert.deepEqual(
    Object.keys(p).sort(),
    ["capture", "captureId", "createdAt", "evidenceRevision", "id", "imageSha256", "kind", "orderId", "stationCaptureId", "stationScanId"],
  );
  assert.equal(p.kind, kind);
  assert.equal(p.capture.source, "phone");
}

// ---------- tests ----------

function registerTests() {
  describe("phone proof vs station scan", { concurrency: false }, () => {
    test("station scan creates the expected comparison and is labelled as a fixture", async () => {
      const s = await startServer();
      try {
        const oid = await orderWithDocs(s);
        const before = await getDetail(s, oid);
        const r = await stationScan(s, oid, "core", PHOTOS.swapped, 1500);
        assert.equal(r.status, 201, JSON.stringify(r.body));
        const d = await getDetail(s, oid);

        assert.equal(d.order.evidenceRevision, before.order.evidenceRevision + 1);
        assert.equal(d.order.latestScanId, r.body.scan.id);
        assert.equal(d.order.latestCaptureId, r.body.capture.id);
        assert.equal(d.latestCapture?.source, "station");
        assert.equal(d.latestCapture?.fixture, PHOTOS.swapped, "fixture photo must be labelled");
        assert.deepEqual(d.latestCapture?.sensors.map((x) => [x.kind, x.simulated]), [["weight", true]]);
        assert.equal(d.latestScan?.analyzedBy, "mock");

        assert.equal(d.order.status, "discrepancy");
        assert.equal(d.order.comparison?.outcome, "discrepancy");
        assert.equal(d.order.comparison?.evidenceRevision, d.order.evidenceRevision);
        const off = d.order.comparison!.lines.filter((l) => l.verdict !== "match").map((l) => l.verdict).sort();
        assert.deepEqual(off, ["missing", "unexpected"], "core scenario: one Product A missing, one Product B not ordered");
        assert.deepEqual(d.proofs, []);
      } finally {
        await s.stop();
      }
    });

    test("phone photo before any station scan is refused and stores nothing", async () => {
      const s = await startServer();
      try {
        const oid = await orderWithDocs(s);
        const before = await getDetail(s, oid);
        const { code } = await captureSession(s, oid);
        const r = await phoneProof(s, code, PHOTOS.allCorrect);
        assert.equal(r.status, 409);
        assert.equal((r.body as any).code, "conflict");
        const d = await getDetail(s, oid);
        assert.deepEqual(d.proofs, []);
        assert.deepEqual(authoritative(d), authoritative(before));
      } finally {
        await s.stop();
      }
    });

    test("a live photo is stored as raw proof with no AI verdict and changes nothing on the order", async () => {
      const s = await startServer();
      try {
        const oid = await orderWithDocs(s);
        assert.equal((await stationScan(s, oid, "core", PHOTOS.swapped)).status, 201);
        const before = await getDetail(s, oid);
        const { id: sessionId, code } = await captureSession(s, oid);
        const r = await phoneProof(s, code, PHOTOS.allCorrect, "live");
        assert.equal(r.status, 201, JSON.stringify(r.body));

        const d = await getDetail(s, oid);
        assert.deepEqual(authoritative(d), authoritative(before), "phone proof changed authoritative order state");
        assert.equal(d.order.status, "discrepancy", "a photo must not clear the discrepancy");
        assert.deepEqual(authoritative(r.body.order), authoritative(d), "response order differs from GET");

        assert.equal(d.proofs.length, 1);
        const p = d.proofs[0];
        assertRawProof(p, "live");
        assert.equal(p.stationScanId, before.order.latestScanId);
        assert.equal(p.stationCaptureId, before.order.latestCaptureId);
        assert.equal(p.evidenceRevision, before.order.evidenceRevision);
        assert.equal(p.capture.source, "phone");
        assert.equal(p.capture.sessionId, sessionId);
        assert.equal(p.imageSha256, sha(fixture(PHOTOS.allCorrect)));

        // Approval is still blocked: the discrepancy stands.
        const a = await call(s, "POST", `/api/orders/${oid}/approve`, { evidenceRevision: d.order.evidenceRevision });
        assert.equal(a.status, 409);
      } finally {
        await s.stop();
      }
    });

    test("only an explicit 'live' is a live photo; missing or other kinds are stored as uploaded files", async () => {
      const s = await startServer();
      try {
        const oid = await orderWithDocs(s);
        assert.equal((await stationScan(s, oid, "core", PHOTOS.swapped)).status, 201);
        const before = await getDetail(s, oid);
        const { code } = await captureSession(s, oid);
        for (const kind of ["upload", null, "LIVE", "live "]) {
          const r = await phoneProof(s, code, PHOTOS.oneMissing, kind);
          assert.equal(r.status, 201, JSON.stringify(r.body));
          assert.equal(r.body.proof.kind, "upload", `kind ${JSON.stringify(kind)}`);
          assert.ok(!("assessment" in r.body.proof), "phone proof must carry no AI assessment");
        }
        const d = await getDetail(s, oid);
        assert.equal(d.proofs.length, 4);
        for (const p of d.proofs) assertRawProof(p, "upload");
        assert.deepEqual(authoritative(d), authoritative(before));
      } finally {
        await s.stop();
      }
    });

    test("phone proof after approval, payment and escrow leaves all of them untouched", async () => {
      let s = await startServer();
      const dataDir = s.dataDir;
      try {
        const oid = await orderWithDocs(s);
        assert.equal((await stationScan(s, oid, "match", PHOTOS.allCorrect)).status, 201);
        const ready = await getDetail(s, oid);
        assert.equal(ready.order.status, "ready_for_review");
        const ap = await call(s, "POST", `/api/orders/${oid}/approve`, { evidenceRevision: ready.order.evidenceRevision });
        assert.equal(ap.status, 200, JSON.stringify(ap.body));
        const pay = await call(s, "POST", `/api/orders/${oid}/payments`);
        assert.equal(pay.status, 201, JSON.stringify(pay.body));

        const before = await getDetail(s, oid);
        assert.ok(before.order.approval);
        assert.equal(before.order.payment?.status, "awaiting_signature");
        const { code } = await captureSession(s, oid);
        const r1 = await phoneProof(s, code, PHOTOS.oneMissing);
        assert.equal(r1.status, 201, JSON.stringify(r1.body));
        assert.deepEqual(authoritative(await getDetail(s, oid)), authoritative(before));

        // Put the order into "paid through escrow" directly in storage (no chain in tests), then reload.
        await s.stop();
        const dbFile = join(dataDir, "db.json");
        const db = JSON.parse(readFileSync(dbFile, "utf8"));
        const o = db.orders.find((x: any) => x.id === oid);
        o.payment = { ...o.payment, status: "confirmed", signature: "test-signature" };
        o.status = "payment_confirmed";
        o.escrow = {
          programId: "test-program", escrowAddress: "test-escrow", buyer: "test-buyer", supplier: supplierWallet, mint: demoMint,
          totalMinor: o.approval.amountMinor, releasedMinor: 2000, claimedMinor: 1000, refundedMinor: 0, status: "claimed",
          events: [{ action: "fund", signature: "test-fund", at: new Date().toISOString() }],
        };
        writeFileSync(dbFile, JSON.stringify(db, null, 2));
        s = await startServer(dataDir);

        const paid = await getDetail(s, oid);
        const r2 = await phoneProof(s, (await captureSession(s, oid)).code, PHOTOS.labelCovered);
        assert.equal(r2.status, 201, "phone proof must be allowed after payment");
        const d = await getDetail(s, oid);
        assert.deepEqual(authoritative(d), authoritative(paid), "phone proof changed a paid/escrowed order");
        assert.equal(d.order.escrow?.status, "claimed");
        assert.equal(d.order.payment?.status, "confirmed");
        assert.equal(d.proofs.length, 2);

        // Contrast: a station scan on a paid order is refused (evidence locked).
        assert.equal((await stationScan(s, oid, "core", PHOTOS.swapped)).status, 409);
      } finally {
        await s.stop();
      }
    });

    test("multiple proofs keep their own photo, session and station scan; a new station scan leaves old proofs alone", async () => {
      const s = await startServer();
      try {
        const oid = await orderWithDocs(s);
        assert.equal((await stationScan(s, oid, "core", PHOTOS.swapped)).status, 201);
        const first = await getDetail(s, oid);

        const s1 = await captureSession(s, oid);
        const s2 = await captureSession(s, oid);
        const uploads = [
          { session: s1, photo: PHOTOS.allCorrect },
          { session: s2, photo: PHOTOS.oneMissing },
          { session: s1, photo: PHOTOS.labelCovered },
        ];
        const proofIds: string[] = [];
        for (const u of uploads) {
          const r = await phoneProof(s, u.session.code, u.photo);
          assert.equal(r.status, 201);
          assert.equal(r.body.proof.captureId, r.body.capture.id);
          proofIds.push(r.body.proof.id);
        }

        const d = await getDetail(s, oid);
        assert.deepEqual(d.proofs.map((p) => p.id), [...proofIds].reverse(), "proofs must be newest first");
        const byId = new Map(d.proofs.map((p) => [p.id, p]));
        uploads.forEach((u, i) => {
          const p = byId.get(proofIds[i])!;
          assert.equal(p.capture.id, p.captureId);
          assert.equal(p.capture.sessionId, u.session.id);
          assert.equal(p.imageSha256, sha(fixture(u.photo)), `proof ${i + 1} is tied to the wrong photo`);
          assert.equal(p.capture.imageSha256, p.imageSha256);
          assert.equal(p.stationScanId, first.order.latestScanId);
          assert.equal(p.evidenceRevision, first.order.evidenceRevision);
        });
        assert.equal(new Set(d.proofs.map((p) => p.capture.imageUrl)).size, 3);

        // New station scan: becomes authoritative; old proofs keep pointing at the earlier scan.
        assert.equal((await stationScan(s, oid, "match", PHOTOS.allCorrect)).status, 201);
        const second = await getDetail(s, oid);
        assert.notEqual(second.order.latestScanId, first.order.latestScanId);
        assert.equal(second.order.status, "ready_for_review");
        assert.deepEqual(second.proofs, d.proofs, "a station scan rewrote existing proofs");

        const r = await phoneProof(s, s2.code, PHOTOS.allCorrect);
        assert.equal(r.status, 201);
        assert.equal(r.body.proof.stationScanId, second.order.latestScanId);
        assert.equal(r.body.proof.evidenceRevision, second.order.evidenceRevision);
        const stale = (await getDetail(s, oid)).proofs.filter((p) => p.stationScanId !== second.order.latestScanId);
        assert.equal(stale.length, 3, "the three earlier proofs must read as assessed against an earlier station scan");
      } finally {
        await s.stop();
      }
    });

    test("proofs survive a server reload with their kind and serve the exact photo bytes", async () => {
      let s = await startServer();
      const dataDir = s.dataDir;
      try {
        const oid = await orderWithDocs(s);
        assert.equal((await stationScan(s, oid, "core", PHOTOS.swapped)).status, 201);
        const { code } = await captureSession(s, oid);
        assert.equal((await phoneProof(s, code, PHOTOS.oneMissing, "live")).status, 201);
        assert.equal((await phoneProof(s, code, PHOTOS.labelCovered, "upload")).status, 201);
        const before = await getDetail(s, oid);

        await s.stop();
        s = await startServer(dataDir);
        // Buyer and supplier read the same endpoint (CONTRACTS.md: no per-role views yet).
        const d = await getDetail(s, oid);
        assert.deepEqual(d.proofs, before.proofs);
        assert.deepEqual(authoritative(d), authoritative(before));
        assert.deepEqual(d.proofs.map((p) => p.kind), ["upload", "live"]);
        for (const p of d.proofs) {
          const img = await fetch(s.base + p.capture.imageUrl);
          assert.equal(img.status, 200, `photo ${p.capture.imageUrl} not retrievable`);
          assert.equal(sha(Buffer.from(await img.arrayBuffer())), p.imageSha256, "served photo differs from the recorded hash");
        }

        // A proof saved before phone photos stopped being AI-assessed: its old verdict stays on disk, never served.
        await s.stop();
        const dbFile = join(dataDir, "db.json");
        const db = JSON.parse(readFileSync(dbFile, "utf8"));
        const legacy = db.proofs.find((p: { kind: string }) => p.kind === "live");
        delete legacy.kind;
        legacy.assessment = { status: "complete", verdict: "supports", summary: "Photo agrees with the station result.", analyzedBy: "gemini" };
        writeFileSync(dbFile, JSON.stringify(db));
        s = await startServer(dataDir);
        const after = await getDetail(s, oid);
        for (const p of after.proofs) assertRawProof(p, "upload");
        assert.ok(JSON.parse(readFileSync(dbFile, "utf8")).proofs.some((p: { assessment?: unknown }) => p.assessment), "stored data must not be rewritten");
      } finally {
        await s.stop();
      }
    });
  });
}
