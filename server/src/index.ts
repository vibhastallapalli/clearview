import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import multer from "multer";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  compareOrder,
  type ApiError,
  type Capture,
  type CaptureSession,
  type CaptureSource,
  type DocumentKind,
  type ExtractedDocument,
  type Order,
  type OrderDetail,
  type PhoneProof,
  type ProofKind,
  type SensorReading,
} from "@cleardock/shared";
import { Connection } from "@solana/web3.js";
import { db, id, orderDetail, resetDb, save, UPLOAD_DIR } from "./store.ts";
import {
  assertEvidenceUnlocked,
  assertNoLiveTransaction,
  confirmPayment,
  hasIssuedAttempt,
  HttpError,
  issueTransaction,
  submitSignedTransaction,
  type PaymentCtx,
} from "./solana/payments.ts";
import { escrowRouter } from "./escrow.ts";
import { configuredMint, isValidAmount, isWallet, publicConfig, rpcUrl } from "./solana/tx.ts";
import { analyzeDocument, analyzeScan, type MockScenario } from "./ai/analyze.ts";
import { geminiEnabled } from "./ai/gemini.ts";

const app = express();
app.use(cors());
app.use(express.json());
app.use("/files", express.static(UPLOAD_DIR));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const PORT = Number(process.env.PORT || 3001);
const PUBLIC_WEB_URL = process.env.PUBLIC_WEB_URL || "http://localhost:5173";
const SESSION_MINUTES = 15;

// ---------- helpers ----------

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

const now = () => new Date().toISOString();
const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

const solana: PaymentCtx = {
  rpc: new Connection(rpcUrl(), "confirmed"),
  get attempts() {
    return db.paymentAttempts; // getter: resetDb swaps the array
  },
  save,
  newId: id,
};

const LOCKED = "A payment transaction was issued and could still land; evidence is locked until it expires or confirms.";

function getOrder(orderId: string): Order {
  const order = db.orders.find((o) => o.id === orderId);
  if (!order) throw new HttpError(404, "not_found", `Order ${orderId} not found`);
  return order;
}

const detail = orderDetail;

/** Any change to evidence bumps the revision, recomputes, and voids old approvals. */
function evidenceChanged(order: Order) {
  const paying = order.payment && ["submitted", "unknown", "confirmed"].includes(order.payment.status);
  if (paying) throw new HttpError(409, "conflict", "Payment already submitted; evidence is locked.");
  if (hasIssuedAttempt(order.id, db.paymentAttempts)) throw new HttpError(409, "conflict", LOCKED);

  order.evidenceRevision += 1;
  order.approval = null;
  order.payment = null;

  const docs = db.documents.filter((d) => order.documentIds.includes(d.id));
  const latest = (kind: DocumentKind) => docs.filter((d) => d.kind === kind).at(-1);
  const scan = db.scans.find((s) => s.id === order.latestScanId);

  order.comparison = compareOrder({
    orderId: order.id,
    evidenceRevision: order.evidenceRevision,
    purchaseOrder: latest("purchase_order"),
    invoice: latest("invoice"),
    scan,
  });

  if (!latest("purchase_order") || !latest("invoice")) order.status = "needs_documents";
  else if (order.comparison.outcome === "match" && !order.comparison.flags?.length) order.status = "ready_for_review";
  else if (order.comparison.outcome === "discrepancy") order.status = "discrepancy";
  else order.status = "needs_info";

  order.updatedAt = now();
  save();
}

