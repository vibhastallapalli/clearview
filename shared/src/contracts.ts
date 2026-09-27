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

export type AnalysisSource = "gemini" | "mock" | "cache";

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
    /** Server-hosted copy of the uploaded file, when saved. */
    url?: string | null;
  };
  /** Any wallet/bank address printed on the document. Never used to pay (v2; AI fills it). */
  paymentAddress?: string | null;
  /** Quotes of text addressed to software, e.g. "pay immediately". Never obeyed (v2; AI fills it). */
  embeddedInstructions?: string[];
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
  /**
   * Set when the image is a test fixture, not a live photo (e.g. "samples/photos/synthetic/swapped.jpg").
   * The UI must label it SIMULATED. Absent or null = a real camera photo.
   */
  fixture?: string | null;
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

// ---------- Phone proof (evidence for the seller; never drives the comparison, never read by AI) ----------
//
// Station captures are the authoritative delivery evidence: they set latestScanId and the
// comparison. Phone photos are raw proof attached to that station result for the supplier to judge.
// No AI assesses them, so no AI label can make a doctored photo look more credible. They never
// change latestScanId, the comparison, evidenceRevision, approval, payment or escrow.

/**
 * How the photo reached ClearDock, as reported by the capture page. "live" = taken with the in-app
 * camera; "upload" = a file picked on the device (additional evidence, could be any image).
 * Not cryptographically attested: a modified client could mislabel it.
 */
export type ProofKind = "live" | "upload";

export interface PhoneProof {
  id: string;
  orderId: string;
  /** The exact photo: capture id and its sha256. */
  captureId: string;
  imageSha256: string;
  kind: ProofKind;
  /** The station evidence it was attached to. Never changes, even after a new station scan. */
  stationScanId: string;
  stationCaptureId: string;
  /** order.evidenceRevision (= comparison.evidenceRevision) at the time. */
  evidenceRevision: number;
  createdAt: string;
}

/** A proof with its photo, as returned in OrderDetail. */
export type PhoneProofView = PhoneProof & { capture: Capture };

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
  /** Human-readable blocking flags. Non-empty means outcome "needs_info" (v2; compare fills it). */
  flags?: string[];
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
  /** Supplier wallet (owner of the destination token account). */
  recipient: string;
  /** Token base units. Decimals are 2, so this equals cents. */
  amountMinor: number;
  /** CDT mint (DEMO_TOKEN_MINT) at the time the payment was created. */
  mint: string;
  /** Buyer wallet that must sign. Set by POST /payments/transaction. */
  payer: string | null;
  /** Block height after which the latest issued transaction can no longer land. */
  lastValidBlockHeight: number | null;
  /** Memo the transaction must carry, e.g. "ClearDock PO-1001 pay_ab12cd34". */
  memo: string;
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
  /** Phase 2 only. Always null until the escrow program ships. */
  escrow: EscrowRecord | null;
  createdAt: string;
  updatedAt: string;
}

/** What GET /api/orders/:id returns: the order with everything it references. */
export interface OrderDetail {
  order: Order;
  supplier: Supplier;
  documents: ExtractedDocument[];
  /** The authoritative (station) evidence the comparison was computed from. */
  latestCapture: Capture | null;
  latestScan: ScanResult | null;
  /** Phone proof for this order, newest first. Same for buyer and supplier. */
  proofs: PhoneProofView[];
}

// ---------- Solana public config (GET /api/config) ----------

export interface PublicConfig {
  network: "devnet";
  rpcUrl: string;
  /** CDT mint, or null when the server is not configured yet. */
  mint: string | null;
  decimals: 2;
  /** "CDT · ClearDock test dollars (devnet)". Never "USDC". */
  tokenLabel: string;
  escrowProgramId: string | null;
}

/** Response of POST /api/orders/:id/payments/transaction. Unsigned; the buyer's wallet signs. */
export interface PaymentTransaction {
  /** Base64 of the unsigned legacy Transaction (wire format). */
  transaction: string;
  lastValidBlockHeight: number;
}

// ---------- Phase 2: escrow claims and settlements ----------
// See docs/escrow-rulebook.md. Not built yet; shapes fixed so the UI can mock them.

