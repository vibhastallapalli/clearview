import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgreementState,
  Capture,
  CaptureSession,
  ExtractedDocument,
  Order,
  OrderDetail,
  PhoneProof,
  PhoneProofView,
  ScanResult,
  Supplier,
} from "@cleardock/shared";
import type { PaymentAttempt } from "./solana/payments.ts";

/**
 * Tiny JSON-file store. Good enough for a hackathon demo; swap for SQLite
 * later without changing the route handlers (keep this interface).
 */

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.CLEARDOCK_DATA_DIR || join(here, "..", "data");
export const UPLOAD_DIR = join(DATA_DIR, "uploads");
const DB_FILE = join(DATA_DIR, "db.json");
const FIXTURES = join(here, "..", "..", "shared", "fixtures");

interface Db {
  suppliers: Supplier[];
  orders: Order[];
  documents: ExtractedDocument[];
  sessions: CaptureSession[];
  captures: Capture[];
  scans: ScanResult[];
  /** Phone photos attached as proof to a station scan. Never drive the comparison. */
  proofs: PhoneProof[];
  /** Every unsigned payment transaction ever issued. Survives approval voids. */
  paymentAttempts: PaymentAttempt[];
  /** Orders that had a payment transaction issued, set aside by a demo reset. Kept for the record. */
  archivedOrders: Order[];
  /** Claim negotiation per order. */
  agreements: AgreementRecord[];
}

/** An agreement plus the signed writes applied at each revision (so a retried write is recognised, not re-applied). */
export type AgreementRecord = AgreementState & { log: { revision: number; key: string }[] };

mkdirSync(UPLOAD_DIR, { recursive: true });

/** Rehearsal 1 is ord_1001 / PO-1001; later rehearsals get fresh identities (ord_1001_r2 / PO-1001-R2). */
function seed(rehearsal = 1): Db {
  const supplier = JSON.parse(readFileSync(join(FIXTURES, "supplier.json"), "utf8")) as Supplier;
  // The demo supplier's devnet wallet comes from .env (same value setup-devnet uses), never from AI output.
  const envWallet = process.env.DEMO_SUPPLIER_WALLET?.trim();
  if (envWallet) supplier.walletAddress = envWallet;
  const now = new Date().toISOString();
  return {
    suppliers: [supplier],
    orders: [
      {
        id: rehearsal === 1 ? "ord_1001" : `ord_1001_r${rehearsal}`,
        reference: rehearsal === 1 ? "PO-1001" : `PO-1001-R${rehearsal}`,
        supplierId: supplier.id,
        currency: "USD",
        status: "needs_documents",
        evidenceRevision: 0,
        documentIds: [],
        latestCaptureId: null,
        latestScanId: null,
        comparison: null,
        approval: null,
        payment: null,
        escrow: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    documents: [],
    sessions: [],
    captures: [],
    scans: [],
    proofs: [],
    paymentAttempts: [],
    archivedOrders: [],
    agreements: [],
  };
}

export const db: Db = existsSync(DB_FILE) ? JSON.parse(readFileSync(DB_FILE, "utf8")) : seed();
// Older db.json files predate contracts v2.
db.paymentAttempts ??= [];
db.archivedOrders ??= [];
db.proofs ??= [];
db.agreements ??= [];
for (const o of db.orders) o.escrow ??= null;

export function save() {
  writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

/**
 * Demo reset. An order that ever had a payment transaction issued or an escrow is archived
 * (with its evidence), never reset in place, and the fresh demo order gets a new
 * identity. So a reference that was paid on-chain is never shown as unpaid again.
 * Payment attempts are always kept. The caller must first check no issued
 * transaction can still land.
 */
export function resetDb(): Order {
  // Payment attempts or an escrow (its PDA is keyed by the reference) make an identity single-use.
  const touched = new Set([
    ...db.paymentAttempts.map((a) => a.orderId),
    ...db.orders.filter((o) => o.escrow).map((o) => o.id),
    ...db.archivedOrders.map((o) => o.id),
  ]);
  const archivedOrders = [...db.archivedOrders, ...db.orders.filter((o) => touched.has(o.id))];
  const kept = new Set(archivedOrders.map((o) => o.id));
  const keep = <T extends { orderId: string }>(rows: T[]) => rows.filter((r) => kept.has(r.orderId));
  let rehearsal = 1;
  while (touched.has(rehearsal === 1 ? "ord_1001" : `ord_1001_r${rehearsal}`)) rehearsal++;
  const fresh = seed(rehearsal);
  Object.assign(db, {
    ...fresh,
    documents: keep(db.documents),
    sessions: keep(db.sessions),
    captures: keep(db.captures),
    scans: keep(db.scans),
    proofs: keep(db.proofs),
    agreements: keep(db.agreements),
    paymentAttempts: db.paymentAttempts,
    archivedOrders,
  });
  save();
  return fresh.orders[0];
}

/**
 * A proof as served. Proofs saved before phone photos stopped being AI-assessed may still hold an
 * `assessment` on disk: it is kept there but never served, so no AI verdict appears next to a photo.
 * They also predate `kind`, so they are served as uploads.
 */
function publicProof(p: PhoneProof, capture: Capture): PhoneProofView {
  const { id, orderId, captureId, imageSha256, stationScanId, stationCaptureId, evidenceRevision, createdAt } = p;
  return { id, orderId, captureId, imageSha256, kind: p.kind === "live" ? "live" : "upload", stationScanId, stationCaptureId, evidenceRevision, createdAt, capture };
}

/** OrderDetail for any route. Proofs are newest first, each with its photo. */
export function orderDetail(order: Order): OrderDetail {
  return {
    order,
    supplier: db.suppliers.find((s) => s.id === order.supplierId)!,
    documents: db.documents.filter((d) => order.documentIds.includes(d.id)),
    latestCapture: db.captures.find((c) => c.id === order.latestCaptureId) ?? null,
    latestScan: db.scans.find((s) => s.id === order.latestScanId) ?? null,
    proofs: db.proofs
      .filter((p) => p.orderId === order.id)
      .map((p) => publicProof(p, db.captures.find((c) => c.id === p.captureId)!))
      .reverse(),
  };
}

export const id = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

save();
