/**
 * ClearDock shared data contracts.
 *
 * Every workstream (web, server, AI, hardware, Solana) codes against these
 * shapes. Change them only through the integrator, and update CONTRACTS.md
 * and the fixtures in the same commit.
 *
 * Conventions
 * - Money is always integer minor units (cents) in `*Minor` fields. Never floats.
 * - Timestamps are ISO 8601 strings in UTC.
 * - IDs are opaque strings.
 * - Anything produced by a mock or simulation says so in a field
 *   (`extractedBy: "mock"`, `simulated: true`). No silent fakes.
 */

// ---------- Basics ----------

export type Currency = "USD";

/** Units we can convert between deterministically. */
export type Unit = "bag" | "box" | "unit" | "g" | "kg";

export type AnalysisSource = "gemini" | "mock";

// ---------- Suppliers ----------

export interface Supplier {
  id: string;
  name: string;
  /** Verified Solana address. AI output can never change this. */
  walletAddress: string;
  verified: boolean;
}

// ---------- Documents (PO, invoice, delivery receipt) ----------

export type DocumentKind = "purchase_order" | "invoice" | "delivery_receipt";

export interface LineItem {
  /** Our internal product code, e.g. "PROD-A". Null if the AI could not map it. */
  sku: string | null;
  description: string;
  quantity: number;
  unit: Unit;
  /** Size of one unit in grams, when known (e.g. a 500 g bag). */
  unitSizeGrams?: number;
  unitPriceMinor: number;
}

export interface ExtractedLine extends LineItem {
  /** The exact text the line came from, for evidence display. */
  sourceText: string;
  /** 0..1 */
  confidence: number;
}

export interface ExtractedDocument {
  id: string;
  orderId: string;
  kind: DocumentKind;
  source: {
    filename: string;
    mimeType: "application/pdf" | "image/png" | "image/jpeg";
    sha256: string;
  };
  supplierName: string | null;
  orderReference: string | null;
  currency: Currency | null;
  language: "en" | "es" | "other" | null;
  lines: ExtractedLine[];
  totalMinor: number | null;
  /** Missing or ambiguous information. The AI must not invent values. */
  warnings: string[];
  extractedBy: AnalysisSource;
  extractedAt: string;
}

// ---------- Receiving evidence ----------

export type CaptureSource = "station" | "phone" | "upload";

/** Short-lived link between an order and a capture device (QR code). */
export interface CaptureSession {
  id: string;
  orderId: string;
  /** Short code encoded in the QR URL. */
  code: string;
  createdAt: string;
  expiresAt: string;
}

export interface SensorReading {
  kind: "weight";
  grams: number;
  /** True when the value did not come from real hardware. Must be shown in the UI. */
  simulated: boolean;
  readAt: string;
}

export interface Capture {
  id: string;
  orderId: string;
  sessionId: string | null;
  source: CaptureSource;
  imageUrl: string;
  imageSha256: string;
  capturedAt: string;
  sensors: SensorReading[];
}

export interface ObservedItem {
  /** Mapped SKU, or null if the label could not be matched to a product. */
  sku: string | null;
  labelText: string;
  count: number;
  /** 0..1 */
  confidence: number;
}

export interface ScanResult {
  id: string;
  orderId: string;
  captureId: string;
  observed: ObservedItem[];
  /** Packages or labels the model could not read. Non-empty means human review. */
  unreadable: string[];
  notes: string;
  analyzedBy: AnalysisSource;
  analyzedAt: string;
}

// ---------- Comparison (deterministic code, never AI) ----------

export type LineVerdict =
  | "match"
  | "missing" // observed fewer than ordered
  | "over" // observed more than ordered
  | "unexpected" // observed a product that was not ordered
  | "billed_mismatch" // invoice quantity differs from PO
  | "price_mismatch" // invoice unit price differs from PO
  | "unknown"; // not enough evidence

