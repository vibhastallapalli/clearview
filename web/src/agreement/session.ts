import { WalletError } from "../wallet/phantom";
import type { AgreementApi } from "./client";
import { isConflict, isNetwork, isUnavailable, isWrongWallet } from "./client";
import type { AgreementOfferKind, AgreementRequest, AgreementState, AgreementWrite, Party } from "./contract";
import { answerWrite, currentOffer, reviewStale, type Reviewed } from "./model";
import type { Signer } from "./signer";

export type LoadStatus = "loading" | "ready" | "unavailable" | "error";

export interface Notice {
  tone: "warn" | "bad" | "ok";
  text: string;
  /** Present when the same signed request can safely be sent again. */
  retry?: boolean;
}

export const UNAVAILABLE =
  "This server doesn't support shared settlement offers, so offers can't be made here. Nothing was sent.";

/**
 * Holds the server's agreement for one order and sends signed writes. The server's reply always replaces
 * local state; nothing here is a source of truth. A write is refused locally if the offer the user reviewed
 * is no longer current, and the server refuses it (409) if this tab was behind.
 */
export class AgreementSession {
  state: AgreementState | null = null;
  status: LoadStatus = "loading";
  loadError: string | null = null;
  notice: Notice | null = null;
  busy = false;
  /** The last signed request that got no reply. Resending the same bytes is safe: the server recognises it. */
  private unsent: AgreementRequest | null = null;

  constructor(
    private api: AgreementApi,
    readonly orderId: string,
    private sign: Signer,
    private onChange: () => void = () => {},
  ) {}

  private set(st: AgreementState) {
    // Never go backwards: a slow poll must not replace a newer reply.
    if (!this.state || st.revision >= this.state.revision) this.state = st;
    this.status = "ready";
    this.loadError = null;
  }

  /** Replace state with a server reply (e.g. from a claim confirmation made elsewhere on the page). */
  accept(st: AgreementState) {
    this.set(st);
    this.onChange();
  }

  async refresh(): Promise<void> {
    try {
      this.set(await this.api.get(this.orderId));
    } catch (err) {
      if (isUnavailable(err)) this.status = "unavailable";
      else if (!this.state) {
        this.status = "error";
        this.loadError = (err as Error).message;
      }
      // With state already shown, a failed poll keeps it; the next poll tries again.
    }
    this.onChange();
  }

  propose(as: Party, kind: AgreementOfferKind, toSupplierMinor: number, toBuyerMinor: number) {
    const st = this.state;
    if (!st) return Promise.resolve();
    const cur = currentOffer(st);
    return this.write({
      action: "propose",
      as,
      expectedRevision: st.revision,
      kind,
      toSupplierMinor,
      toBuyerMinor,
      replacesOfferId: cur?.status === "open" ? cur.id : null,
    });
  }

  respond(as: Party, reviewed: Reviewed, accept: boolean) {
    if (this.state) {
      const stale = reviewStale(reviewed, this.state);
      if (stale) {
        this.notice = { tone: "warn", text: stale };
        this.onChange();
        return Promise.resolve();
      }
    }
    return this.write(answerWrite(accept ? "accept" : "reject", as, reviewed));
  }

  /** Sign and send any write (also used for the claim). Resolves to the new state, or null if it didn't apply. */
  async write(w: AgreementWrite): Promise<AgreementState | null> {
    if (this.busy) return null;
    this.busy = true;
    this.notice = null;
    this.onChange();
    try {
      let walletSignature: string;
      try {
        walletSignature = await this.sign(this.orderId, w);
      } catch (err) {
        const declined = err instanceof WalletError && err.code === "rejected";
        this.notice = {
          tone: "warn",
          text: declined ? "You declined the signature in Phantom. Nothing was sent." : (err as Error).message,
        };
        return null;
      }
      return await this.post({ ...w, walletSignature });
    } finally {
      this.busy = false;
      this.onChange();
    }
  }

  /** Resend the last signed request that got no reply. */
  async retry() {
    const req = this.unsent;
    if (!req || this.busy) return;
    this.busy = true;
    this.notice = null;
    this.onChange();
    try {
      const st = await this.post(req);
      if (st) this.notice = { tone: "ok", text: "Saved." };
    } finally {
      this.busy = false;
      this.onChange();
    }
  }

  private async post(req: AgreementRequest): Promise<AgreementState | null> {
    try {
      const st = await this.api.send(this.orderId, req);
      this.unsent = null;
      this.set(st);
      return st;
    } catch (err) {
      const msg = (err as Error).message;
      if (isNetwork(err)) {
        this.unsent = req;
        this.notice = { tone: "bad", text: `${msg} It may or may not have been saved; Retry sends the same signed request.`, retry: true };
      } else {
        this.unsent = null;
        if (isConflict(err)) {
          this.notice = { tone: "warn", text: msg };
          await this.refresh();
        } else if (isWrongWallet(err)) {
          this.notice = { tone: "bad", text: msg };
        } else if (isUnavailable(err)) {
          this.status = "unavailable";
          this.notice = { tone: "bad", text: UNAVAILABLE };
        } else {
          this.notice = { tone: "bad", text: msg };
        }
      }
      return null;
    }
  }
}

