import { createPublicKey, verify } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { PublicKey } from "@solana/web3.js";
import {
  agreementMessage,
  type AgreementOffer,
  type AgreementOfferKind,
  type AgreementState,
  type AgreementWrite,
  type ApiError,
  type ClaimLine,
  type Order,
  type Party,
  type SettlementAttempt,
} from "@cleardock/shared";
import { db, save, type AgreementRecord } from "./store.ts";
import { applyEscrowEvent, assertBelongsToOrder, EscrowRouteError, readEscrow, rpc, type RpcTransaction } from "./escrow.ts";
import { HttpError } from "./solana/payments.ts";

// Negotiating the held (claimed) escrow amount. See "Agreement" in CONTRACTS.md.
// Every check-and-write below runs synchronously (no await between reading the revision and saving),
// so two requests can't interleave inside one; after any await the state is re-read before changing it.

const now = () => new Date().toISOString();
const bad = (msg: string) => new HttpError(400, "bad_request", msg);
const conflict = (msg: string) => new HttpError(409, "conflict", msg);
const OTHER: Record<Party, Party> = { buyer: "supplier", supplier: "buyer" };
const KINDS: readonly AgreementOfferKind[] = ["full_refund", "full_release", "split"];
const REASONS: readonly ClaimLine["reason"][] = ["missing", "wrong_item", "damaged", "other"];
const STALE = "The agreement changed on another device. Reload it and review before you answer.";

// ---------- input ----------

function int(v: unknown, name: string, min = 0): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) throw bad(`${name} must be a whole number of at least ${min}`);
  return v;
}
function str(v: unknown, name: string, max = 200): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw bad(`${name} must be text of 1 to ${max} characters`);
  return v;
}
function offerKind(v: unknown): AgreementOfferKind {
  if (!KINDS.includes(v as AgreementOfferKind)) throw bad(`kind must be one of ${KINDS.join(", ")}`);
  return v as AgreementOfferKind;
}
function party(v: unknown): Party {
  if (v !== "buyer" && v !== "supplier") throw bad('as must be "buyer" or "supplier"');
  return v;
}
const isSignature = (v: unknown): v is string => typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(v);

// ---------- identity: the party's wallet signed agreementMessage(orderId, write) ----------

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** True if walletSignature (base64) is the wallet's ed25519 signature over message (Phantom signMessage). */
export function signedBy(wallet: string, message: string, walletSignature: unknown): boolean {
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, new PublicKey(wallet).toBuffer()]), format: "der", type: "spki" });
  const sig = typeof walletSignature === "string" ? Buffer.from(walletSignature, "base64") : Buffer.alloc(0);
  return sig.length === 64 && verify(null, Buffer.from(message), key, sig);
}

function assertSignedBy(order: Order, write: AgreementWrite, walletSignature: unknown) {
  // order.escrow is only written from verified chain state, bound to the demo buyer and verified supplier.
  const escrow = order.escrow;
  if (!escrow) throw conflict("This order has no verified escrow yet, so there are no buyer and supplier wallets to check.");
  const wallet = write.as === "buyer" ? escrow.buyer : escrow.supplier;
  if (!signedBy(wallet, agreementMessage(order.id, write), walletSignature)) {
    throw new HttpError(401, "unauthorized", `This action must be signed by the ${write.as} wallet ${wallet}.`);
  }
}

// ---------- state ----------

function getOrder(orderId: string): Order {
  const order = db.orders.find((o) => o.id === orderId);
  if (!order) throw new HttpError(404, "not_found", `Order ${orderId} not found`);
  return order;
}

function record(orderId: string): AgreementRecord {
  let rec = db.agreements.find((a) => a.orderId === orderId);
  if (!rec) {
    rec = { orderId, revision: 0, claim: null, offers: [], currentOfferId: null, nextActor: null, settlement: null, log: [] };
    db.agreements.push(rec);
  }
  return rec;
}