async function ingestCapture(args: {
  order: Order;
  source: CaptureSource;
  sessionId: string | null;
  file: Express.Multer.File;
  sensors: SensorReading[];
  mockScenario?: MockScenario;
  fixture?: string | null;
}) {
  const { order, file } = args;
  if (!file.mimetype.startsWith("image/")) throw new HttpError(400, "bad_request", "Capture must be an image");
  await assertEvidenceUnlocked(order, solana);
  const capture = saveCapture(args);
  const captureId = capture.id;

  const prevStatus = order.status;
  order.status = "analyzing";
  save();

  let scan;
  try {
    scan = await analyzeScan({
      orderId: order.id,
      captureId,
      scanId: id("scan"),
      image: file.buffer,
      mimeType: file.mimetype,
      mockScenario: args.mockScenario,
    });
  } catch (err) {
    order.status = "needs_info";
    save();
    throw new HttpError(502, "upstream_error", (err as Error).message);
  }
  db.scans.push(scan);
  unlessPaymentIssuedMeanwhile(order, prevStatus);
  order.latestCaptureId = captureId;
  order.latestScanId = scan.id;
  evidenceChanged(order);
  return { capture, scan, order: detail(order) };
}

/** Stores the image file and its Capture record. Changes nothing else on the order. */
function saveCapture(args: { order: Order; source: CaptureSource; sessionId: string | null; file: Express.Multer.File; sensors: SensorReading[]; fixture?: string | null }): Capture {
  const { order, file } = args;
  const captureId = id("cap");
  const ext = file.mimetype === "image/png" ? "png" : "jpg";
  const filename = `${captureId}.${ext}`;
  writeFileSync(join(UPLOAD_DIR, filename), file.buffer);

  const capture: Capture = {
    id: captureId,
    orderId: order.id,
    sessionId: args.sessionId,
    source: args.source,
    imageUrl: `/files/${filename}`,
    imageSha256: sha256(file.buffer),
    capturedAt: now(),
    sensors: args.sensors,
    fixture: args.fixture ?? null,
  };
  db.captures.push(capture);
  save();
  return capture;
}

/**
 * Phone photo = raw proof for the current station result, for the supplier to judge. No AI reads it.
 * Never changes latestScanId, the comparison, evidenceRevision, status, approval, payment or escrow,
 * so it is allowed after payment too.
 */
function attachPhoneProof(args: { order: Order; sessionId: string | null; file: Express.Multer.File; kind: ProofKind; fixture?: string | null }) {
  const { order, file } = args;
  if (!file.mimetype.startsWith("image/")) throw new HttpError(400, "bad_request", "Capture must be an image");
  const stationScan = db.scans.find((s) => s.id === order.latestScanId);
  const stationCapture = db.captures.find((c) => c.id === stationScan?.captureId);
  if (!stationScan || stationCapture?.source !== "station" || !order.comparison)
    throw new HttpError(409, "conflict", "No station scan yet. Phone photos are proof for a station result; scan the delivery at the station first.");

  const capture = saveCapture({ order, source: "phone", sessionId: args.sessionId, file, sensors: [], fixture: args.fixture });
  const proof: PhoneProof = {
    id: id("prf"),
    orderId: order.id,
    captureId: capture.id,
    imageSha256: capture.imageSha256,
    kind: args.kind,
    stationScanId: stationScan.id,
    stationCaptureId: stationCapture.id,
    evidenceRevision: order.evidenceRevision,
    createdAt: now(),
  };
  db.proofs.push(proof);
  save();
  return { capture, proof, order: detail(order) };
}

/** A payment transaction may have been issued while the AI was analyzing; then keep the old evidence. */
function unlessPaymentIssuedMeanwhile(order: Order, prevStatus: Order["status"]) {
  if (!hasIssuedAttempt(order.id, db.paymentAttempts)) return;
  order.status = prevStatus;
  save();
  throw new HttpError(409, "conflict", LOCKED);
}

// ---------- routes: health ----------

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ai: geminiEnabled() ? "gemini" : "mock", time: now() });
});

app.get("/api/config", (_req, res) => {
  res.json(publicConfig());
});

// ---------- routes: orders ----------

app.get("/api/orders", (_req, res) => {
  res.json(db.orders.map((o) => ({ ...o, supplierName: db.suppliers.find((s) => s.id === o.supplierId)?.name })));
});

app.get("/api/orders/:id", (req, res) => {
  res.json(detail(getOrder(req.params.id)));
});

