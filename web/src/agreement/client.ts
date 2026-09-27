import type { ClaimLine } from "@cleardock/shared";
import { ApiRequestError, json, request } from "../api";
import { AGREEMENT_PATHS as P, type AgreementState, type ProposeOfferInput, type RespondInput } from "./contract";

export interface FileClaimInput {
  as: "buyer";
  scanId: string;
  evidenceRevision: number;
  lines: ClaimLine[];
  claimedMinor: number;
  proofIds: string[];
  claimSignature: string;
}

export interface RecordSettlementInput {
  offerId: string;
  signature: string;
}

/** Everything the settlement UI asks of the server. Every call returns the whole, current agreement. */
export interface AgreementApi {
  get(orderId: string): Promise<AgreementState>;
  fileClaim(orderId: string, input: FileClaimInput): Promise<AgreementState>;
  propose(orderId: string, input: ProposeOfferInput): Promise<AgreementState>;
  accept(orderId: string, offerId: string, input: RespondInput): Promise<AgreementState>;
  reject(orderId: string, offerId: string, input: RespondInput): Promise<AgreementState>;
  /** Report a broadcast settle signature. Same signature again = re-check on devnet. */
  recordSettlement(orderId: string, input: RecordSettlementInput): Promise<AgreementState>;
}

/**
 * The server doesn't serve the agreement API. Express answers an unknown route with a non-JSON 404,
 * which is different from a JSON `not_found` for a missing order.
 */
export const isUnavailable = (err: unknown) =>
  err instanceof ApiRequestError && ((err.status === 404 && !err.code) || err.status === 501);

/** Someone else changed the agreement first (or this tab was behind). Refetch and ask the user to review. */
export const isConflict = (err: unknown) => err instanceof ApiRequestError && (err.status === 409 || err.code === "stale_approval");

/** No reply at all: the request may or may not have been applied. Refetch before retrying. */
export const isNetwork = (err: unknown) => err instanceof ApiRequestError && err.status === 0;

/** Live client for the PROPOSED paths in ./contract. Until the server has them, calls fail with isUnavailable(). */
export const liveAgreementApi: AgreementApi = {
  get: (orderId) => request<AgreementState>(P.state(orderId)),
  fileClaim: (orderId, input) => request<AgreementState>(P.claim(orderId), json(input)),
  propose: (orderId, input) => request<AgreementState>(P.offers(orderId), json(input)),
  accept: (orderId, offerId, input) => request<AgreementState>(P.accept(orderId, offerId), json(input)),
  reject: (orderId, offerId, input) => request<AgreementState>(P.reject(orderId, offerId), json(input)),
  recordSettlement: (orderId, input) => request<AgreementState>(P.settlement(orderId), json(input)),
};
