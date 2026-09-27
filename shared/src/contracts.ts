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

/** "yolo" = the station's trained detector (counts sent with the photo). Never Gemini. */
export type AnalysisSource = "gemini" | "mock" | "cache" | "yolo";

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
  /** How many of `count` the detector saw as damaged. Damaged units are present but disputed. */
  damaged?: number;
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
  /** Set when the station's detector produced the counts (analyzedBy "yolo"). */
  detector?: { model: string | null; totalCount: number; normalCount: number; damagedCount: number };
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
  | "damaged" // delivered, but some units were seen damaged
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
  /** Units seen damaged (part of observed). Null without a scan. */
  damaged?: number | null;
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

// ---------- Order terms: what both parties agree to BEFORE funding ----------
//
// Separate from the settlement agreement below (which splits a disputed, already-held amount).
// Either party proposes a version; its proposer's wallet signature approves it. The other party approves
// the SAME version and termsHash. Both approvals on the current, non-stale version = agreed; only then does
// the server link a funded escrow to the order, and only if the escrow's on-chain terms_hash equals termsHash.
// Once funded the terms are frozen.
//
// Honest scope: the escrow program stores terms_hash but does not verify these signatures (only the buyer
// signs `fund`). A buyer could fund on-chain directly; ClearDock then refuses to link that escrow, and its
// funds can only leave through the program's normal instructions. The inspection window is informational.

/** Bump when ORDER_TERMS_RULES changes. */
export const ORDER_TERMS_RULES_VERSION = 2;

/** The rules every order agrees to. Only what the app and program actually do. */
export const ORDER_TERMS_RULES: readonly string[] = [
  "Funding: the buyer locks the total below, in the ClearDock devnet test token (not real money), in the ClearDock escrow for this order.",
  "Acceptance: amounts the buyer confirms as received are released to the supplier wallet by the buyer's transaction.",
  "Claims: amounts the buyer claims stay held in escrow. They leave only through one settle transaction signed by both buyer and supplier for an exact split of the held amount.",
  "No timeout: nothing is released or refunded automatically, including when the inspection window ends. The window is not enforced in this version.",
  "No arbitration: if buyer and supplier don't agree, the held amount stays in escrow. ClearDock never decides who is right.",
  "Remedies: for each claimed line, the remedy schedule below sets the agreed refund, as a percentage of that line's price. It is the default settlement offer. Moving held money still needs both signatures; an offer that refunds less than the schedule is shown as departing from these signed terms.",
  "Non-delivery: if nothing arrives, the buyer claims every line as missing and the schedule applies. Nothing is refunded without the supplier's signature.",
  "Evidence: station scans and photos are evidence for both sides to review, not verdicts. AI output never moves money.",
];

export interface OrderTermsLine {
  sku: string | null;
  description: string;
  quantity: number;
  unitPriceMinor: number;
}

/** Issues a remedy can be agreed for. A claim line's reason picks its rule; "other" has no scheduled remedy. */
export type RemedyIssue = "missing" | "damaged" | "wrong_item";
export const REMEDY_ISSUES: readonly RemedyIssue[] = ["missing", "damaged", "wrong_item"];

/** Whole-percent refund of a claimed line's price, per issue, agreed before funding. */
export type RemedySchedule = Record<RemedyIssue, number>;
export const DEFAULT_REMEDIES: RemedySchedule = { missing: 100, damaged: 100, wrong_item: 100 };

/** The default split of a held claim under the signed schedule. */
export interface RemedyDefault {
  /** Terms version whose schedule this comes from. */
  termsVersion: number;
  toBuyerMinor: number;
  toSupplierMinor: number;
  basis: { description: string; reason: RemedyIssue; claimedMinor: number; refundPercent: number; refundMinor: number }[];
}

/**
 * The schedule's split for claimed lines, or null if any line has no scheduled remedy (reason "other").
 * Per line: floor(claimedMinor × percent / 100), in integer cents; the remainder goes to the supplier.
 */
export function remedyDefault(lines: ClaimLine[], heldMinor: number, schedule: RemedySchedule, termsVersion: number): RemedyDefault | null {
  if (lines.some((l) => l.reason === "other")) return null;
  const basis = lines.map((l) => {
    const reason = l.reason as RemedyIssue;
    const refundPercent = schedule[reason];
    return { description: l.description, reason, claimedMinor: l.claimedMinor, refundPercent, refundMinor: Math.floor((l.claimedMinor * refundPercent) / 100) };
  });
  const toBuyerMinor = basis.reduce((sum, b) => sum + b.refundMinor, 0);
  if (toBuyerMinor > heldMinor) return null;
  return { termsVersion, toBuyerMinor, toSupplierMinor: heldMinor - toBuyerMinor, basis };
}

