/**
 * SIMULATED, test-only stand-in for Account 1's agreement API (server/src/agreement.ts), mirroring its
 * rules so the UI logic can be unit-tested without a server or devnet. Never imported by the app.
 *
 * Wallet signatures are faked: a write "signed" by wallet W is `signed:W:<agreementMessage>`, and the
 * stand-in checks W is the escrow's wallet for write.as. The real ed25519 check is exercised against the
 * real server in the browser check, not here.
 */
import { ApiRequestError } from "../api";
import type { AgreementApi } from "./client";
import { agreementMessage, type AgreementRequest, type AgreementState, type AgreementWrite, type Party, type SettlementAttempt } from "./contract";

export const WALLETS: Record<Party, string> = { buyer: "BuyerWallet1111", supplier: "SupplierWallet111" };

/** The fake signature a wallet produces for a write. */
export const fakeSign = (orderId: string, w: AgreementWrite, wallet: string) => `signed:${wallet}:${agreementMessage(orderId, w)}`;

const conflict = (msg: string) => new ApiRequestError(msg, 409, "conflict");
const bad = (msg: string) => new ApiRequestError(msg, 400, "bad_request");

interface Rec {
  st: AgreementState;
  log: { revision: number; key: string }[];
}

export class SimulatedAgreementApi implements AgreementApi {
  private recs = new Map<string, Rec>();
  private n = 0;
  private clock = 0;
  /** Held on "devnet" once the on-chain claim is confirmed (set by confirmClaim to the saved claim amount). */
  chainHeld: number | null = null;
  /** Make the next write fail as if the network dropped, before or after the server applied it. */
  dropNext: { applied: boolean } | null = null;
  /** What the next settlement check on "devnet" finds for a submitted signature. */
  nextSettleOutcome: Pick<SettlementAttempt, "status" | "error"> = { status: "submitted", error: null };
  writes = 0;

  private now = () => new Date(Date.UTC(2026, 8, 27, 12, 0, this.clock++)).toISOString();
  private copy = (st: AgreementState): AgreementState => structuredClone(st);

  private rec(orderId: string): Rec {
    let r = this.recs.get(orderId);
    if (!r) {
      r = { st: { orderId, revision: 0, claim: null, offers: [], currentOfferId: null, nextActor: null, settlement: null }, log: [] };
      this.recs.set(orderId, r);
    }
    return r;
  }

  private view(r: Rec): AgreementState {
    const st = r.st;
    const cur = st.offers.find((o) => o.id === st.currentOfferId);
    return this.copy({ ...st, nextActor: st.claim?.status === "filed" && cur?.status === "open" ? (cur.proposedBy === "buyer" ? "supplier" : "buyer") : null });
  }

  private commit(r: Rec, key: string) {
    r.st.revision += 1;
    r.log.push({ revision: r.st.revision, key });
  }

  async get(orderId: string) {
    return this.view(this.rec(orderId));
  }