app.post(
  "/api/orders/:id/documents",
  upload.single("file"),
  wrap(async (req, res) => {
    const order = getOrder(req.params.id);
    const kind = req.body.kind as DocumentKind;
    if (!["purchase_order", "invoice", "delivery_receipt"].includes(kind))
      throw new HttpError(400, "bad_request", "kind must be purchase_order, invoice or delivery_receipt");
    const file = req.file;
    if (!file) throw new HttpError(400, "bad_request", "file is required");
    const allowed = ["application/pdf", "image/png", "image/jpeg"] as const;
    if (!allowed.includes(file.mimetype as (typeof allowed)[number]))
      throw new HttpError(400, "bad_request", "Only PDF, PNG or JPEG");

    await assertEvidenceUnlocked(order, solana);
    const prevStatus = order.status;
    order.status = "analyzing";
    save();
    let doc: ExtractedDocument;
    try {
      doc = await analyzeDocument({
        orderId: order.id,
        kind,
        filename: file.originalname,
        mimeType: file.mimetype as ExtractedDocument["source"]["mimeType"],
        sha256: sha256(file.buffer),
        data: file.buffer,
        docId: id("doc"),
      });
    } catch (err) {
      order.status = "needs_info";
      save();
      throw new HttpError(502, "upstream_error", (err as Error).message);
    }
    db.documents.push(doc);
    unlessPaymentIssuedMeanwhile(order, prevStatus);
    order.documentIds.push(doc.id);
    evidenceChanged(order);
    res.status(201).json(detail(order));
  }),
);

// ---------- routes: phone capture via QR ----------

function createSession(order: Order, purpose: "proof" | "station") {
  const code = randomBytes(4).toString("hex");
  const session: CaptureSession = {
    id: id("ses"),
    orderId: order.id,
    code,
    createdAt: now(),
    expiresAt: new Date(Date.now() + SESSION_MINUTES * 60_000).toISOString(),
    purpose,
  };
  db.sessions.push(session);
  save();
  return { session, url: `${PUBLIC_WEB_URL}/capture/${code}` };
}

app.post("/api/orders/:id/capture-sessions", (req, res) => {
  res.status(201).json(createSession(getOrder(req.params.id), "proof"));
});

// Test aid until the station hardware exists: a QR link whose photos are the SIMULATED station scan.
// Like /dev/reset, this must not be exposed in a real deployment.
app.post("/api/dev/orders/:id/station-sessions", (req, res) => {
  res.status(201).json(createSession(getOrder(req.params.id), "station"));
});

function getSession(code: string) {
  const session = db.sessions.find((s) => s.code === code);
  if (!session) throw new HttpError(404, "not_found", "Capture link not found");
  if (Date.parse(session.expiresAt) < Date.now()) throw new HttpError(410 as number, "bad_request", "Capture link expired. Scan a new QR code.");
  return session;
}

app.get("/api/capture-sessions/:code", (req, res) => {
  const session = getSession(req.params.code);
  const order = getOrder(session.orderId);
  res.json({ session, orderReference: order.reference });
});

app.post(
  "/api/capture-sessions/:code/captures",
  upload.single("image"),
  wrap(async (req, res) => {
    const session = getSession(req.params.code);
    if (!req.file) throw new HttpError(400, "bad_request", "image is required");
    if (session.purpose === "station") {
      const result = await ingestCapture({
        order: getOrder(session.orderId),
        source: "station",
        sessionId: session.id,
        file: req.file,
        sensors: [],
        fixture: "Simulated station camera: phone photo via QR",
      });
      return void res.status(201).json(result);
    }
    const result = attachPhoneProof({
      order: getOrder(session.orderId),
      sessionId: session.id,
      file: req.file,
      // Only the in-app camera may claim "live"; anything else is additional evidence.
      kind: req.body.kind === "live" ? "live" : "upload",
    });
    res.status(201).json(result);
  }),
);

// ---------- routes: receiving station (hardware) ----------

