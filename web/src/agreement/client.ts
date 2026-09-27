import { ApiRequestError, json, request } from "../api";
import { AGREEMENT_PATHS as P, type AgreementRequest, type AgreementState } from "./contract";

/** Account 1's agreement API (CONTRACTS.md "Agreement"). Every call returns the whole, current agreement. */
export interface AgreementApi {
  get(orderId: string): Promise<AgreementState>;
  /** Any signed write, sent to the path for its action. The same signed body again is recognised, not re-applied. */
  send(orderId: string, req: AgreementRequest): Promise<AgreementState>;
  /** Link the verified on-chain claim. No wallet signature: the chain is the evidence. */
  confirmClaim(orderId: string, claimSignature: string): Promise<AgreementState>;
  /** Re-check a settle signature the server already knows. No wallet signature needed. */
  recheckSettlement(orderId: string, signature: string): Promise<AgreementState>;
}

export function pathFor(orderId: string, req: AgreementRequest): string {
  switch (req.action) {
    case "prepare_claim":
      return P.claim(orderId);
    case "propose":
      return P.offers(orderId);
    case "accept":
      return P.accept(orderId, req.offerId);
    case "reject":
      return P.reject(orderId, req.offerId);
    case "record_settlement":
      return P.settlement(orderId);
  }
}

export const liveAgreementApi: AgreementApi = {
  get: (orderId) => request<AgreementState>(P.state(orderId)),
  send: (orderId, req) => request<AgreementState>(pathFor(orderId, req), json(req)),
  confirmClaim: (orderId, claimSignature) => request<AgreementState>(P.claimConfirm(orderId), json({ claimSignature })),
  recheckSettlement: (orderId, signature) => request<AgreementState>(P.settlement(orderId), json({ signature })),
};

/** The server doesn't serve the agreement API (an older server): a non-JSON 404, or 501. */
export const isUnavailable = (err: unknown) =>
  err instanceof ApiRequestError && ((err.status === 404 && !err.code) || err.status === 501);

/** Someone else changed the agreement first, or this tab was behind. Refetch and ask the user to review. */
export const isConflict = (err: unknown) => err instanceof ApiRequestError && (err.status === 409 || err.code === "stale_approval");

/** The wallet signature didn't match the party's wallet on the verified escrow. */
export const isWrongWallet = (err: unknown) => err instanceof ApiRequestError && err.status === 401;

/**
 * No usable reply: the request may or may not have been applied. Refetch before retrying.
 * Includes gateway errors without an ApiError body (a proxy in front of the server gave up).
 */
export const isNetwork = (err: unknown) =>
  err instanceof ApiRequestError && (err.status === 0 || (!err.code && [502, 503, 504].includes(err.status)));