function view(rec: AgreementRecord): AgreementState {
  const { log: _log, ...state } = rec;
  const cur = rec.offers.find((o) => o.id === rec.currentOfferId);
  // The claim's own scan (never a newer one) and its photo. Scans and captures are never edited.
  const scan = rec.claim && db.scans.find((s) => s.id === rec.claim!.scanId);
  const stationCapture = (scan && db.captures.find((c) => c.id === scan.captureId)) ?? null;
  return { ...state, claim: rec.claim && { ...rec.claim, stationCapture }, nextActor: rec.claim?.status === "filed" && cur?.status === "open" ? OTHER[cur.proposedBy] : null };
}

/**
 * Revision check for a signed write. Returns false if this exact write was already applied as the next
 * revision (a retry after a lost reply): the caller answers with the current state and changes nothing.
 */
function fresh(rec: AgreementRecord, key: string, expectedRevision: number): boolean {
  if (expectedRevision === rec.revision) return true;
  if (rec.log.some((l) => l.revision === expectedRevision + 1 && l.key === key)) return false;
  throw conflict(`${STALE} (You had revision ${expectedRevision}; it is now ${rec.revision}.)`);
}

function commit(rec: AgreementRecord, key: string) {
  rec.revision += 1;
  rec.log.push({ revision: rec.revision, key });
  save();
}

const heldOnChain = (order: Order) =>
  order.escrow ? order.escrow.totalMinor - order.escrow.releasedMinor - order.escrow.refundedMinor : 0;

/** The split must hand out exactly what the verified claim holds, and the chain must still hold it. */
function assertSplit(order: Order, rec: AgreementRecord, kind: AgreementOfferKind, toSupplierMinor: number, toBuyerMinor: number) {
  const held = rec.claim?.status === "filed" ? rec.claim.chain!.heldMinor : null;
  if (held === null) throw conflict("The claim isn't filed and verified on devnet yet.");
  if (order.escrow?.status !== "claimed" || heldOnChain(order) !== held)
    throw conflict("The escrow on devnet no longer holds the claimed amount, so it can't be split.");
  if (toSupplierMinor + toBuyerMinor !== held) throw bad(`The split must add up to exactly the ${held} held in escrow.`);
  if (kind === "full_refund" && toSupplierMinor !== 0) throw bad("A full refund gives the supplier 0.");
  if (kind === "full_release" && toBuyerMinor !== 0) throw bad("A full release gives the buyer 0.");
  if (kind === "split" && (toSupplierMinor === 0 || toBuyerMinor === 0)) throw bad("A split gives both sides something; use full refund or full release.");
}

// ---------- claim ----------

