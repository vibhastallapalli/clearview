import { Router, type NextFunction, type Request, type Response } from "express";
import {
  DEFAULT_REMEDIES,
  REMEDY_ISSUES,
  ORDER_TERMS_RULES,
  ORDER_TERMS_RULES_VERSION,
  orderTermsMessage,
  termsHashOf,
  type ApiError,
  type Order,
  type OrderTerms,
  type OrderTermsLine,
  type OrderTermsState,
  type OrderTermsVersion,
  type Party,
  type RemedySchedule,
  type TermsPreview,
} from "@cleardock/shared";
import { db, save, type OrderTermsRecord } from "./store.ts";
import { HttpError } from "./solana/payments.ts";
import { signedBy } from "./agreement.ts";
import type { DecodedEscrow } from "./escrow.ts";

// Order terms agreed BEFORE funding (CONTRACTS.md "Order terms"). Separate from the settlement agreement.
// Check-and-write steps are synchronous; the only await (hashing) happens before any state is read.

const now = () => new Date().toISOString();
const bad = (msg: string) => new HttpError(400, "bad_request", msg);
const conflict = (msg: string) => new HttpError(409, "conflict", msg);
const PARTIES: readonly Party[] = ["buyer", "supplier"];

function int(v: unknown, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw bad(`${name} must be a whole number from ${min} to ${max}`);
  return v;
}
function str(v: unknown, name: string, max = 200): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw bad(`${name} must be text of 1 to ${max} characters`);
  return v;
}
function party(v: unknown): Party {
  if (v !== "buyer" && v !== "supplier") throw bad('as must be "buyer" or "supplier"');
  return v;
}

function getOrder(orderId: string): Order {
  const order = db.orders.find((o) => o.id === orderId);
  if (!order) throw new HttpError(404, "not_found", `Order ${orderId} not found`);
  return order;
}

/** The order facts the terms must carry, from server config and the verified supplier. Never from the client. */
function facts(order: Order) {
  const supplier = db.suppliers.find((s) => s.id === order.supplierId);
  const f = {
    reference: order.reference,
    escrowProgramId: process.env.ESCROW_PROGRAM_ID?.trim() ?? "",
    mint: process.env.DEMO_TOKEN_MINT?.trim() ?? "",
    buyerWallet: process.env.DEMO_BUYER_WALLET?.trim() ?? "",
    supplierWallet: supplier?.verified ? supplier.walletAddress : "",
  };
  const missing = Object.entries(f).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw conflict(`Order terms need ${missing.join(", ")} configured (and a verified supplier).`);
  return f;
}

function staleReason(order: Order, t: OrderTerms): string | null {
  let f;
  try {
    f = facts(order);
  } catch (err) {
    return (err as Error).message;
  }
  const changed = (Object.keys(f) as (keyof typeof f)[]).filter((k) => f[k] !== t[k]);
  if (t.rulesVersion !== ORDER_TERMS_RULES_VERSION) changed.push("rules" as never);
  return changed.length ? `Changed since these terms were proposed: ${changed.join(", ")}. Propose the terms again.` : null;
}

function remedies(raw: unknown): RemedySchedule {
  if (raw === undefined || raw === null) return { ...DEFAULT_REMEDIES };
  const r = raw as Record<string, unknown>;
  return Object.fromEntries(REMEDY_ISSUES.map((i) => [i, int(r[i], `remedies.${i} (refund percent)`, 0, 100)])) as RemedySchedule;
}

function buildTerms(order: Order, rawLines: unknown, rawHours: unknown, rawRemedies: unknown): OrderTerms {
  if (!Array.isArray(rawLines) || rawLines.length < 1 || rawLines.length > 50) throw bad("lines must list 1 to 50 order lines");
  const lines: OrderTermsLine[] = rawLines.map((raw, i) => {
    const l = (raw ?? {}) as Record<string, unknown>;
    return {
      sku: l.sku === null || l.sku === undefined ? null : str(l.sku, `lines[${i}].sku`, 100),
      description: str(l.description, `lines[${i}].description`),
      quantity: int(l.quantity, `lines[${i}].quantity`, 1, 1_000_000),
      unitPriceMinor: int(l.unitPriceMinor, `lines[${i}].unitPriceMinor`, 0, 100_000_000),
    };
  });
  const totalMinor = lines.reduce((s, l) => s + l.quantity * l.unitPriceMinor, 0);
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 1) throw bad("The order total must be a positive whole number of cents.");
  return {
    rulesVersion: ORDER_TERMS_RULES_VERSION,
    orderId: order.id,
    ...facts(order),
    network: "devnet",
    lines,
    totalMinor,
    inspection: { hours: int(rawHours, "inspectionHours", 1, 720), startsAt: "first_station_scan_after_funding", enforced: false },
    remedies: remedies(rawRemedies),
    rules: [...ORDER_TERMS_RULES],
  };
}