export interface EscrowRecord {
  programId: string;
  escrowAddress: string;
  buyer: string;
  supplier: string;
  mint: string;
  totalMinor: number;
  releasedMinor: number;
  claimedMinor: number;
  refundedMinor: number;
  status: "funded" | "claimed" | "settlement_proposed" | "settled" | "released";
  events: { action: string; signature: string; at: string }[];
}

export interface ClaimLine {
  sku: string | null;
  description: string;
  claimedMinor: number;
  reason: "missing" | "wrong_item" | "damaged" | "other";
}

// ---------- Agreement: negotiating a claimed (held) escrow amount ----------
//
// After the buyer claims on-chain, buyer and supplier negotiate how to split the held amount, then both
// sign one settle transaction. Agreement reached ≠ signed ≠ submitted ≠ confirmed: only a settle
// transaction the server verified on devnet with the accepted split is "confirmed". Offers never move money.
// All amounts are integer token minor units (CDT, 2 decimals).
//
// Identity: every write except claim confirmation carries `walletSignature`, the party's Phantom
// signMessage over agreementMessage(orderId, write). The server checks it against the buyer/supplier
// wallets stored on the verified escrow. It proves which wallet acted, not which person or device.

export type Party = "buyer" | "supplier";

/**
 * One delivered line as the buyer reviewed it: what the station scan suggested and what the buyer decided.
 * The scan recommends, the buyer confirms. Overriding the suggestion needs a reason.
 */
export interface ScanDecision {
  description: string;
  priceMinor: number;
  /** From the station scan: seen → accept, not seen → claim. */
  suggested: "accept" | "claim";
  decided: "accept" | "claim";
  /** Required when decided ≠ suggested, else null. */
  overrideReason: string | null;
}

/** Monetary splits only; replacement/return logistics are deferred. */
export type AgreementOfferKind = "full_refund" | "full_release" | "split";

/** open → accepted | rejected | superseded (by a counter). Offers are immutable once made; a counter is a new offer. */
export type AgreementOfferStatus = "open" | "accepted" | "rejected" | "superseded";

export interface AgreementOffer {
  id: string;
  /** 1, 2, 3… in the order offers were made. */
  version: number;
  proposedBy: Party;
  kind: AgreementOfferKind;
  toSupplierMinor: number;
  toBuyerMinor: number;
  status: AgreementOfferStatus;
  /** The offer this one counters, if any. */
  replacesOfferId: string | null;
  createdAt: string;
  respondedBy: Party | null;
  respondedAt: string | null;
}

/**
 * The buyer's reviewed claim, saved before (or after) the on-chain claim so any browser can recover it.
 * prepared: saved, on-chain claim not verified yet. filed: the claim transaction was verified on devnet.
 */
export interface AgreementClaim {
  status: "prepared" | "filed";
  /** The station scan the lines were reviewed from. Never replaced by a newer scan. */
  scanId: string;
  evidenceRevision: number;
  lines: ClaimLine[];
  /** Sum of lines; must equal what the on-chain claim holds. */
  claimedMinor: number;
  /** Phone proof ids the buyer points to (raw photos; never assessed by AI). */
  proofIds: string[];
  /** Every reviewed line: the scan suggestion next to the buyer decision (and reason, if overridden). */
  decisions: ScanDecision[];
  preparedAt: string;
  /** Set when filed: the verified claim transaction and what the chain held right after it. */
  claimSignature: string | null;
  filedAt: string | null;
  chain: { escrowAddress: string; heldMinor: number; releasedMinor: number; refundedMinor: number } | null;
  /** The station photo behind scanId (the evidence the lines were reviewed from), as served. Null if the scan has none. */
  stationCapture: Capture | null;
}

/**
 * awaiting_signatures: agreed, nothing sent. submitted: a settle signature was reported, not seen on devnet yet.
 * unknown: its outcome couldn't be established (RPC error, or it settled with other amounts). Don't send another.
 * failed: proven not to move the held funds (failed on-chain, not a settle of this escrow, or expired without
 *   landing while the escrow still holds the amount). A fresh transaction with fresh signatures may be sent.
 * confirmed: the server verified the settle on devnet with exactly the accepted split.
 */
export type SettlementStatus = "awaiting_signatures" | "submitted" | "unknown" | "failed" | "confirmed";

