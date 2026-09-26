import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import multer from "multer";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareOrder,
  type ApiError,
  type Capture,
  type CaptureSource,
  type DocumentKind,
  type ExtractedDocument,
  type Order,
  type OrderDetail,
  type SensorReading,
} from "@cleardock/shared";
import { db, id, resetDb, save, UPLOAD_DIR } from "./store.ts";
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

class HttpError extends Error {
  constructor(public status: number, public code: ApiError["code"], message: string) {
    super(message);
  }
}
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

const now = () => new Date().toISOString();
const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

function getOrder(orderId: string): Order {
  const order = db.orders.find((o) => o.id === orderId);
  if (!order) throw new HttpError(404, "not_found", `Order ${orderId} not found`);
  return order;
}

function detail(order: Order): OrderDetail {
  const supplier = db.suppliers.find((s) => s.id === order.supplierId)!;
  return {
    order,
    supplier,
    documents: db.documents.filter((d) => order.documentIds.includes(d.id)),
    latestCapture: db.captures.find((c) => c.id === order.latestCaptureId) ?? null,
    latestScan: db.scans.find((s) => s.id === order.latestScanId) ?? null,
  };
}

/** Any change to evidence bumps the revision, recomputes, and voids old approvals. */
function evidenceChanged(order: Order) {
  const paying = order.payment && ["submitted", "confirmed"].includes(order.payment.status);
  if (paying) throw new HttpError(409, "conflict", "Payment already submitted; evidence is locked.");

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
  else if (order.comparison.outcome === "match") order.status = "ready_for_review";
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
}) {
  const { order, file } = args;
  if (!file.mimetype.startsWith("image/")) throw new HttpError(400, "bad_request", "Capture must be an image");

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
  };
  db.captures.push(capture);

  order.status = "analyzing";
  save();

  try {
    const scan = await analyzeScan({
      orderId: order.id,
      captureId,
      scanId: id("scan"),
      image: file.buffer,
      mimeType: file.mimetype,
      mockScenario: args.mockScenario,
    });
    db.scans.push(scan);
    order.latestCaptureId = captureId;
    order.latestScanId = scan.id;
    evidenceChanged(order);
    return { capture, scan, order: detail(order) };
  } catch (err) {
    order.status = "needs_info";
    save();
    throw new HttpError(502, "upstream_error", (err as Error).message);
  }
}

// ---------- routes: health ----------

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ai: geminiEnabled() ? "gemini" : "mock", time: now() });
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
    order.documentIds.push(doc.id);
    evidenceChanged(order);
    res.status(201).json(detail(order));
  }),
);

// ---------- routes: phone capture via QR ----------

app.post("/api/orders/:id/capture-sessions", (req, res) => {
  const order = getOrder(req.params.id);
  const code = randomBytes(4).toString("hex");
  const session = {
    id: id("ses"),
    orderId: order.id,
    code,
    createdAt: now(),
    expiresAt: new Date(Date.now() + SESSION_MINUTES * 60_000).toISOString(),
  };
  db.sessions.push(session);
  save();
  res.status(201).json({ session, url: `${PUBLIC_WEB_URL}/capture/${code}` });
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
    const result = await ingestCapture({
      order: getOrder(session.orderId),
      source: "phone",
      sessionId: session.id,
      file: req.file,
      sensors: [],
      mockScenario: req.body.mockScenario,
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
    if (!supplier.verified) throw new HttpError(409, "conflict", "Supplier wallet is not verified.");

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

    order.payment = {
      id: id("pay"),
      orderId: order.id,
      approvalId: approval.id,
      network: "devnet",
      recipient: approval.recipient,
      amountMinor: approval.amountMinor,
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

app.post(
  "/api/orders/:id/payments/confirm",
  wrap(() => {
    // TODO(backend/solana): accept { signature }, fetch the tx from SOLANA_RPC_URL,
    // check mint, amount and recipient match order.payment, then set
    // status "submitted" -> "confirmed". Until then we refuse rather than fake it.
    throw new HttpError(501, "not_implemented", "Devnet confirmation not built yet (see solana/README.md).");
  }),
);

// ---------- dev ----------

app.post("/api/dev/reset", (_req, res) => {
  resetDb();
  res.json({ ok: true });
});

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