function prepareClaim(order: Order, body: Record<string, unknown>): AgreementState {
  if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > 100) throw bad("lines must list 1 to 100 claimed lines");
  if (!Array.isArray(body.proofIds) || body.proofIds.length > 50) throw bad("proofIds must be a list of up to 50 proof ids");
  if (!Array.isArray(body.decisions) || body.decisions.length < 1 || body.decisions.length > 200) throw bad("decisions must list 1 to 200 reviewed lines");
  const write: AgreementWrite = {
    action: "prepare_claim",
    as: "buyer",
    expectedRevision: int(body.expectedRevision, "expectedRevision"),
    scanId: str(body.scanId, "scanId", 100),
    evidenceRevision: int(body.evidenceRevision, "evidenceRevision"),
    lines: body.lines.map((raw, i) => {
      const l = (raw ?? {}) as Record<string, unknown>;
      if (!REASONS.includes(l.reason as ClaimLine["reason"])) throw bad(`lines[${i}].reason must be one of ${REASONS.join(", ")}`);
      return {
        sku: l.sku === null ? null : str(l.sku, `lines[${i}].sku`, 100),
        description: str(l.description, `lines[${i}].description`),
        claimedMinor: int(l.claimedMinor, `lines[${i}].claimedMinor`, 1),
        reason: l.reason as ClaimLine["reason"],
      };
    }),
    claimedMinor: int(body.claimedMinor, "claimedMinor", 1),
    proofIds: body.proofIds.map((p, i) => str(p, `proofIds[${i}]`, 100)),
    decisions: body.decisions.map((raw, i) => {
      const d = (raw ?? {}) as Record<string, unknown>;
      const choice = (v: unknown, name: string) => {
        if (v !== "accept" && v !== "claim") throw bad(`decisions[${i}].${name} must be "accept" or "claim"`);
        return v;
      };
      const suggested = choice(d.suggested, "suggested");
      const decided = choice(d.decided, "decided");
      // The scan recommends, the buyer confirms: overriding it needs a reason, following it must not carry one.
      const overrideReason = suggested === decided ? null : str(d.overrideReason, `decisions[${i}].overrideReason (required when overriding the scan)`, 500);
      if (suggested === decided && d.overrideReason != null) throw bad(`decisions[${i}].overrideReason is only for lines that override the scan`);
      return { description: str(d.description, `decisions[${i}].description`), priceMinor: int(d.priceMinor, `decisions[${i}].priceMinor`), suggested, decided, overrideReason };
    }),
  };
  if (body.as !== "buyer") throw new HttpError(401, "unauthorized", "Only the buyer files a claim.");
  assertSignedBy(order, write, body.walletSignature);
  const rec = record(order.id);
  const key = agreementMessage(order.id, write);
  if (!fresh(rec, key, write.expectedRevision)) return view(rec);

  if (rec.claim?.status === "filed") throw conflict("The claim is already filed on devnet and can't be changed.");
  const escrow = order.escrow!;
  if (write.lines.reduce((s, l) => s + l.claimedMinor, 0) !== write.claimedMinor) throw bad("claimedMinor must equal the sum of the lines.");
  if (write.decisions.filter((d) => d.decided === "claim").reduce((s, d) => s + d.priceMinor, 0) !== write.claimedMinor)
    throw bad("The lines decided as claim must add up to claimedMinor.");
  if (escrow.status === "claimed" ? write.claimedMinor !== escrow.claimedMinor : escrow.status !== "funded" || write.claimedMinor > heldOnChain(order))
    throw conflict(`The claim must match what the escrow on devnet can hold (escrow is "${escrow.status}").`);
  const scan = db.scans.find((s) => s.id === write.scanId && s.orderId === order.id);
  if (!scan) throw bad("scanId must be a station scan of this order.");
  if (write.evidenceRevision > order.evidenceRevision) throw bad("evidenceRevision is newer than the order's evidence.");
  if (new Set(write.proofIds).size !== write.proofIds.length || !write.proofIds.every((p) => db.proofs.some((x) => x.id === p && x.orderId === order.id)))
    throw bad("proofIds must be distinct phone proofs of this order.");

  const { scanId, evidenceRevision, lines, claimedMinor, proofIds, decisions } = write;
  rec.claim = { status: "prepared", scanId, evidenceRevision, lines, claimedMinor, proofIds, decisions, preparedAt: now(), claimSignature: null, filedAt: null, chain: null, stationCapture: null };
  commit(rec, key);
  return view(rec);
}