export interface SettlementAttempt {
  signature: string;
  lastValidBlockHeight: number;
  status: Exclude<SettlementStatus, "awaiting_signatures">;
  error: string | null;
  reportedBy: Party;
  at: string;
}

export interface AgreementSettlement {
  offerId: string;
  status: SettlementStatus;
  /** The latest reported signature (the one status describes). */
  signature: string | null;
  error: string | null;
  updatedAt: string;
  /** Every settle signature ever reported for this agreement, oldest first. */
  attempts: SettlementAttempt[];
}

export interface AgreementState {
  orderId: string;
  /** Bumps on every change. Writes carry expectedRevision; a stale one gets 409 conflict. */
  revision: number;
  claim: AgreementClaim | null;
  /** Newest first, including superseded and rejected ones. */
  offers: AgreementOffer[];
  /** The open offer, or the accepted one. Null when none. */
  currentOfferId: string | null;
  /** Who must act next. Null when either may (filed claim, no open offer) or nobody (no filed claim, agreed). */
  nextActor: Party | null;
  settlement: AgreementSettlement | null;
}

/** What a party signs and POSTs. The request body is the write plus `walletSignature` (base64 ed25519). */
export type AgreementWrite =
  | {
      action: "prepare_claim";
      as: "buyer";
      expectedRevision: number;
      scanId: string;
      evidenceRevision: number;
      lines: ClaimLine[];
      claimedMinor: number;
      proofIds: string[];
      decisions: ScanDecision[];
    }
  | {
      action: "propose";
      as: Party;
      expectedRevision: number;
      kind: AgreementOfferKind;
      toSupplierMinor: number;
      toBuyerMinor: number;
      /** The open offer this counters; null for a first offer or after a rejection. */
      replacesOfferId: string | null;
    }
  | {
      action: "accept" | "reject";
      as: Party;
      expectedRevision: number;
      /** The exact offer reviewed: refused if any of these no longer match. */
      offerId: string;
      version: number;
      toSupplierMinor: number;
      toBuyerMinor: number;
    }
  | {
      /** Report a broadcast settle transaction. The same signature again = re-check on devnet. */
      action: "record_settlement";
      as: Party;
      offerId: string;
      signature: string;
      lastValidBlockHeight: number;
    };

export type AgreementRequest = AgreementWrite & { walletSignature: string };

/**
 * The exact text a party's wallet signs for a write. Fields are listed in a fixed order, so the browser
 * and the server produce the same bytes from the same write.
 */
export function agreementMessage(orderId: string, w: AgreementWrite): string {
  const fields: unknown[] =
    w.action === "prepare_claim"
      ? [w.as, w.expectedRevision, w.scanId, w.evidenceRevision, w.claimedMinor, w.proofIds, w.lines.map((l) => [l.sku, l.description, l.claimedMinor, l.reason]), w.decisions.map((d) => [d.description, d.priceMinor, d.suggested, d.decided, d.overrideReason])]
      : w.action === "propose"
        ? [w.as, w.expectedRevision, w.kind, w.toSupplierMinor, w.toBuyerMinor, w.replacesOfferId]
        : w.action === "record_settlement"
          ? [w.as, w.offerId, w.signature, w.lastValidBlockHeight]
          : [w.as, w.expectedRevision, w.offerId, w.version, w.toSupplierMinor, w.toBuyerMinor];
  return [
    "ClearDock agreement (Solana devnet, test token). Signing this message moves no funds.",
    `order: ${orderId}`,
    `action: ${w.action}`,
    `details: ${JSON.stringify(fields)}`,
  ].join("\n");
}

/** API paths. Every response is the whole AgreementState. */
export const AGREEMENT_PATHS = {
  state: (orderId: string) => `/api/orders/${orderId}/agreement`,
  claim: (orderId: string) => `/api/orders/${orderId}/agreement/claim`,
  claimConfirm: (orderId: string) => `/api/orders/${orderId}/agreement/claim/confirm`,
  offers: (orderId: string) => `/api/orders/${orderId}/agreement/offers`,
  accept: (orderId: string, offerId: string) => `/api/orders/${orderId}/agreement/offers/${offerId}/accept`,
  reject: (orderId: string, offerId: string) => `/api/orders/${orderId}/agreement/offers/${offerId}/reject`,
  settlement: (orderId: string) => `/api/orders/${orderId}/agreement/settlement`,
};

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