  async send(orderId: string, req: AgreementRequest): Promise<AgreementState> {
    this.writes++;
    const drop = this.dropNext;
    this.dropNext = null;
    if (drop && !drop.applied) throw new ApiRequestError("Can't reach the ClearDock server. Is it running?", 0);
    const { walletSignature, ...w } = req;
    const write = w as AgreementWrite;
    const r = this.rec(orderId);
    const st = r.st;

    if (write.action === "record_settlement" && st.settlement?.attempts.some((a) => a.signature === write.signature)) {
      return this.recheckSettlement(orderId, write.signature);
    }
    if (walletSignature !== fakeSign(orderId, write, WALLETS[write.as]))
      throw new ApiRequestError(`This action must be signed by the ${write.as} wallet ${WALLETS[write.as]}.`, 401, "unauthorized");
    const key = agreementMessage(orderId, write);

    if ("expectedRevision" in write && write.expectedRevision !== st.revision) {
      if (r.log.some((l) => l.revision === write.expectedRevision + 1 && l.key === key)) return this.view(r);
      throw conflict(`The agreement changed on another device. Reload it and review before you answer. (You had revision ${write.expectedRevision}; it is now ${st.revision}.)`);
    }

    switch (write.action) {
      case "prepare_claim": {
        if (st.claim?.status === "filed") throw conflict("The claim is already filed on devnet and can't be changed.");
        if (write.lines.reduce((s, l) => s + l.claimedMinor, 0) !== write.claimedMinor) throw bad("claimedMinor must equal the sum of the lines.");
        const { scanId, evidenceRevision, lines, claimedMinor, proofIds } = write;
        st.claim = { status: "prepared", scanId, evidenceRevision, lines, claimedMinor, proofIds, preparedAt: this.now(), claimSignature: null, filedAt: null, chain: null };
        break;
      }
      case "propose": {
        const cur = st.offers.find((o) => o.id === st.currentOfferId);
        if (cur?.status === "accepted") throw conflict("An offer was already accepted. Sign the settlement instead.");
        const held = st.claim?.status === "filed" ? st.claim.chain!.heldMinor : null;
        if (held === null) throw conflict("The claim isn't filed and verified on devnet yet.");
        if (write.toSupplierMinor + write.toBuyerMinor !== held) throw bad(`The split must add up to exactly the ${held} held in escrow.`);
        if (write.kind === "split" && (write.toSupplierMinor === 0 || write.toBuyerMinor === 0)) throw bad("A split gives both sides something.");
        if (cur?.status === "open") {
          if (write.replacesOfferId !== cur.id) throw conflict("The agreement changed on another device.");
          if (cur.proposedBy === write.as) throw conflict("You can't counter your own offer. Wait for the other side to answer.");
          Object.assign(cur, { status: "superseded", respondedBy: write.as, respondedAt: this.now() });
        } else if (write.replacesOfferId !== null) throw conflict("The agreement changed on another device.");
        const offer = {
          id: `off_${++this.n}`,
          version: st.offers.length + 1,
          proposedBy: write.as,
          kind: write.kind,
          toSupplierMinor: write.toSupplierMinor,
          toBuyerMinor: write.toBuyerMinor,
          status: "open" as const,
          replacesOfferId: write.replacesOfferId,
          createdAt: this.now(),
          respondedBy: null,
          respondedAt: null,
        };
        st.offers.unshift(offer);
        st.currentOfferId = offer.id;
        break;
      }
      case "accept":
      case "reject": {
        const offer = st.offers.find((o) => o.id === write.offerId);
        if (!offer) throw new ApiRequestError(`Offer ${write.offerId} not found`, 404, "not_found");
        if (offer.status !== "open" || st.currentOfferId !== offer.id) throw conflict(`That offer is ${offer.status} and can no longer be answered.`);
        if (offer.version !== write.version || offer.toSupplierMinor !== write.toSupplierMinor || offer.toBuyerMinor !== write.toBuyerMinor)
          throw conflict("The offer you reviewed doesn't match the offer on the server. Reload and review it.");
        if (offer.proposedBy === write.as) throw conflict("You can't answer your own offer.");
        const t = this.now();
        Object.assign(offer, { status: write.action === "accept" ? "accepted" : "rejected", respondedBy: write.as, respondedAt: t });
        if (write.action === "accept") st.settlement = { offerId: offer.id, status: "awaiting_signatures", signature: null, error: null, updatedAt: t, attempts: [] };
        else st.currentOfferId = null;
        break;
      }
      case "record_settlement": {
        const s = st.settlement;
        if (!s) throw conflict("There is no accepted offer to settle.");
        if (write.offerId !== s.offerId) throw conflict("That isn't the accepted offer.");
        if (s.status === "confirmed") throw conflict("This settlement is already confirmed on devnet.");
        if (s.status === "submitted" || s.status === "unknown")
          throw conflict(`Settle transaction ${s.signature} was already sent and could still move funds. Re-check it; don't send another.`);
        const at = this.now();
        s.attempts.push({ signature: write.signature, lastValidBlockHeight: write.lastValidBlockHeight, status: "submitted", error: null, reportedBy: write.as, at });
        Object.assign(s, { status: "submitted", signature: write.signature, error: null, updatedAt: at });
        break;
      }
    }
    this.commit(r, key);
    if (drop) throw new ApiRequestError("Can't reach the ClearDock server. Is it running?", 0);
    return this.view(r);
  }

  async confirmClaim(orderId: string, claimSignature: string) {
    const r = this.rec(orderId);
    const c = r.st.claim;
    if (!c) throw conflict("Save the reviewed claim first, then confirm the on-chain claim.");
    if (c.status === "filed") {
      if (c.claimSignature === claimSignature) return this.view(r);
      throw conflict("A different claim transaction is already filed for this order.");
    }
    this.chainHeld = c.claimedMinor;
    Object.assign(c, { status: "filed", claimSignature, filedAt: this.now(), chain: { escrowAddress: "esc", heldMinor: c.claimedMinor, releasedMinor: 0, refundedMinor: 0 } });
    this.commit(r, `confirm_claim:${claimSignature}`);
    return this.view(r);
  }

  async recheckSettlement(orderId: string, signature: string) {
    const r = this.rec(orderId);
    const s = r.st.settlement;
    const a = s?.attempts.find((x) => x.signature === signature);
    if (!s || !a) throw bad("signature must be a known settle signature");
    if (a.status === "confirmed" || a.status === "failed") return this.view(r);
    const out = this.nextSettleOutcome;
    if (out.status !== a.status || out.error !== a.error) {
      Object.assign(a, out);
      if (s.signature === a.signature) Object.assign(s, { ...out, updatedAt: this.now() });
      this.commit(r, `reconcile:${signature}:${out.status}`);
    }
    return this.view(r);
  }
}