/** Link the verified on-chain claim. No wallet signature needed: the chain is the evidence. */
async function confirmClaim(order: Order, body: Record<string, unknown>): Promise<AgreementState> {
  const signature = body.claimSignature;
  if (!isSignature(signature)) throw bad("claimSignature must be a base58 transaction signature");
  const rec = record(order.id);
  if (!rec.claim) throw conflict("Save the reviewed claim first (POST .../agreement/claim), then confirm the on-chain claim.");
  if (rec.claim.status === "filed") {
    if (rec.claim.claimSignature === signature) return view(rec);
    throw conflict("A different claim transaction is already filed for this order.");
  }

  const chain = await applyEscrowEvent(order, "claim", signature);

  const claim = rec.claim;
  if (claim.status === "filed") {
    if (claim.claimSignature === signature) return view(rec);
    throw conflict("A different claim transaction is already filed for this order.");
  }
  if (chain.claimedMinor !== claim.claimedMinor)
    throw conflict(`The claim on devnet holds ${chain.claimedMinor}, but the saved claim lists ${claim.claimedMinor}. Save the claim again with the lines that were claimed.`);
  // claim runs only on a funded escrow (nothing refunded yet) and leaves exactly claimedMinor locked.
  claim.status = "filed";
  claim.claimSignature = signature;
  claim.filedAt = now();
  claim.chain = { escrowAddress: order.escrow!.escrowAddress, heldMinor: chain.claimedMinor, releasedMinor: chain.totalMinor - chain.claimedMinor, refundedMinor: 0 };
  commit(rec, `confirm_claim:${signature}`);
  return view(rec);
}

// ---------- offers ----------

function propose(order: Order, body: Record<string, unknown>): AgreementState {
  const write: AgreementWrite = {
    action: "propose",
    as: party(body.as),
    expectedRevision: int(body.expectedRevision, "expectedRevision"),
    kind: offerKind(body.kind),
    toSupplierMinor: int(body.toSupplierMinor, "toSupplierMinor"),
    toBuyerMinor: int(body.toBuyerMinor, "toBuyerMinor"),
    replacesOfferId: body.replacesOfferId === null || body.replacesOfferId === undefined ? null : str(body.replacesOfferId, "replacesOfferId", 100),
  };
  assertSignedBy(order, write, body.walletSignature);
  const rec = record(order.id);
  const key = agreementMessage(order.id, write);
  if (!fresh(rec, key, write.expectedRevision)) return view(rec);

  const cur = rec.offers.find((o) => o.id === rec.currentOfferId);
  if (cur?.status === "accepted") throw conflict("An offer was already accepted. Sign the settlement instead.");
  assertSplit(order, rec, write.kind, write.toSupplierMinor, write.toBuyerMinor);
  const t = now();
  if (cur?.status === "open") {
    if (write.replacesOfferId !== cur.id) throw conflict(STALE);
    if (cur.proposedBy === write.as) throw conflict("You can't counter your own offer. Wait for the other side to answer.");
    Object.assign(cur, { status: "superseded", respondedBy: write.as, respondedAt: t });
  } else if (write.replacesOfferId !== null) {
    throw conflict(STALE);
  }
  const offer: AgreementOffer = {
    id: `off_${rec.offers.length + 1}_${Math.random().toString(36).slice(2, 8)}`,
    version: rec.offers.length + 1,
    proposedBy: write.as,
    kind: write.kind,
    toSupplierMinor: write.toSupplierMinor,
    toBuyerMinor: write.toBuyerMinor,
    status: "open",
    replacesOfferId: write.replacesOfferId,
    createdAt: t,
    respondedBy: null,
    respondedAt: null,
  };
  rec.offers.unshift(offer);
  rec.currentOfferId = offer.id;
  commit(rec, key);
  return view(rec);
}

