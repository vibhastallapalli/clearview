import type { AgreementOfferKind } from "@cleardock/shared";
import { parseAmountToMinor } from "../agreement/model";

// Chat commands, parsed by plain code (never by AI). An offer command becomes the same wallet-signed
// agreement offer the buttons make; nothing here moves money.

export type Command =
  | { type: "offer"; kind: AgreementOfferKind; toSupplierMinor: number; toBuyerMinor: number }
  | { type: "accept" }
  | { type: "reject" }
  | { type: "help" }
  | { type: "error"; message: string };

export const COMMAND_HELP = [
  "/offer 5.00 → $5.00 to the supplier, the rest back to you/the buyer",
  "/offer refund 5.00 → $5.00 back to the buyer, the rest to the supplier",
  "/offer full refund · /offer full release",
  "/counter … works like /offer when answering an open offer",
  "/accept · /reject → answer the current offer",
];

/** Null if the text isn't a command. */
export function parseCommand(text: string, heldMinor: number | null): Command | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!t.startsWith("/")) return null;
  const [cmd, ...rest] = t.split(" ");
  const args = rest.join(" ");
  if (cmd === "/accept" && !args) return { type: "accept" };
  if (cmd === "/reject" && !args) return { type: "reject" };
  if (cmd === "/help") return { type: "help" };
  if (cmd !== "/offer" && cmd !== "/counter") return { type: "error", message: `Unknown command ${cmd}. Try /help.` };
  if (heldMinor === null) return { type: "error", message: "There is no held amount to split yet." };

  const offer = (toSupplierMinor: number): Command => {
    if (toSupplierMinor > heldMinor) return { type: "error", message: `Only ${(heldMinor / 100).toFixed(2)} is held; you can't split more than that.` };
    const toBuyerMinor = heldMinor - toSupplierMinor;
    const kind: AgreementOfferKind = toSupplierMinor === 0 ? "full_refund" : toBuyerMinor === 0 ? "full_release" : "split";
    return { type: "offer", kind, toSupplierMinor, toBuyerMinor };
  };
  if (args === "full refund" || args === "refund all") return offer(0);
  if (args === "full release" || args === "release all") return offer(heldMinor);
  const refund = /^refund \$?(\S+)$/.exec(args);
  if (refund) {
    const m = parseAmountToMinor(refund[1]);
    if (m === null) return { type: "error", message: "Write the refund as an amount, like /offer refund 5.00." };
    if (m > heldMinor) return { type: "error", message: `Only ${(heldMinor / 100).toFixed(2)} is held.` };
    return offer(heldMinor - m);
  }
  const toSupplier = /^\$?(\S+?)( to (the )?supplier)?$/.exec(args);
  const m = toSupplier ? parseAmountToMinor(toSupplier[1]) : null;
  if (m === null) return { type: "error", message: "Write an amount, like /offer 5.00 (to the supplier) or /offer refund 5.00." };
  return offer(m);
}
