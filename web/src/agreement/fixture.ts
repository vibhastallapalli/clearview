/**
 * SIMULATED, test-only stand-in for the PROPOSED agreement API. It mirrors the rules the UI expects
 * from Account 1's server so the UI logic can be tested before that server exists.
 * Never imported by the app: the live path uses liveAgreementApi only.
 */
import { ApiRequestError } from "../api";
import type { AgreementApi } from "./client";
import type { AgreementOffer, AgreementState } from "./contract";

const conflict = (msg: string) => new ApiRequestError(msg, 409, "conflict");
const bad = (msg: string) => new ApiRequestError(msg, 400, "bad_request");

export class SimulatedAgreementApi implements AgreementApi {
  private states = new Map<string, AgreementState>();
  private n = 0;
  private clock = 0;
  /** Set to make the next call fail as if the network dropped (after applying it, when `applied`). */
  dropNext: { applied: boolean } | null = null;

  private now = () => new Date(Date.UTC(2026, 8, 27, 12, 0, this.clock++)).toISOString();
  private copy = (st: AgreementState): AgreementState => structuredClone(st);

  private state(orderId: string): AgreementState {
    let st = this.states.get(orderId);
    if (!st) {
      st = { orderId, revision: 0, claim: null, offers: [], currentOfferId: null, nextActor: null, settlement: null };
      this.states.set(orderId, st);
    }
    return st;
  }

  private async write(orderId: string, expectedRevision: number | null, fn: (st: AgreementState) => void): Promise<AgreementState> {
    const drop = this.dropNext;
    this.dropNext = null;
    if (drop && !drop.applied) throw new ApiRequestError("Can't reach the ClearDock server. Is it running?", 0);
    const st = this.state(orderId);
    if (expectedRevision !== null && expectedRevision !== st.revision)
      throw conflict("The agreement changed since you loaded it. Review the current offer.");
    fn(st);
    st.revision += 1;
    if (drop) throw new ApiRequestError("Can't reach the ClearDock server. Is it running?", 0);
    return this.copy(st);
  }

  async get(orderId: string) {
    return this.copy(this.state(orderId));
  }

  fileClaim: AgreementApi["fileClaim"] = (orderId, input) =>
    this.write(orderId, null, (st) => {
      if (st.claim) throw conflict("A claim is already filed for this order.");
      st.claim = {
        id: `clm_${++this.n}`,
        scanId: input.scanId,
        evidenceRevision: input.evidenceRevision,
        lines: input.lines,
        claimedMinor: input.claimedMinor,
        proofIds: input.proofIds,
        claimSignature: input.claimSignature,
        filedAt: this.now(),
      };
    });

  propose: AgreementApi["propose"] = (orderId, input) =>
    this.write(orderId, input.expectedRevision, (st) => {
      if (!st.claim) throw conflict("File the claim first.");
      if (st.settlement) throw conflict("An offer was already accepted.");
      const cur = st.offers.find((o) => o.id === st.currentOfferId);
      if (cur?.status === "open") {
        if (input.replacesOfferId !== cur.id || cur.proposedBy === input.as) throw conflict("Answer the open offer first.");
        cur.status = "superseded";
        cur.respondedBy = input.as;
        cur.respondedAt = this.now();
      } else if (input.replacesOfferId) throw conflict("That offer can no longer be countered.");
      if (input.toSupplierMinor + input.toBuyerMinor !== st.claim.claimedMinor || input.toSupplierMinor < 0 || input.toBuyerMinor < 0)
        throw bad("The split must add up to the claimed amount.");
      const offer: AgreementOffer = {
        id: `ofr_${++this.n}`,
        version: st.offers.length + 1,
        proposedBy: input.as,
        kind: input.kind,
        toSupplierMinor: input.toSupplierMinor,
        toBuyerMinor: input.toBuyerMinor,
        status: "open",
        replacesOfferId: input.replacesOfferId,
        createdAt: this.now(),
        respondedBy: null,
        respondedAt: null,
      };
      st.offers.unshift(offer);
      st.currentOfferId = offer.id;
      st.nextActor = input.as === "buyer" ? "supplier" : "buyer";
    });

  private respond(orderId: string, offerId: string, input: { as: "buyer" | "supplier"; expectedRevision: number }, accept: boolean) {
    return this.write(orderId, input.expectedRevision, (st) => {
      const offer = st.offers.find((o) => o.id === offerId);
      if (!offer || st.currentOfferId !== offerId || offer.status !== "open") throw conflict("That offer is no longer open.");
      if (offer.proposedBy === input.as) throw conflict("You can't answer your own offer.");
      offer.status = accept ? "accepted" : "rejected";
      offer.respondedBy = input.as;
      offer.respondedAt = this.now();
      st.nextActor = null;
      if (accept) st.settlement = { offerId, status: "awaiting_signatures", signature: null, error: null, updatedAt: this.now() };
      else st.currentOfferId = null;
    });
  }

  accept: AgreementApi["accept"] = (orderId, offerId, input) => this.respond(orderId, offerId, input, true);
  reject: AgreementApi["reject"] = (orderId, offerId, input) => this.respond(orderId, offerId, input, false);

  recordSettlement: AgreementApi["recordSettlement"] = (orderId, input) =>
    this.write(orderId, null, (st) => {
      const s = st.settlement;
      if (!s || s.offerId !== input.offerId) throw conflict("That offer isn't the agreed one.");
      if (s.signature && s.signature !== input.signature && s.status !== "failed")
        throw conflict("A different settlement transaction was already recorded.");
      Object.assign(s, { status: s.status === "confirmed" ? "confirmed" : "submitted", signature: input.signature, updatedAt: this.now() });
    });

  /** Test hook: what the server does once it has verified (or failed to find) the settle transaction on devnet. */
  resolveSettlement(orderId: string, status: "confirmed" | "failed" | "unknown", error: string | null = null) {
    const s = this.state(orderId).settlement!;
    Object.assign(s, { status, error, updatedAt: this.now() });
    this.state(orderId).revision += 1;
  }
}
