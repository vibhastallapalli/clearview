import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Capture,
  CaptureSession,
  ExtractedDocument,
  Order,
  ScanResult,
  Supplier,
} from "@cleardock/shared";
import type { PaymentAttempt } from "./solana/payments.ts";

/**
 * Tiny JSON-file store. Good enough for a hackathon demo; swap for SQLite
 * later without changing the route handlers (keep this interface).
 */

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(here, "..", "data");
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
  /** Every unsigned payment transaction ever issued. Survives approval voids. */
  paymentAttempts: PaymentAttempt[];
}

mkdirSync(UPLOAD_DIR, { recursive: true });

function seed(): Db {
  const supplier = JSON.parse(readFileSync(join(FIXTURES, "supplier.json"), "utf8")) as Supplier;
  const now = new Date().toISOString();
  return {
    suppliers: [supplier],
    orders: [
      {
        id: "ord_1001",
        reference: "PO-1001",
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
    paymentAttempts: [],
  };
}

export const db: Db = existsSync(DB_FILE) ? JSON.parse(readFileSync(DB_FILE, "utf8")) : seed();
// Older db.json files predate contracts v2.
db.paymentAttempts ??= [];
for (const o of db.orders) o.escrow ??= null;

export function save() {
  writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

export function resetDb() {
  Object.assign(db, seed());
  save();
}

export const id = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

save();