/** The canonical terms. Every field is material: changing any of them is a new version. */
export interface OrderTerms {
  rulesVersion: number;
  orderId: string;
  reference: string;
  network: "devnet";
  escrowProgramId: string;
  /** Devnet test token mint (CDT, 2 decimals). */
  mint: string;
  buyerWallet: string;
  supplierWallet: string;
  lines: OrderTermsLine[];
  /** Sum of quantity × unitPriceMinor. The escrow must be funded with exactly this. */
  totalMinor: number;
  inspection: {
    hours: number;
    /** The window starts at the first station scan ClearDock records for this order after the escrow is funded. */
    startsAt: "first_station_scan_after_funding";
    /** Nothing enforces the deadline, on-chain or in the app. */
    enforced: false;
  };
  /** What the buyer gets back per claimed issue. Absent on terms signed before schedules existed (rules v1). */
  remedies?: RemedySchedule;
  rules: string[];
}

export interface TermsApproval {
  party: Party;
  wallet: string;
  /** base64 ed25519 signature over orderTermsMessage(orderId, version, termsHash, terms). */
  signature: string;
  at: string;
}

export interface OrderTermsVersion {
  version: number;
  terms: OrderTerms;
  /** sha256 hex of canonicalTerms(terms). Also the escrow's on-chain terms_hash. */
  termsHash: string;
  proposedBy: Party;
  proposedAt: string;
  approvals: TermsApproval[];
}

/**
 * none: no terms yet. awaiting_approval: current version lacks a party's approval.
 * agreed: both approved the current version; funding is allowed. stale: an order fact (reference, wallets,
 * mint, program) changed since, so the approvals no longer count; propose a new version.
 * funded: an escrow with this termsHash, total, mint and parties is linked; terms are frozen.
 * legacy: the escrow was linked before order terms existed. Nobody signed terms for it.
 */
export type OrderTermsStatus = "none" | "awaiting_approval" | "agreed" | "stale" | "funded" | "legacy";

export interface OrderTermsState {
  orderId: string;
  /** Bumps on every change. Proposals carry expectedRevision; a stale one gets 409. */
  revision: number;
  status: OrderTermsStatus;
  /** The version being approved, agreed or funded. */
  current: OrderTermsVersion | null;
  /** Earlier versions, newest first. Their approvals don't count. */
  history: OrderTermsVersion[];
  /** Parties whose approval of the current version is still missing. */
  outstanding: Party[];
  staleReason: string | null;
  funded: { termsHash: string; escrowAddress: string; at: string } | null;
}

/** Body of POST /terms/propose. The proposer's walletSignature (over the new version) is their approval. */
export interface ProposeTermsInput {
  as: Party;
  expectedRevision: number;
  lines: OrderTermsLine[];
  inspectionHours: number;
  /** Omitted = DEFAULT_REMEDIES (shown in the preview, so it is still what gets signed). */
  remedies?: RemedySchedule;
  walletSignature: string;
}

/** Body of POST /terms/approve. */
export interface ApproveTermsInput {
  as: Party;
  version: number;
  termsHash: string;
  walletSignature: string;
}

/** Response of POST /terms/preview: what a proposal would create, to sign. Changes nothing. */
export interface TermsPreview {
  version: number;
  terms: OrderTerms;
  termsHash: string;
}

/** The exact bytes termsHash is computed from. Fixed key order. */
export function canonicalTerms(t: OrderTerms): string {
  return JSON.stringify([
    t.rulesVersion,
    t.orderId,
    t.reference,
    t.network,
    t.escrowProgramId,
    t.mint,
    t.buyerWallet,
    t.supplierWallet,
    t.lines.map((l) => [l.sku, l.description, l.quantity, l.unitPriceMinor]),
    t.totalMinor,
    [t.inspection.hours, t.inspection.startsAt, t.inspection.enforced],
    // Only terms that have a schedule hash it, so hashes of terms signed before schedules existed still match.
    ...(t.remedies ? [REMEDY_ISSUES.map((i) => [i, t.remedies![i]])] : []),
    t.rules,
  ]);
}