function record(orderId: string): OrderTermsRecord {
  let rec = db.orderTerms.find((r) => r.orderId === orderId);
  if (!rec) {
    rec = { orderId, revision: 0, versions: [], funded: null, log: [] };
    db.orderTerms.push(rec);
  }
  return rec;
}

const current = (rec: OrderTermsRecord): OrderTermsVersion | null => rec.versions.at(-1) ?? null;
const approvedBy = (v: OrderTermsVersion, p: Party) => v.approvals.some((a) => a.party === p);

export function termsView(order: Order, rec: OrderTermsRecord = record(order.id)): OrderTermsState {
  const cur = current(rec);
  const stale = cur && !rec.funded ? staleReason(order, cur.terms) : null;
  const outstanding = cur ? PARTIES.filter((p) => !approvedBy(cur, p)) : [...PARTIES];
  const status: OrderTermsState["status"] = rec.funded
    ? "funded"
    : order.escrow
      ? "legacy"
      : !cur
        ? "none"
        : stale
          ? "stale"
          : outstanding.length
            ? "awaiting_approval"
            : "agreed";
  return {
    orderId: order.id,
    revision: rec.revision,
    status,
    current: cur,
    history: rec.versions.slice(0, -1).reverse(),
    outstanding: status === "funded" || status === "legacy" ? [] : outstanding,
    staleReason: stale,
    funded: rec.funded,
  };
}

function assertOpen(order: Order, rec: OrderTermsRecord) {
  if (rec.funded) throw conflict("These terms are funded and frozen. They can't be changed or re-approved.");
  if (order.escrow) throw conflict("This order's escrow was funded before order terms existed (legacy). Use a fresh order.");
}

async function preview(order: Order, body: Record<string, unknown>): Promise<TermsPreview> {
  const terms = buildTerms(order, body.lines, body.inspectionHours, body.remedies);
  const termsHash = await termsHashOf(terms);
  return { version: record(order.id).versions.length + 1, terms, termsHash };
}

async function propose(order: Order, body: Record<string, unknown>): Promise<OrderTermsState> {
  const as = party(body.as);
  const expectedRevision = int(body.expectedRevision, "expectedRevision", 0);
  const terms = buildTerms(order, body.lines, body.inspectionHours, body.remedies);
  const termsHash = await termsHashOf(terms);

  const rec = record(order.id);
  assertOpen(order, rec);
  const version = rec.versions.length + 1;
  const message = orderTermsMessage(order.id, version, termsHash, terms);
  const wallet = as === "buyer" ? terms.buyerWallet : terms.supplierWallet;
  if (!signedBy(wallet, message, body.walletSignature)) throw new HttpError(401, "unauthorized", `The proposal must be signed by the ${as} wallet ${wallet}.`);
  if (expectedRevision !== rec.revision) {
    // The same signed proposal again after it was applied: answer with the current state.
    if (rec.log.some((l) => l.revision === expectedRevision + 1 && l.key === `${as}:${message}`)) return termsView(order, rec);
    throw conflict(`The order terms changed on another device (revision ${rec.revision}, you had ${expectedRevision}). Reload and review.`);
  }
  const at = now();
  rec.versions.push({ version, terms, termsHash, proposedBy: as, proposedAt: at, approvals: [{ party: as, wallet, signature: body.walletSignature as string, at }] });
  rec.revision += 1;
  rec.log.push({ revision: rec.revision, key: `${as}:${message}` });
  save();
  return termsView(order, rec);
}

