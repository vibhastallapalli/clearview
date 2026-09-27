import type { EscrowRecord } from "@cleardock/shared";
import { money } from "../api";
import type { AgreementOffer, AgreementOfferKind, AgreementState, Party, SettlementStatus } from "./contract";

// Pure rules for showing a server-held agreement. The server decides; these only derive what to show
// and refuse to prepare anything from stale data. All amounts are integer minor units.

export const OTHER: Record<Party, Party> = { buyer: "supplier", supplier: "buyer" };

export const KIND_LABEL: Record<AgreementOfferKind, string> = {
  full_refund: "Full refund",
  full_release: "Full release",
  split: "Split",
};

/**
 * "12", "12.5", "12.50", "$1,012.50" → minor units. Null for anything else (negatives, 3+ decimals, text).
 * Parsed as text so no floating point touches money.
 */
export function parseAmountToMinor(text: string): number | null {
  const m = /^\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const whole = Number(m[1].replace(/,/g, ""));
  const cents = Number((m[2] ?? "").padEnd(2, "0"));
  const minor = whole * 100 + cents;
  return Number.isSafeInteger(minor) ? minor : null;
}

/** The amount the escrow program still holds for the claim, read from the server's verified copy of the chain. */
export function heldMinor(escrow: EscrowRecord | null | undefined): number | null {
  if (!escrow || escrow.status !== "claimed") return null;
  return escrow.totalMinor - escrow.releasedMinor - escrow.refundedMinor;
}

export function splitFor(kind: AgreementOfferKind, held: number, toSupplierMinor = 0): { toSupplierMinor: number; toBuyerMinor: number } {
  const sup = kind === "full_refund" ? 0 : kind === "full_release" ? held : toSupplierMinor;
  return { toSupplierMinor: sup, toBuyerMinor: held - sup };
}

/** Null when the split is valid for the held amount, else a sentence for the user. */
export function splitError(held: number, toSupplierMinor: number, toBuyerMinor: number): string | null {
  if (![held, toSupplierMinor, toBuyerMinor].every(Number.isSafeInteger)) return "Amounts must be whole cents.";
  if (toSupplierMinor < 0 || toBuyerMinor < 0) return "Neither side can get less than $0.00.";
  if (toSupplierMinor + toBuyerMinor !== held) return "The split must add up to exactly the amount held in escrow.";
  return null;
}

export const currentOffer = (st: AgreementState): AgreementOffer | null =>
  st.offers.find((o) => o.id === st.currentOfferId) ?? null;

/** Offers that can no longer be acted on, newest first. */
export const pastOffers = (st: AgreementState): AgreementOffer[] => st.offers.filter((o) => o.id !== st.currentOfferId);

const IN_FLIGHT: SettlementStatus[] = ["submitted", "unknown", "confirmed"];

export type Phase =
  | "no_claim" // escrow not claimed on the server yet
  | "no_offer" // claim filed, nobody has proposed (or the last offer was rejected)
  | "open" // an offer waits for an answer
  | "agreed" // both agreed; nothing signed or sent. Funds have NOT moved.
  | "settling" // settle transaction sent; outcome pending or unknown
  | "settled"; // the server verified the settle transaction on devnet

export interface AgreementView {
  phase: Phase;
  current: AgreementOffer | null;
  past: AgreementOffer[];
  /** Who has to act now, per the server. */
  waitingOn: Party | null;
  youAct: boolean;
  canPropose: boolean;
  canRespond: boolean;
}

export function viewFor(st: AgreementState, role: Party, escrow: EscrowRecord | null | undefined): AgreementView {
  const current = currentOffer(st);
  const past = pastOffers(st);
  const s = st.settlement?.status;
  let phase: Phase;
  if (escrow?.status === "settled" || s === "confirmed") phase = "settled";
  else if (s === "submitted" || s === "unknown") phase = "settling";
  else if (!st.claim) phase = "no_claim";
  else if (current?.status === "accepted") phase = "agreed";
  else if (current?.status === "open") phase = "open";
  else phase = "no_offer";

  const waitingOn = st.nextActor;
  const yourTurn = waitingOn === null || waitingOn === role;
  const canRespond = phase === "open" && current!.proposedBy !== role && waitingOn === role;
  const canPropose = (phase === "no_offer" && yourTurn) || canRespond;
  return { phase, current, past, waitingOn, youAct: waitingOn === role, canPropose, canRespond };
}