/** sha256 hex of canonicalTerms(t). Works in the browser and in Node 20+. */
export async function termsHashOf(t: OrderTerms): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalTerms(t)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const cdt = (minor: number) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")} CDT`;

/** The text a party's wallet signs to approve a version. Readable summary + the hash that binds every field. */
export function orderTermsMessage(orderId: string, version: number, termsHash: string, t: OrderTerms): string {
  return [
    "ClearDock order terms (Solana devnet, test token). Signing approves these terms; it moves no funds.",
    `order: ${orderId} (${t.reference})`,
    `version: ${version}`,
    `terms sha256: ${termsHash}`,
    `total: ${cdt(t.totalMinor)} · ${t.lines.map((l) => `${l.quantity} × ${l.description} @ ${cdt(l.unitPriceMinor)}`).join("; ")}`,
    `buyer: ${t.buyerWallet}`,
    `supplier: ${t.supplierWallet}`,
    `inspection: ${t.inspection.hours} h from the first station scan after funding (not enforced)`,
    t.remedies
      ? `remedies (refund of the claimed line's price): missing ${t.remedies.missing}%, damaged ${t.remedies.damaged}%, wrong item ${t.remedies.wrong_item}%`
      : "remedies: none (terms from before remedy schedules)",
    "claimed amounts stay held until both sign a settlement; no timeout, no arbitration",
  ].join("\n");
}

export const TERMS_PATHS = {
  state: (orderId: string) => `/api/orders/${orderId}/terms`,
  preview: (orderId: string) => `/api/orders/${orderId}/terms/preview`,
  propose: (orderId: string) => `/api/orders/${orderId}/terms/propose`,
  approve: (orderId: string) => `/api/orders/${orderId}/terms/approve`,
};

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
  /** The signed remedy schedule's split for the filed claim. Null without a filed claim, funded terms (legacy) or a scheduled reason. */
  remedy: RemedyDefault | null;
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

// ---------- Dispute chat (buyer ↔ supplier) ----------
//
// Free text between the two parties. Messages never move money and never make offers: "/offer",
// "/accept" and "/reject" are parsed by plain code in the browser and go through the wallet-signed
// agreement API like the buttons do. A party signs in once per session (Phantom signMessage over
// chatSessionMessage); the server then labels each message with that party's wallet.
// The AI helper only rewords a draft the sender then edits and sends; it can't add or change numbers.

export interface ChatMessage {
  id: string;
  orderId: string;
  from: Party;
  /** The wallet that signed in the session this message was sent from. */
  wallet: string;
  text: string;
  at: string;
  /** The sender used the AI wording helper for this message. */
  aiAssisted: boolean;
}

export interface ChatState {
  orderId: string;
  /** Oldest first. */
  messages: ChatMessage[];
}

/** Response of POST /chat/session. Send the token as `Authorization: Bearer <token>`. */
export interface ChatSession {
  token: string;
  as: Party;
  wallet: string;
  expiresAt: string;
}

/** Response of POST /chat/assist. */
export interface ChatAssist {
  text: string;
  model: string;
  /** False when the AI's rewrite changed numbers, so the original draft is returned. */
  used: boolean;
  note: string | null;
}

/** What a wallet signs to open a chat session. issuedAt must be recent; the nonce is single-use. */
export function chatSessionMessage(orderId: string, as: Party, issuedAt: string, nonce: string): string {
  return [
    "ClearDock dispute chat (Solana devnet). Signing opens a chat session; it moves no funds and makes no offer.",
    `order: ${orderId}`,
    `as: ${as}`,
    `issued: ${issuedAt}`,
    `nonce: ${nonce}`,
  ].join("\n");
}

/** Every number in a text (digits with optional separators/decimals), normalised. */
const numbersIn = (text: string) => (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.0+$/, ""));

/** True if `rewrite` contains no number that `draft` doesn't: the AI may reword, never invent amounts. */
export function numbersPreserved(draft: string, rewrite: string): boolean {
  const allowed = new Set(numbersIn(draft));
  return numbersIn(rewrite).every((n) => allowed.has(n));
}

export const CHAT_PATHS = {
  state: (orderId: string) => `/api/orders/${orderId}/chat`,
  session: (orderId: string) => `/api/orders/${orderId}/chat/session`,
  messages: (orderId: string) => `/api/orders/${orderId}/chat/messages`,
  assist: (orderId: string) => `/api/orders/${orderId}/chat/assist`,
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