function approve(order: Order, body: Record<string, unknown>): OrderTermsState {
  const as = party(body.as);
  const version = int(body.version, "version", 1);
  const termsHash = str(body.termsHash, "termsHash", 64);
  const rec = record(order.id);
  assertOpen(order, rec);
  const cur = current(rec);
  if (!cur || cur.version !== version || cur.termsHash !== termsHash)
    throw conflict("Those aren't the current terms. A newer version was proposed; review it before approving.");
  const stale = staleReason(order, cur.terms);
  if (stale) throw conflict(stale);
  const wallet = as === "buyer" ? cur.terms.buyerWallet : cur.terms.supplierWallet;
  if (!signedBy(wallet, orderTermsMessage(order.id, version, termsHash, cur.terms), body.walletSignature))
    throw new HttpError(401, "unauthorized", `The approval must be signed by the ${as} wallet ${wallet} for version ${version}.`);
  if (approvedBy(cur, as)) return termsView(order, rec); // already approved: nothing to do
  cur.approvals.push({ party: as, wallet, signature: body.walletSignature as string, at: now() });
  rec.revision += 1;
  save();
  return termsView(order, rec);
}

// ---------- gates used by escrow event recording ----------

/**
 * Linking a funded escrow to an order: the current terms must be agreed by both parties and the chain
 * must hold exactly those terms (terms_hash, total, mint, buyer, supplier). Then the terms are frozen.
 */
export function assertFundingMatchesTerms(order: Order, chain: DecodedEscrow) {
  const view = termsView(order);
  if (view.status !== "agreed")
    throw conflict(
      view.status === "stale"
        ? `The order terms are stale: ${view.staleReason}`
        : `Funding needs order terms approved by both parties (${view.status === "none" ? "none proposed" : `waiting on ${view.outstanding.join(" and ")}`}).`,
    );
  const t = view.current!;
  const mismatch = [
    chain.termsHash !== t.termsHash && "terms hash",
    chain.totalMinor !== t.terms.totalMinor && "amount",
    chain.mint !== t.terms.mint && "token",
    chain.buyer !== t.terms.buyerWallet && "buyer",
    chain.supplier !== t.terms.supplierWallet && "supplier",
  ].filter(Boolean);
  if (mismatch.length) throw conflict(`The escrow on devnet doesn't match the agreed terms v${t.version} (${mismatch.join(", ")}). ClearDock won't link it.`);
}

/** The version an order's escrow was funded with, or null (not funded, or legacy). */
export function fundedTerms(orderId: string): OrderTermsVersion | null {
  const rec = db.orderTerms.find((r) => r.orderId === orderId);
  return rec?.funded ? (rec.versions.find((v) => v.termsHash === rec.funded!.termsHash) ?? null) : null;
}

export function markFunded(order: Order, escrowAddress: string) {
  const rec = record(order.id);
  rec.funded = { termsHash: current(rec)!.termsHash, escrowAddress, at: now() };
  rec.revision += 1;
}

/** Later escrow events (accept, claim, settle): the linked escrow must still be the one the terms were funded with. Legacy orders pass. */
export function assertEscrowMatchesFundedTerms(order: Order, chain: DecodedEscrow) {
  const rec = db.orderTerms.find((r) => r.orderId === order.id);
  if (!rec?.funded) return; // legacy: linked before order terms existed; labelled as such in GET /terms
  const t = rec.versions.find((v) => v.termsHash === rec.funded!.termsHash)!;
  if (chain.termsHash !== rec.funded.termsHash || chain.totalMinor !== t.terms.totalMinor)
    throw conflict("This escrow doesn't correspond to the order terms it was funded with.");
}

// ---------- routes ----------

export const termsRouter = Router();

const route =
  (fn: (order: Order, body: Record<string, unknown>) => unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => fn(getOrder(req.params.id), req.body ?? {}))
      .then((out) => res.json(out))
      .catch((err) => {
        if (err instanceof HttpError) res.status(err.status).json({ error: err.message, code: err.code } satisfies ApiError);
        else next(err);
      });
  };

termsRouter.get("/api/orders/:id/terms", route((order) => termsView(order)));
termsRouter.post("/api/orders/:id/terms/preview", route(preview));
termsRouter.post("/api/orders/:id/terms/propose", route(propose));
termsRouter.post("/api/orders/:id/terms/approve", route(approve));