function respond(order: Order, offerId: string, action: "accept" | "reject", body: Record<string, unknown>): AgreementState {
  const write: AgreementWrite = {
    action,
    as: party(body.as),
    expectedRevision: int(body.expectedRevision, "expectedRevision"),
    offerId,
    version: int(body.version, "version", 1),
    toSupplierMinor: int(body.toSupplierMinor, "toSupplierMinor"),
    toBuyerMinor: int(body.toBuyerMinor, "toBuyerMinor"),
  };
  assertSignedBy(order, write, body.walletSignature);
  const rec = record(order.id);
  const key = agreementMessage(order.id, write);
  if (!fresh(rec, key, write.expectedRevision)) return view(rec);

  const offer = rec.offers.find((o) => o.id === offerId);
  if (!offer) throw new HttpError(404, "not_found", `Offer ${offerId} not found`);
  if (offer.status !== "open" || rec.currentOfferId !== offer.id) throw conflict(`That offer is ${offer.status} and can no longer be answered.`);
  if (offer.version !== write.version || offer.toSupplierMinor !== write.toSupplierMinor || offer.toBuyerMinor !== write.toBuyerMinor)
    throw conflict("The offer you reviewed doesn't match the offer on the server. Reload and review it.");
  if (offer.proposedBy === write.as) throw conflict("You can't answer your own offer.");
  const t = now();
  if (action === "accept") {
    assertSplit(order, rec, offer.kind, offer.toSupplierMinor, offer.toBuyerMinor);
    Object.assign(offer, { status: "accepted", respondedBy: write.as, respondedAt: t });
    rec.settlement = { offerId: offer.id, status: "awaiting_signatures", signature: null, error: null, updatedAt: t, attempts: [] };
  } else {
    Object.assign(offer, { status: "rejected", respondedBy: write.as, respondedAt: t });
    rec.currentOfferId = null;
  }
  commit(rec, key);
  return view(rec);
}

// ---------- settlement ----------

type Outcome = Pick<SettlementAttempt, "status" | "error">;

