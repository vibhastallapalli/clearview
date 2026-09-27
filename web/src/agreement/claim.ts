import type { ClaimLine, OrderDetail } from "@cleardock/shared";
import { overridden, type Evidence, type Line, type SignRequest } from "../escrow/demo";
import type { AgreementApi } from "./client";
import type { AgreementState, AgreementWrite } from "./contract";
import type { AgreementSession } from "./session";

/** The buyer's reviewed claim as a prepare_claim write: the unseen/claimed lines of the reviewed station scan. */
export function claimWrite(st: AgreementState, detail: OrderDetail, lines: Line[], from: Evidence): AgreementWrite {
  const claimed = lines.filter((l) => l.claim);
  const claimLines: ClaimLine[] = claimed.map((l) => ({ sku: null, description: l.label, claimedMinor: l.priceMinor, reason: "missing" }));
  return {
    action: "prepare_claim",
    as: "buyer",
    expectedRevision: st.revision,
    scanId: from.scanId,
    evidenceRevision: from.revision,
    lines: claimLines,
    claimedMinor: claimLines.reduce((s, l) => s + l.claimedMinor, 0),
    // Raw phone photos attached to the scan the lines were reviewed from.
    proofIds: detail.proofs.filter((p) => p.stationScanId === from.scanId).map((p) => p.id),
    // Every reviewed line: the scan suggestion next to the buyer decision, with the reason for any override.
    decisions: lines.map((l) => ({
      description: l.label,
      priceMinor: l.priceMinor,
      suggested: l.miss ? "claim" : "accept",
      decided: l.claim ? "claim" : "accept",
      overrideReason: overridden(l) ? (l.reason ?? "").trim() : null,
    })),
  };
}

/**
 * Wraps the on-chain claim so the reviewed claim is saved (signed by the buyer wallet) BEFORE the claim
 * transaction is signed, and linked to it once devnet confirms it (CONTRACTS.md "Agreement" step 2).
 */
export function withSavedClaim(
  req: SignRequest,
  ctx: { session: AgreementSession; api: AgreementApi; detail: OrderDetail; lines: Line[]; from: Evidence | null | undefined },
): SignRequest {
  if (req.chain?.action !== "claim") return req;
  const { session, api, detail, lines, from } = ctx;
  const orderId = detail.order.id;
  return {
    ...req,
    rows: [...req.rows, ["Before signing", "Your buyer wallet signs the claimed lines for ClearDock (moves nothing)"]],
    precheck: async () => {
      if (!from) throw new Error("Review the station report on this device before claiming.");
      const read = await session.refresh();
      if (session.status === "unavailable") throw new Error("This server can't save the claim, so nothing was signed.");
      const st = session.state;
      if (!st || !read) throw new Error(`Couldn't load the agreement: ${session.loadError ?? "no reply"}. Nothing was signed.`);
      if (st.claim?.status === "filed") throw new Error("A claim is already filed for this order.");
      const saved = await session.write(claimWrite(st, detail, lines, from));
      if (!saved) throw new Error(`The claim wasn't saved, so nothing was signed. ${session.notice?.text ?? ""}`.trim());
    },
    confirmed: async (tx) => {
      session.accept(await api.confirmClaim(orderId, tx.sig));
    },
  };
}