/** What a user saw when they pressed accept/reject/counter or started signing. */
export interface Reviewed {
  offerId: string;
  version: number;
  toSupplierMinor: number;
  toBuyerMinor: number;
  revision: number;
}

export const reviewedFrom = (st: AgreementState, offer: AgreementOffer): Reviewed => ({
  offerId: offer.id,
  version: offer.version,
  toSupplierMinor: offer.toSupplierMinor,
  toBuyerMinor: offer.toBuyerMinor,
  revision: st.revision,
});

export const OFFER_CHANGED = "The offer changed on the other device. Review the current offer before you answer or sign.";

/** Null if the reviewed offer is still the current one with the same split; else why not. */
export function reviewStale(reviewed: Reviewed, latest: AgreementState): string | null {
  const now = currentOffer(latest);
  if (!now || now.id !== reviewed.offerId || now.version !== reviewed.version) return OFFER_CHANGED;
  if (now.toSupplierMinor !== reviewed.toSupplierMinor || now.toBuyerMinor !== reviewed.toBuyerMinor) return OFFER_CHANGED;
  return null;
}

export type SettlePlan =
  | { ok: true; offer: AgreementOffer; toSupplier: number; toBuyer: number }
  | { ok: false; reason: string };

/**
 * The settle transaction may only carry the accepted offer's split, and only while the chain still holds
 * exactly that amount and no earlier settle transaction could still land.
 */
export function settlePlan(latest: AgreementState, escrow: EscrowRecord | null | undefined, reviewed?: Reviewed): SettlePlan {
  const offer = currentOffer(latest);
  if (!offer || offer.status !== "accepted") return { ok: false, reason: "There is no agreed offer to sign." };
  if (reviewed) {
    const stale = reviewStale(reviewed, latest);
    if (stale) return { ok: false, reason: stale };
  }
  const s = latest.settlement;
  if (s && s.offerId === offer.id && IN_FLIGHT.includes(s.status))
    return {
      ok: false,
      reason:
        s.status === "confirmed"
          ? "This settlement is already confirmed."
          : "A settlement transaction was already sent. Re-check it instead of signing a new one.",
    };
  const held = heldMinor(escrow);
  if (held === null) return { ok: false, reason: "The escrow isn't holding a claimed amount on devnet, so there is nothing to settle." };
  const err = splitError(held, offer.toSupplierMinor, offer.toBuyerMinor);
  if (err) return { ok: false, reason: `The agreed split doesn't match the ${money(held)} held on devnet. ${err}` };
  return { ok: true, offer, toSupplier: offer.toSupplierMinor, toBuyer: offer.toBuyerMinor };
}

/** A settle signature sent from this browser whose outcome we don't know yet. A recovery hint, never the source of truth. */
export interface PendingSettle {
  orderId: string;
  offerId: string;
  signature: string;
  /** After this block height the transaction can no longer land (lets us prove an expiry). */
  lastValidBlockHeight: number;
  sentAt: string;
}

const PENDING_KEY = "cleardock.pendingSettle.v1";

export function loadPending(orderId: string): PendingSettle | null {
  try {
    const all = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "{}") as Record<string, PendingSettle>;
    return all[orderId] ?? null;
  } catch {
    return null;
  }
}

export function savePending(p: PendingSettle | null, orderId: string) {
  try {
    const all = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "{}") as Record<string, PendingSettle>;
    if (p) all[orderId] = p;
    else delete all[orderId];
    localStorage.setItem(PENDING_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable: the server's settlement record is still the source of truth.
  }
}
