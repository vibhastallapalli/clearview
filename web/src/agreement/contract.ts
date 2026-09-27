/**
 * PROPOSED agreement contract: what the settlement UI needs from the server.
 *
 * NOT IMPLEMENTED on the server as of integration/phone-proof @ 3b9798a. These shapes and paths are
 * the web workstream's request to the integrator (Account 1); the live client reports "not available"
 * until the server answers them. Replace with @cleardock/shared types once they are published.
 *
 * Money is integer token minor units (CDT, 2 decimals, so cents).
 */
import type { ClaimLine } from "@cleardock/shared";

export type Party = "buyer" | "supplier";

/** Only monetary splits for now; replacement/return logistics are deferred. */
export type AgreementOfferKind = "full_refund" | "full_release" | "split";

/**
 * open: the other party can accept, reject or counter.
 * superseded: replaced by a counter-offer. rejected: declined, nothing replaces it.
 * accepted: the agreement. Offers are immutable once made; a counter is a new offer.
 */
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

export interface AgreementClaim {
  id: string;
  /** Station evidence the claimed lines were reviewed from. */
  scanId: string;
  evidenceRevision: number;
  lines: ClaimLine[];
  claimedMinor: number;
  /** Phone proof ids the buyer points to (raw photos; never assessed by AI). */
  proofIds: string[];
  /** The verified on-chain claim transaction. */
  claimSignature: string;
  filedAt: string;
}

/**
 * awaiting_signatures: agreed, nothing sent. submitted: a settle transaction was broadcast, not yet verified.
 * unknown: sent, but its outcome couldn't be established (don't send another; re-check).
 * failed: provably didn't land or failed on-chain; a fresh transaction (fresh signatures) may be built.
 * confirmed: the server verified the settle instruction on devnet with the agreed amounts.
 */
export type SettlementStatus = "awaiting_signatures" | "submitted" | "unknown" | "failed" | "confirmed";

export interface AgreementSettlement {
  offerId: string;
  status: SettlementStatus;
  signature: string | null;
  error: string | null;
  updatedAt: string;
}

export interface AgreementState {
  orderId: string;
  /** Bumps on every change. Every write carries the revision it was based on; a stale one gets 409. */
  revision: number;
  claim: AgreementClaim | null;
  /** Newest first, including superseded and rejected ones. */
  offers: AgreementOffer[];
  /** The offer that can be acted on now (open), or the accepted one. Null when none. */
  currentOfferId: string | null;
  /** Who the server expects to act next. Null when nobody (no claim, or settlement in flight/done). */
  nextActor: Party | null;
  settlement: AgreementSettlement | null;
}

/** Body of POST /agreement/offers. A counter sets replacesOfferId to the open offer. */
export interface ProposeOfferInput {
  as: Party;
  kind: AgreementOfferKind;
  toSupplierMinor: number;
  toBuyerMinor: number;
  replacesOfferId: string | null;
  expectedRevision: number;
}

/** Body of POST /agreement/offers/:offerId/{accept,reject}. */
export interface RespondInput {
  as: Party;
  expectedRevision: number;
}

/** PROPOSED paths, all under /api/orders/:id. Kept in one place so they are easy to change. */
export const AGREEMENT_PATHS = {
  state: (orderId: string) => `/api/orders/${orderId}/agreement`,
  claim: (orderId: string) => `/api/orders/${orderId}/agreement/claim`,
  offers: (orderId: string) => `/api/orders/${orderId}/agreement/offers`,
  accept: (orderId: string, offerId: string) => `/api/orders/${orderId}/agreement/offers/${offerId}/accept`,
  reject: (orderId: string, offerId: string) => `/api/orders/${orderId}/agreement/offers/${offerId}/reject`,
  settlement: (orderId: string) => `/api/orders/${orderId}/agreement/settlement`,
};