app.post(
  "/api/station/captures",
  upload.single("image"),
  wrap(async (req, res) => {
    if (req.header("x-station-token") !== (process.env.STATION_TOKEN || "change-me"))
      throw new HttpError(401, "unauthorized", "Bad station token");
    if (!req.file) throw new HttpError(400, "bad_request", "image is required");
    const sensors: SensorReading[] = [];
    if (req.body.weightGrams !== undefined && req.body.weightGrams !== "") {
      const grams = Number(req.body.weightGrams);
      if (!Number.isFinite(grams)) throw new HttpError(400, "bad_request", "weightGrams must be a number");
      sensors.push({ kind: "weight", grams, simulated: req.body.simulated === "true", readAt: now() });
    }
    const result = await ingestCapture({
      order: getOrder(String(req.body.orderId)),
      source: "station",
      sessionId: null,
      file: req.file,
      sensors,
      mockScenario: req.body.mockScenario,
      fixture: typeof req.body.fixture === "string" && req.body.fixture.trim() ? req.body.fixture.trim() : null,
    });
    res.status(201).json(result);
  }),
);

// ---------- routes: approval and payment ----------

app.post(
  "/api/orders/:id/approve",
  wrap((req, res) => {
    const order = getOrder(req.params.id);
    const supplier = db.suppliers.find((s) => s.id === order.supplierId)!;
    if (req.body.evidenceRevision !== order.evidenceRevision)
      throw new HttpError(409, "stale_approval", "Evidence changed since you reviewed it. Review again.");
    if (order.status !== "ready_for_review" || order.comparison?.outcome !== "match")
      throw new HttpError(409, "conflict", "Only matched orders can be approved in Phase 1.");
    if (order.comparison.flags?.length)
      throw new HttpError(409, "conflict", `Blocking flags must be resolved first: ${order.comparison.flags.join("; ")}`);
    if (!supplier.verified) throw new HttpError(409, "conflict", "Supplier wallet is not verified.");
    const envWallet = process.env.DEMO_SUPPLIER_WALLET?.trim();
    if (envWallet && envWallet !== supplier.walletAddress)
      throw new HttpError(409, "conflict", "Supplier wallet differs from DEMO_SUPPLIER_WALLET. Reset demo data (POST /api/dev/reset) after changing it.");
    if (!isWallet(supplier.walletAddress))
      throw new HttpError(409, "conflict", "Supplier wallet is not a valid Solana address (see shared/fixtures/supplier.json).");
    if (!isValidAmount(order.comparison.billedTotalMinor))
      throw new HttpError(409, "conflict", "Approved amount must be a positive whole number of cents.");

    order.approval = {
      id: id("apr"),
      orderId: order.id,
      evidenceRevision: order.evidenceRevision,
      recipient: supplier.walletAddress,
      amountMinor: order.comparison.billedTotalMinor,
      approvedAt: now(),
    };
    order.status = "approved";
    order.updatedAt = now();
    save();
    res.json(detail(order));
  }),
);

app.post(
  "/api/orders/:id/payments",
  wrap((req, res) => {
    const order = getOrder(req.params.id);
    const approval = order.approval;
    if (!approval || approval.evidenceRevision !== order.evidenceRevision)
      throw new HttpError(409, "stale_approval", "No valid approval for the current evidence.");
    // Idempotent: repeated clicks return the same payment.
    if (order.payment && order.payment.approvalId === approval.id) return res.json(detail(order));
    if (order.escrow) throw new HttpError(409, "conflict", "This order is funded through escrow; pay by releasing the escrow, not directly.");
    const mint = configuredMint();
    if (!mint) throw new HttpError(409, "conflict", "DEMO_TOKEN_MINT is not set on the server.");

    const paymentId = id("pay");
    order.payment = {
      id: paymentId,
      orderId: order.id,
      approvalId: approval.id,
      network: "devnet",
      recipient: approval.recipient,
      amountMinor: approval.amountMinor,
      mint,
      payer: null,
      lastValidBlockHeight: null,
      memo: `ClearDock ${order.reference} ${paymentId}`,
      idempotencyKey: `${order.id}:${approval.id}`,
      status: "awaiting_signature",
      signature: null,
      error: null,
      updatedAt: now(),
    };
    order.status = "awaiting_signature";
    save();
    res.status(201).json(detail(order));
  }),
);