/** What devnet says about one reported settle signature, checked against the accepted offer. */
async function settleOutcome(order: Order, rec: AgreementRecord, attempt: SettlementAttempt): Promise<Outcome> {
  const programId = process.env.ESCROW_PROGRAM_ID;
  const chain = rec.claim!.chain!;
  const offer = rec.offers.find((o) => o.id === rec.settlement!.offerId)!;
  const supplier = db.suppliers.find((s) => s.id === order.supplierId)!;
  if (!programId) return { status: "unknown", error: "ESCROW_PROGRAM_ID is not configured, so the transaction can't be checked." };
  try {
    const tx = await rpc<RpcTransaction | null>("getTransaction", [attempt.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    if (!tx) {
      const height = await rpc<number>("getBlockHeight", [{ commitment: "confirmed" }]);
      if (height <= attempt.lastValidBlockHeight) return { status: "submitted", error: null };
      // Past its last valid block height it can never land. Prove it didn't, and that the funds are still held.
      const seen = await rpc<{ value: unknown[] }>("getSignatureStatuses", [[attempt.signature], { searchTransactionHistory: true }]);
      if (seen.value[0]) return { status: "unknown", error: "Devnet has seen this transaction but hasn't confirmed it. Re-check shortly." };
      const esc = await readEscrow(chain.escrowAddress, programId);
      const held = esc.totalMinor - esc.releasedMinor - esc.refundedMinor;
      if (esc.status === "claimed" && held === chain.heldMinor)
        return { status: "failed", error: `Expired without landing; devnet still holds all ${held} in escrow. A fresh settlement needs both signatures again.` };
      return { status: "unknown", error: `This transaction expired without landing, but the escrow on devnet is "${esc.status}". Check the escrow before signing anything.` };
    }
    if (!tx.meta || tx.meta.err) return { status: "failed", error: "Failed on-chain. A failed transaction moves nothing." };
    const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
    const logs = tx.meta.logMessages ?? [];
    const isSettle =
      keys.includes(programId) &&
      keys.includes(chain.escrowAddress) &&
      logs.some((l) => l.startsWith(`Program ${programId} invoke`)) &&
      logs.includes("Program log: Instruction: Settle");
    if (!isSettle) return { status: "failed", error: "That transaction is not a settle of this escrow, so it isn't this settlement." };

    const esc = await readEscrow(chain.escrowAddress, programId);
    assertBelongsToOrder(esc, order, supplier.walletAddress);
    const toSupplier = esc.releasedMinor - chain.releasedMinor;
    const toBuyer = esc.refundedMinor - chain.refundedMinor;
    if (esc.status !== "settled" || toSupplier !== offer.toSupplierMinor || toBuyer !== offer.toBuyerMinor)
      return { status: "unknown", error: `Devnet shows the escrow "${esc.status}" with ${toSupplier} to supplier and ${toBuyer} to buyer, not the agreed ${offer.toSupplierMinor} / ${offer.toBuyerMinor}.` };
    await applyEscrowEvent(order, "settle", attempt.signature);
    return { status: "confirmed", error: null };
  } catch (err) {
    return { status: "unknown", error: `Couldn't verify on devnet: ${(err as Error).message}` };
  }
}

async function recordSettlement(order: Order, body: Record<string, unknown>): Promise<AgreementState> {
  const signature = body.signature;
  if (!isSignature(signature)) throw bad("signature must be a base58 transaction signature");
  const rec = record(order.id);
  const s = rec.settlement;
  if (!s) throw conflict("There is no accepted offer to settle.");
  let attempt = s.attempts.find((a) => a.signature === signature);

  if (!attempt) {
    const write: AgreementWrite = {
      action: "record_settlement",
      as: party(body.as),
      offerId: str(body.offerId, "offerId", 100),
      signature,
      lastValidBlockHeight: int(body.lastValidBlockHeight, "lastValidBlockHeight"),
    };
    assertSignedBy(order, write, body.walletSignature);
    if (write.offerId !== s.offerId) throw conflict("That isn't the accepted offer.");
    if (s.status === "confirmed") throw conflict("This settlement is already confirmed on devnet.");
    if (s.status === "submitted" || s.status === "unknown")
      throw conflict(`Settle transaction ${s.signature} was already sent and could still move funds. Re-check it; don't send another.`);
    attempt = { signature, lastValidBlockHeight: write.lastValidBlockHeight, status: "submitted", error: null, reportedBy: write.as, at: now() };
    s.attempts.push(attempt);
    Object.assign(s, { status: "submitted", signature, error: null, updatedAt: attempt.at });
    commit(rec, agreementMessage(order.id, write)); // saved before any devnet call, so the signature survives
  } else if (attempt.status === "confirmed" || attempt.status === "failed") {
    return view(rec); // final either way
  }

  const outcome = await settleOutcome(order, rec, attempt);
  if (outcome.status !== attempt.status || outcome.error !== attempt.error) {
    Object.assign(attempt, outcome);
    if (s.signature === attempt.signature) Object.assign(s, { ...outcome, updatedAt: now() });
    commit(rec, `reconcile:${signature}:${outcome.status}`);
  }
  return view(rec);
}

// ---------- routes ----------

export const agreementRouter = Router();

const route =
  (fn: (order: Order, req: Request) => AgreementState | Promise<AgreementState>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => fn(getOrder(req.params.id), req))
      .then((st) => res.json(st))
      .catch((err) => {
        if (err instanceof EscrowRouteError || err instanceof HttpError) {
          res.status(err.status).json({ error: err.message, code: err.code } satisfies ApiError);
        } else next(err);
      });
  };

const P = "/api/orders/:id/agreement";
agreementRouter.get(P, route((order) => view(record(order.id))));
agreementRouter.post(`${P}/claim`, route((order, req) => prepareClaim(order, req.body ?? {})));
agreementRouter.post(`${P}/claim/confirm`, route((order, req) => confirmClaim(order, req.body ?? {})));
agreementRouter.post(`${P}/offers`, route((order, req) => propose(order, req.body ?? {})));
agreementRouter.post(`${P}/offers/:offerId/accept`, route((order, req) => respond(order, req.params.offerId, "accept", req.body ?? {})));
agreementRouter.post(`${P}/offers/:offerId/reject`, route((order, req) => respond(order, req.params.offerId, "reject", req.body ?? {})));
agreementRouter.post(`${P}/settlement`, route((order, req) => recordSettlement(order, req.body ?? {})));
