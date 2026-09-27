import type { AgreementApi } from "./client";
import { isConflict, isNetwork, isUnavailable } from "./client";
import type { AgreementOfferKind, AgreementState, Party } from "./contract";
import { OFFER_CHANGED, currentOffer, reviewStale, type Reviewed } from "./model";

export type LoadStatus = "loading" | "ready" | "unavailable" | "error";

export interface Notice {
  tone: "warn" | "bad" | "ok";
  text: string;
  /** Present when the same request can safely be sent again. */
  retry?: boolean;
}

/** What a write was meant to do, so a reply lost to the network can be recognised in the refreshed state. */
type Intent =
  | { kind: "propose"; as: Party; toSupplierMinor: number; toBuyerMinor: number; replacesOfferId: string | null; expectedRevision: number; offerKind: AgreementOfferKind }
  | { kind: "accept" | "reject"; as: Party; reviewed: Reviewed };

export const UNAVAILABLE =
  "This server doesn't support shared settlement offers yet, so offers can't be made here. Nothing was sent.";

function applied(intent: Intent, st: AgreementState): boolean {
  const cur = currentOffer(st);
  if (intent.kind === "propose")
    return (
      !!cur &&
      cur.proposedBy === intent.as &&
      cur.replacesOfferId === intent.replacesOfferId &&
      cur.toSupplierMinor === intent.toSupplierMinor &&
      cur.toBuyerMinor === intent.toBuyerMinor
    );
  const offer = st.offers.find((o) => o.id === intent.reviewed.offerId);
  return offer?.respondedBy === intent.as && offer.status === (intent.kind === "accept" ? "accepted" : "rejected");
}

/**
 * Holds the server's agreement for one order and sends writes. The server's reply always replaces local
 * state; nothing here is a source of truth. A write is refused locally if the offer the user reviewed is
 * no longer current, and the server refuses it (409) if this tab was behind.
 */
export class AgreementSession {
  state: AgreementState | null = null;
  status: LoadStatus = "loading";
  loadError: string | null = null;
  notice: Notice | null = null;
  busy = false;
  private pending: Intent | null = null;

  constructor(
    private api: AgreementApi,
    readonly orderId: string,
    private onChange: () => void = () => {},
  ) {}

  private set(st: AgreementState) {
    // Never go backwards: a slow poll must not replace a newer reply.
    if (!this.state || st.revision >= this.state.revision) this.state = st;
    this.status = "ready";
    this.loadError = null;
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

  propose(as: Party, offerKind: AgreementOfferKind, toSupplierMinor: number, toBuyerMinor: number) {
    const st = this.state;
    if (!st) return Promise.resolve();
    const cur = currentOffer(st);
    const replacesOfferId = cur?.status === "open" ? cur.id : null;
    return this.send({ kind: "propose", as, offerKind, toSupplierMinor, toBuyerMinor, replacesOfferId, expectedRevision: st.revision });
  }

  respond(as: Party, reviewed: Reviewed, accept: boolean) {
    return this.send({ kind: accept ? "accept" : "reject", as, reviewed });
  }

  /** Re-send the last write that failed on the network, after checking whether it already went through. */
  async retry() {
    if (this.pending) await this.send(this.pending);
  }

  private async send(intent: Intent) {
    if (this.busy) return;
    if (intent.kind !== "propose" && this.state) {
      const stale = reviewStale(intent.reviewed, this.state);
      if (stale) {
        this.notice = { tone: "warn", text: stale };
        this.onChange();
        return;
      }
    }
    this.busy = true;
    this.notice = null;
    this.onChange();
    try {
      if (this.pending === intent) {
        // A previous attempt may have landed before the connection dropped.
        const now = await this.api.get(this.orderId);
        this.set(now);
        if (applied(intent, now)) {
          this.pending = null;
          this.notice = { tone: "ok", text: "Saved. The server had already received it before the connection dropped." };
          return;
        }
      }
      this.set(await this.write(intent));
      this.pending = null;
    } catch (err) {
      if (isNetwork(err)) {
        this.pending = intent;
        this.notice = { tone: "bad", text: `${(err as Error).message} Your answer may not have been saved.`, retry: true };
      } else if (isConflict(err)) {
        this.pending = null;
        this.notice = { tone: "warn", text: OFFER_CHANGED };
        await this.refresh();
      } else if (isUnavailable(err)) {
        this.pending = null;
        this.status = "unavailable";
        this.notice = { tone: "bad", text: UNAVAILABLE };
      } else {
        this.pending = null;
        this.notice = { tone: "bad", text: (err as Error).message };
      }
    } finally {
      this.busy = false;
      this.onChange();
    }
  }

  private write(i: Intent): Promise<AgreementState> {
    if (i.kind === "propose")
      return this.api.propose(this.orderId, {
        as: i.as,
        kind: i.offerKind,
        toSupplierMinor: i.toSupplierMinor,
        toBuyerMinor: i.toBuyerMinor,
        replacesOfferId: i.replacesOfferId,
        expectedRevision: i.expectedRevision,
      });
    const body = { as: i.as, expectedRevision: i.reviewed.revision };
    return i.kind === "accept"
      ? this.api.accept(this.orderId, i.reviewed.offerId, body)
      : this.api.reject(this.orderId, i.reviewed.offerId, body);
  }
}