// Unsigned transfer for the buyer's wallet to sign. The server never signs.
app.post(
  "/api/orders/:id/payments/transaction",
  wrap(async (req, res) => {
    res.json(await issueTransaction(getOrder(req.params.id), req.body?.payer, solana));
  }),
);

// Supported signing flow: the wallet signs only; the server checks the bytes, records the signature, broadcasts.
app.post(
  "/api/orders/:id/payments/submit",
  wrap(async (req, res) => {
    const order = getOrder(req.params.id);
    await submitSignedTransaction(order, req.body?.transaction, solana);
    res.json(detail(order));
  }),
);

// Verifies the landed transaction on devnet. Same signature again = re-check.
app.post(
  "/api/orders/:id/payments/confirm",
  wrap(async (req, res) => {
    const order = getOrder(req.params.id);
    await confirmPayment(order, req.body?.signature, solana);
    res.json(detail(order));
  }),
);

// ---------- escrow (P4): records verified on-chain escrow events ----------

app.use(escrowRouter);

// ---------- dev ----------

// Test aid until the station hardware exists: an uploaded photo goes through the real station path
// (AI count -> comparison -> discrepancy), labelled as a fixture so the UI shows SIMULATED.
// Like /dev/reset, this must not be exposed in a real deployment.
app.post(
  "/api/dev/orders/:id/station-photo",
  upload.single("image"),
  wrap(async (req, res) => {
    if (!req.file) throw new HttpError(400, "bad_request", "image is required");
    const result = await ingestCapture({
      order: getOrder(req.params.id),
      source: "station",
      sessionId: null,
      file: req.file,
      sensors: [],
      fixture: "Simulated station camera: photo uploaded in the app",
    });
    res.status(201).json(result);
  }),
);

// Test aid: attach a synthetic tray photo as additional evidence ("upload"), labelled as a fixture so
// the UI shows SIMULATED. Like /dev/reset, this must not be exposed in a real deployment.
const SAMPLE_PROOFS = ["all_correct", "one_missing", "swapped", "label_covered"];
app.post(
  "/api/dev/orders/:id/sample-proof",
  wrap(async (req, res) => {
    const sample = String(req.body?.sample ?? "");
    if (!SAMPLE_PROOFS.includes(sample)) throw new HttpError(400, "bad_request", `sample must be one of ${SAMPLE_PROOFS.join(", ")}`);
    const fixture = `samples/photos/synthetic/${sample}.jpg`;
    const buffer = readFileSync(fileURLToPath(new URL(`../../${fixture}`, import.meta.url)));
    const result = attachPhoneProof({
      order: getOrder(req.params.id),
      sessionId: null,
      file: { buffer, mimetype: "image/jpeg" } as Express.Multer.File,
      kind: "upload",
      fixture,
    });
    res.status(201).json(result);
  }),
);

// Rehearse again: archives orders that had a payment transaction, seeds a fresh demo order.
app.post(
  "/api/dev/reset",
  wrap(async (_req, res) => {
    for (const order of db.orders) await assertNoLiveTransaction(order, solana);
    const order = resetDb();
    res.json({ ok: true, orderId: order.id, reference: order.reference });
  }),
);

// ---------- errors ----------

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code } satisfies ApiError);
  } else {
    console.error(err);
    res.status(500).json({ error: (err as Error)?.message ?? "Server error", code: "upstream_error" });
  }
});

app.listen(PORT, () => {
  console.log(`ClearDock server on http://localhost:${PORT}  (AI: ${geminiEnabled() ? "Gemini" : "MOCK"})`);
});
