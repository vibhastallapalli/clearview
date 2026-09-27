import type { EscrowRecord, RemedyDefault } from "@cleardock/shared";
import { money } from "../api";
import type { AgreementOffer, AgreementOfferKind, AgreementState, AgreementWrite, Party, SettlementStatus } from "./contract";

// Pure rules for showing the server's agreement (CONTRACTS.md "Agreement"). The server decides; these
// derive what to show and refuse to prepare anything from stale data. All amounts are integer minor units.

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

/** The amount the escrow program still holds for the claim, from the server's verified copy of the chain. */
export function heldMinor(escrow: EscrowRecord | null | undefined): number | null {
  if (!escrow || escrow.status !== "claimed") return null;
  return escrow.totalMinor - escrow.releasedMinor - escrow.refundedMinor;
}

export function splitFor(kind: AgreementOfferKind, held: number, toSupplierMinor = 0): { toSupplierMinor: number; toBuyerMinor: number } {
  const sup = kind === "full_refund" ? 0 : kind === "full_release" ? held : toSupplierMinor;
  return { toSupplierMinor: sup, toBuyerMinor: held - sup };
}

/** Null when the offer is valid for the held amount (same rules as the server), else a sentence for the user. */
export function offerError(kind: AgreementOfferKind, held: number, toSupplierMinor: number, toBuyerMinor: number): string | null {
  if (![held, toSupplierMinor, toBuyerMinor].every(Number.isSafeInteger)) return "Amounts must be whole cents.";
  if (toSupplierMinor < 0 || toBuyerMinor < 0) return "Neither side can get less than $0.00.";
  if (toSupplierMinor + toBuyerMinor !== held) return "The split must add up to exactly the amount held in escrow.";
  if (kind === "split" && (toSupplierMinor === 0 || toBuyerMinor === 0))
    return "A split gives both sides something. Use full refund or full release instead.";
  return null;
}

/** How much less than the signed remedy schedule an offer refunds, or null if it meets it (or there is no schedule). */
export const belowRemedy = (toBuyerMinor: number, remedy: RemedyDefault | null) =>
  remedy && toBuyerMinor < remedy.toBuyerMinor ? remedy.toBuyerMinor - toBuyerMinor : null;

export const currentOffer = (st: AgreementState): AgreementOffer | null =>
  st.offers.find((o) => o.id === st.currentOfferId) ?? null;

/** Offers that can no longer be acted on, newest first. */
export const pastOffers = (st: AgreementState): AgreementOffer[] => st.offers.filter((o) => o.id !== st.currentOfferId);

const IN_FLIGHT: SettlementStatus[] = ["submitted", "unknown", "confirmed"];

export type Phase =
  | "no_claim" // nothing saved
  | "claim_saved" // the buyer's claim is saved; the on-chain claim isn't verified yet
  | "no_offer" // claim filed, nobody has proposed (or the last offer was rejected)
  | "open" // an offer waits for an answer
  | "agreed" // accepted; nothing signed or sent (or the last settle attempt provably failed). Funds have NOT moved.
  | "settling" // a settle signature was reported; outcome pending or unknown
  | "settled"; // the server verified the settle transaction on devnet with the accepted split

export interface AgreementView {
  phase: Phase;
  current: AgreementOffer | null;
  past: AgreementOffer[];
  /** Who has to act now, per the server (null = either may, or nobody). */
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
  if (s === "confirmed" || (escrow?.status === "settled" && st.settlement)) phase = "settled";
  else if (s === "submitted" || s === "unknown") phase = "settling";
  else if (!st.claim) phase = "no_claim";
  else if (st.claim.status !== "filed") phase = "claim_saved";
  else if (current?.status === "accepted") phase = "agreed";
  else if (current?.status === "open") phase = "open";
  else phase = "no_offer";

  const waitingOn = st.nextActor;
  const canRespond = phase === "open" && current!.proposedBy !== role && waitingOn === role;
  const canPropose = phase === "no_offer" || canRespond;
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

/** The signed answer to exactly the offer that was reviewed (the server refuses it if any of this changed). */
export const answerWrite = (action: "accept" | "reject", as: Party, r: Reviewed): AgreementWrite => ({
  action,
  as,
  expectedRevision: r.revision,
  offerId: r.offerId,
  version: r.version,
  toSupplierMinor: r.toSupplierMinor,
  toBuyerMinor: r.toBuyerMinor,
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
 * The settle transaction may only carry the accepted offer's split, only while devnet still holds exactly
 * the claimed amount, and only when no earlier settle signature could still move funds.
 */
export function settlePlan(latest: AgreementState, escrow: EscrowRecord | null | undefined, reviewed?: Reviewed): SettlePlan {
  const offer = currentOffer(latest);
  if (!offer || offer.status !== "accepted") return { ok: false, reason: "There is no agreed offer to sign." };
  if (reviewed) {
    const stale = reviewStale(reviewed, latest);
    if (stale) return { ok: false, reason: stale };
  }
  const s = latest.settlement;
  if (!s || s.offerId !== offer.id) return { ok: false, reason: "The server has no settlement for the agreed offer." };
  if (IN_FLIGHT.includes(s.status))
    return {
      ok: false,
      reason:
        s.status === "confirmed"
          ? "This settlement is already confirmed."
          : "A settlement transaction was already sent and could still move funds. Re-check it instead of signing a new one.",
    };
  const held = heldMinor(escrow);
  const claimed = latest.claim?.chain?.heldMinor ?? null;
  if (held === null) return { ok: false, reason: "The escrow isn't holding a claimed amount on devnet, so there is nothing to settle." };
  if (claimed !== null && claimed !== held)
    return { ok: false, reason: `Devnet holds ${money(held)}, not the ${money(claimed)} the claim locked. Nothing can be settled from this page.` };
  if (offer.toSupplierMinor + offer.toBuyerMinor !== held)
    return { ok: false, reason: `The agreed split doesn't add up to the ${money(held)} held on devnet.` };
  return { ok: true, offer, toSupplier: offer.toSupplierMinor, toBuyer: offer.toBuyerMinor };
}
