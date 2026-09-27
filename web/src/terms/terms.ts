import {
  TERMS_PATHS,
  orderTermsMessage,
  termsHashOf,
  type OrderDetail,
  type OrderTerms,
  type OrderTermsLine,
  type OrderTermsState,
  type Party,
  type TermsPreview,
} from "@cleardock/shared";
import { json, request } from "../api";
import { parseAmountToMinor } from "../agreement/model";

// Order terms agreed BEFORE funding (CONTRACTS.md "Order terms"). Account 1's API; separate from the
// post-claim settlement agreement in web/src/agreement.

export const termsApi = {
  get: (orderId: string) => request<OrderTermsState>(TERMS_PATHS.state(orderId)),
  preview: (orderId: string, body: { lines: OrderTermsLine[]; inspectionHours: number }) =>
    request<TermsPreview>(TERMS_PATHS.preview(orderId), json(body)),
  propose: (orderId: string, body: { as: Party; expectedRevision: number; lines: OrderTermsLine[]; inspectionHours: number; walletSignature: string }) =>
    request<OrderTermsState>(TERMS_PATHS.propose(orderId), json(body)),
  approve: (orderId: string, body: { as: Party; version: number; termsHash: string; walletSignature: string }) =>
    request<OrderTermsState>(TERMS_PATHS.approve(orderId), json(body)),
};

export const DEFAULT_INSPECTION_HOURS = 72;

/** An editable line: text fields as typed, parsed only when previewing. */
export interface DraftLine {
  sku: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
}

const dollars = (minor: number) => (minor / 100).toFixed(2);
export const toDraft = (l: OrderTermsLine): DraftLine => ({ sku: l.sku, description: l.description, quantity: String(l.quantity), unitPrice: dollars(l.unitPriceMinor) });

/** Draft lines to start from: the current version if there is one (to change it), else the latest purchase order. */
export function initialDraft(state: OrderTermsState | null, detail: Pick<OrderDetail, "documents">): { lines: DraftLine[]; hours: number; from: string | null } {
  if (state?.current) return { lines: state.current.terms.lines.map(toDraft), hours: state.current.terms.inspection.hours, from: `terms v${state.current.version}` };
  const po = detail.documents.filter((d) => d.kind === "purchase_order").at(-1);
  if (po?.lines.length)
    return {
      lines: po.lines.map((l) => toDraft({ sku: l.sku, description: l.description, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor })),
      hours: DEFAULT_INSPECTION_HOURS,
      from: `purchase order ${po.source.filename}`,
    };
  return { lines: [{ sku: null, description: "", quantity: "1", unitPrice: "" }], hours: DEFAULT_INSPECTION_HOURS, from: null };
}

/** Parses the draft into whole-cent lines, or says what's wrong. The server computes the total. */
export function parseDraft(lines: DraftLine[], hoursText: string): { lines: OrderTermsLine[]; inspectionHours: number } | { error: string } {
  if (!lines.length) return { error: "Add at least one line." };
  const out: OrderTermsLine[] = [];
  for (const [i, l] of lines.entries()) {
    const n = i + 1;
    if (!l.description.trim()) return { error: `Line ${n}: describe the product.` };
    if (!/^\d+$/.test(l.quantity.trim()) || Number(l.quantity) < 1) return { error: `Line ${n}: quantity must be a whole number of at least 1.` };
    const price = parseAmountToMinor(l.unitPrice);
    if (price === null) return { error: `Line ${n}: unit price must be an amount like 10.00.` };
    out.push({ sku: l.sku, description: l.description.trim(), quantity: Number(l.quantity), unitPriceMinor: price });
  }
  if (!/^\d+$/.test(hoursText.trim()) || Number(hoursText) < 1 || Number(hoursText) > 720) return { error: "Inspection window must be 1 to 720 hours." };
  return { lines: out, inspectionHours: Number(hoursText) };
}

/** Why funding is blocked, or null when the current terms are agreed by both parties. */
export function fundingBlock(state: OrderTermsState | null, loadError?: string | null): string | null {
  if (!state) return loadError ? `Can't read the order terms: ${loadError}` : "Loading the order terms…";
  switch (state.status) {
    case "agreed":
      return null;
    case "none":
      return "No order terms yet. Propose terms and get the other party's approval before funding.";
    case "awaiting_approval":
      return `Terms v${state.current!.version} are waiting on the ${state.outstanding.join(" and ")}'s approval.`;
    case "stale":
      return `Terms v${state.current!.version} are stale: ${state.staleReason} Funding is blocked until both approve a new version.`;
    case "funded":
      return "Already funded. The terms are frozen.";
    case "legacy":
      return "This escrow was funded before order terms existed.";
  }
}

export const walletOf = (t: OrderTerms, as: Party) => (as === "buyer" ? t.buyerWallet : t.supplierWallet);

/**
 * The exact text to sign for a version, after checking the terms shown are the ones the hash commits to
 * (what you see is what you sign) and that Phantom is on this party's wallet. Throws otherwise; nothing is signed.
 */
export async function termsToSign(orderId: string, as: Party, v: { version: number; termsHash: string; terms: OrderTerms }, connected: string): Promise<string> {
  if ((await termsHashOf(v.terms)) !== v.termsHash) throw new Error("The terms from the server don't match their hash. Nothing was signed; reload.");
  const expected = walletOf(v.terms, as);
  if (connected !== expected) throw new Error(`Phantom is on ${connected.slice(0, 4)}…${connected.slice(-4)}. Switch Phantom to the ${as} wallet ${expected.slice(0, 4)}…${expected.slice(-4)}, then try again. Nothing was sent.`);
  return orderTermsMessage(orderId, v.version, v.termsHash, v.terms);
}