export interface ComparisonLine {
  sku: string | null;
  description: string;
  unitPriceMinor: number;
  ordered: number | null;
  billed: number | null;
  observed: number | null;
  verdict: LineVerdict;
  /** Value of the difference between what was billed and what was observed. */
  discrepancyMinor: number;
  explanation: string;
}

export type ComparisonOutcome = "match" | "discrepancy" | "needs_info";

export interface Comparison {
  orderId: string;
  /** Evidence revision this comparison was computed from. */
  evidenceRevision: number;
  outcome: ComparisonOutcome;
  lines: ComparisonLine[];
  orderedTotalMinor: number;
  billedTotalMinor: number;
  /** Value of lines that match across PO, invoice and delivery. */
  undisputedMinor: number;
  summary: string;
  computedAt: string;
}

// ---------- Order lifecycle ----------

/**
 * "Matched" is not "approved". "Approved" is not "paid".
 * "Submitted" is not "confirmed".
 */
export type OrderStatus =
  | "needs_documents"
  | "analyzing"
  | "discrepancy"
  | "needs_info"
  | "ready_for_review"
  | "approved"
  | "awaiting_signature"
  | "payment_submitted"
  | "payment_confirmed"
  | "payment_failed";

export interface Approval {
  id: string;
  orderId: string;
  /** Approval is void if the order's evidenceRevision moves past this. */
  evidenceRevision: number;
  recipient: string;
  amountMinor: number;
  approvedAt: string;
}

export type PaymentStatus =
  | "awaiting_signature"
  | "submitted"
  | "confirmed"
  | "failed"
  | "unknown";

export interface Payment {
  id: string;
  orderId: string;
  approvalId: string;
  network: "devnet";
  recipient: string;
  amountMinor: number;
  /** Prevents duplicate app payments from repeated clicks. */
  idempotencyKey: string;
  status: PaymentStatus;
  signature: string | null;
  error: string | null;
  updatedAt: string;
}

export interface Order {
  id: string;
  reference: string;
  supplierId: string;
  currency: Currency;
  status: OrderStatus;
  /** Bumped on every document or capture change. Invalidates old approvals. */
  evidenceRevision: number;
  documentIds: string[];
  latestCaptureId: string | null;
  latestScanId: string | null;
  comparison: Comparison | null;
  approval: Approval | null;
  payment: Payment | null;
  createdAt: string;
  updatedAt: string;
}

/** What GET /api/orders/:id returns: the order with everything it references. */
export interface OrderDetail {
  order: Order;
  supplier: Supplier;
  documents: ExtractedDocument[];
  latestCapture: Capture | null;
  latestScan: ScanResult | null;
}

// ---------- Phase 2: escrow claims and settlements ----------
// See docs/escrow-rulebook.md. Not built yet; shapes fixed so the UI can mock them.

export interface ClaimLine {
  sku: string | null;
  description: string;
  claimedMinor: number;
  reason: "missing" | "wrong_item" | "damaged" | "other";
}

export interface Claim {
  id: string;
  orderId: string;
  scanId: string;
  lines: ClaimLine[];
  /** Lines the buyer accepted; released to the supplier immediately. */
  acceptedMinor: number;
  claimedMinor: number;
  filedAt: string;
}

export type SettlementKind =
  | "full_refund"
  | "full_release"
  | "split"
  | "replacement"
  | "cancel_with_return";

export interface SettlementOffer {
  id: string;
  claimId: string;
  proposedBy: "buyer" | "supplier";
  kind: SettlementKind;
  /** toSupplierMinor + toBuyerMinor must equal the claim's locked amount. */
  toSupplierMinor: number;
  toBuyerMinor: number;
  requiresReturn: boolean;
  expiresAt: string;
  signatures: { buyer: string | null; supplier: string | null };
  status: "open" | "accepted" | "rejected" | "expired" | "executed";
}

// ---------- API envelopes ----------

export interface ApiError {
  error: string;
  code:
    | "not_found"
    | "bad_request"
    | "unauthorized"
    | "conflict"
    | "stale_approval"
    | "not_implemented"
    | "upstream_error";
}
