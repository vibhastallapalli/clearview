import { PublicKey, type Connection, type ParsedAccountData, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { ApiError, Order, PaymentTransaction } from "@cleardock/shared";
import {
  ata,
  buildPaymentTx,
  DECIMALS,
  isSignature,
  isWallet,
  MEMO_PROGRAM_ID,
  verifyPayment,
  type VerifyResult,
} from "./tx.ts";

/**
 * Payment orchestration: issue the unsigned transfer, confirm a signature,
 * lock evidence while a transaction could still land.
 *
 * The server never holds buyer keys and never signs. It only issues an
 * unsigned transaction and checks what actually landed on devnet.
 */

export class HttpError extends Error {
  constructor(public status: number, public code: ApiError["code"], message: string) {
    super(message);
  }
}

/** The subset of @solana/web3.js Connection we use. Tests pass a fake. */
export type Rpc = Pick<
  Connection,
  "getLatestBlockhash" | "getBlockHeight" | "getParsedTransaction" | "getParsedAccountInfo" | "getSignaturesForAddress"
>;

/** One issued unsigned transaction. Server-internal; kept even after an approval is voided. */
export interface PaymentAttempt {
  id: string;
  orderId: string;
  paymentId: string;
  approvalId: string;
  evidenceRevision: number;
  payer: string;
  supplier: string;
  supplierAta: string;
  mint: string;
  amountMinor: number;
  memo: string;
  blockhash: string;
  lastValidBlockHeight: number;
  txBase64: string;
  issuedAt: string;
  /** issued: could still land · landed: confirmed · failed: landed with an error or mismatch · expired: can never land */
  status: "issued" | "landed" | "failed" | "expired";
  signature: string | null;
}

export interface PaymentCtx {
  rpc: Rpc;
  attempts: PaymentAttempt[];
  save: () => void;
  newId: (prefix: string) => string;
  /** Polls for a just-sent signature. Defaults: 5 tries, 2 s apart. */
  confirmTries?: number;
  confirmDelayMs?: number;
}

const COMMITMENT = "confirmed" as const;
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rpcError = (err: unknown) => new HttpError(503, "upstream_error", `Solana RPC unavailable: ${(err as Error).message}`);

// ponytail: in-process per-order lock; move to a DB row lock if we ever run more than one server.
const locks = new Map<string, Promise<unknown>>();
function withOrderLock<T>(orderId: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(orderId) ?? Promise.resolve()).then(fn);
  locks.set(orderId, run.catch(() => {}));
  return run;
}

const mintChecked = new Set<string>();
async function checkMint(rpc: Rpc, mint: string) {
  if (mintChecked.has(mint)) return;
  let info;
  try {
    info = (await rpc.getParsedAccountInfo(new PublicKey(mint), COMMITMENT)).value;
  } catch (err) {
    throw rpcError(err);
  }
  const parsed = (info?.data as ParsedAccountData | undefined)?.parsed;
  if (!info || !info.owner.equals(TOKEN_PROGRAM_ID) || parsed?.type !== "mint" || parsed.info?.decimals !== DECIMALS)
    throw new HttpError(409, "conflict", `DEMO_TOKEN_MINT ${mint} is not a classic SPL token mint with ${DECIMALS} decimals on devnet.`);
  mintChecked.add(mint);
}

async function blockHeight(rpc: Rpc) {
  try {
    return await rpc.getBlockHeight(COMMITMENT);
  } catch (err) {
    throw rpcError(err);
  }
}

function currentPayment(order: Order) {
  const { approval, payment } = order;
  if (!approval || approval.evidenceRevision !== order.evidenceRevision)
    throw new HttpError(409, "stale_approval", "No valid approval for the current evidence.");
  if (!payment || payment.approvalId !== approval.id)
    throw new HttpError(409, "conflict", "Prepare the payment first (POST /payments).");
  return payment;
}

function applyResult(order: Order, attempt: PaymentAttempt, signature: string, result: VerifyResult) {
  const payment = order.payment!;
  attempt.signature = signature;
  payment.signature = signature;
  payment.updatedAt = now();
  if (result.kind === "confirmed") {
    attempt.status = "landed";
    payment.status = "confirmed";
    payment.error = null;
    order.status = "payment_confirmed";
  } else {
    attempt.status = "failed";
    payment.status = "failed";
    payment.error = result.reason;
    order.status = "payment_failed";
  }
  order.updatedAt = now();
}

const hasMemo = (tx: ParsedTransactionWithMeta, memo: string) =>
  tx.transaction.message.instructions.some((ix) => ix.programId.equals(MEMO_PROGRAM_ID) && "parsed" in ix && ix.parsed === memo);

/**
 * Which issued attempt a landed transaction belongs to. The blockhash binds it
 * to the exact attempt. If a wallet re-blockhashed our transaction, it can
 * still bind through the per-payment memo, but only for this payment's own
 * payer, and verifyPayment still checks every transfer detail.
 */
function bindAttempt(paymentId: string, memo: string, tx: ParsedTransactionWithMeta, attempts: PaymentAttempt[]) {
  const blockhash = tx.transaction.message.recentBlockhash;
  const exact = attempts.find((a) => a.paymentId === paymentId && a.blockhash === blockhash);
  if (exact) return { attempt: exact, expected: exact };
  const feePayer = tx.transaction.message.accountKeys[0]?.pubkey.toBase58();
  const byMemo = attempts.filter((a) => a.paymentId === paymentId && a.payer === feePayer).at(-1);
  if (!byMemo || !hasMemo(tx, memo)) return null;
  console.warn(`[payments] ${paymentId}: wallet changed the blockhash; bound by memo. Expiry locks assume the issued blockhash.`);
  return { attempt: byMemo, expected: { ...byMemo, blockhash } };
}

const SCAN_PAGE = 50;
const SCAN_MAX = 500;

/**
 * An attempt past its lastValidBlockHeight can never land. That proves nothing
 * if it already landed and the browser never reported the signature. Every CDT
 * transfer out of the buyer touches the buyer's token account, and ours always
 * carries the payment memo. So we page through that account's signatures back
 * past the issue time and fetch any that carry the memo. If we can't page back
 * far enough, we throw instead of claiming it never landed.
 */
async function resolveExpired(order: Order, attempt: PaymentAttempt, ctx: PaymentCtx) {
  const since = Date.parse(attempt.issuedAt) / 1000 - 120; // clock-skew margin
  const address = new PublicKey(ata(attempt.mint, attempt.payer));
  let before: string | undefined;
  try {
    for (let scanned = 0; ; ) {
      const page = await ctx.rpc.getSignaturesForAddress(address, { limit: SCAN_PAGE, before }, COMMITMENT);
      for (const s of page) {
        if (s.blockTime != null && s.blockTime < since) return void (attempt.status = "expired");
        if (!s.memo?.includes(attempt.memo)) continue;
        const tx = await ctx.rpc.getParsedTransaction(s.signature, { commitment: COMMITMENT, maxSupportedTransactionVersion: 0 });
        if (!tx) throw new Error(`listed transaction ${s.signature} could not be fetched`);
        const bound = bindAttempt(attempt.paymentId, attempt.memo, tx, [attempt]);
        if (!bound) continue;
        if (order.payment?.id === attempt.paymentId) applyResult(order, attempt, s.signature, verifyPayment(tx, bound.expected));
        else attempt.status = "failed"; // landed against a voided payment: recorded, never auto-confirmed
        attempt.signature = s.signature;
        return;
      }
      if (page.length < SCAN_PAGE) return void (attempt.status = "expired"); // reached the account's first transaction
      scanned += page.length;
      if (scanned >= SCAN_MAX) throw new Error(`over ${SCAN_MAX} buyer transactions since issue; can't prove the old one never landed`);
      before = page.at(-1)!.signature;
    }
  } catch (err) {
    throw rpcError(err);
  }
}

/** Sweep this order's issued attempts: returns the live ones, expires or settles the rest. */
async function liveAttempts(order: Order, ctx: PaymentCtx) {
  const issued = ctx.attempts.filter((a) => a.orderId === order.id && a.status === "issued");
  if (!issued.length) return [];
  const height = await blockHeight(ctx.rpc);
  const live: PaymentAttempt[] = [];
  for (const a of issued) {
    if (height <= a.lastValidBlockHeight) live.push(a);
    else await resolveExpired(order, a, ctx);
  }
  ctx.save();
  return live;
}

/** POST /payments/transaction. Same payer + still-valid attempt → the same bytes, so only one can ever land. */
export function issueTransaction(order: Order, payer: unknown, ctx: PaymentCtx): Promise<PaymentTransaction> {
  return withOrderLock(order.id, async () => {
    const payment = currentPayment(order);
    if (!isWallet(payer)) throw new HttpError(400, "bad_request", "payer must be the buyer's wallet address.");
    if (payment.status === "confirmed") throw new HttpError(409, "conflict", "Payment already confirmed.");
    if (payment.status === "submitted" || payment.status === "unknown")
      throw new HttpError(409, "conflict", "A signed transaction was already submitted. Re-check it with POST /payments/confirm.");

    await checkMint(ctx.rpc, payment.mint);
    const live = await liveAttempts(order, ctx);
    if (order.payment?.status === "confirmed") throw new HttpError(409, "conflict", "An earlier transaction already landed; payment is confirmed.");
    const mine = live.find((a) => a.paymentId === payment.id && a.payer === payer);
    if (mine) return { transaction: mine.txBase64, lastValidBlockHeight: mine.lastValidBlockHeight };
    if (live.length)
      throw new HttpError(409, "conflict", "An earlier transaction for another wallet could still land. Wait about a minute for it to expire.");

    let latest;
    try {
      latest = await ctx.rpc.getLatestBlockhash(COMMITMENT);
    } catch (err) {
      throw rpcError(err);
    }
    const terms = {
      payer,
      supplier: payment.recipient,
      mint: payment.mint,
      amountMinor: payment.amountMinor,
      memo: payment.memo,
    };
    let txBase64: string;
    try {
      txBase64 = buildPaymentTx({ ...terms, ...latest });
    } catch (err) {
      throw new HttpError(400, "bad_request", (err as Error).message);
    }
    ctx.attempts.push({
      id: ctx.newId("att"),
      orderId: order.id,
      paymentId: payment.id,
      approvalId: payment.approvalId,
      evidenceRevision: order.evidenceRevision,
      ...terms,
      supplierAta: ata(terms.mint, terms.supplier),
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      txBase64,
      issuedAt: now(),
      status: "issued",
      signature: null,
    });
    payment.payer = payer;
    payment.lastValidBlockHeight = latest.lastValidBlockHeight;
    payment.status = "awaiting_signature";
    payment.error = null;
    payment.updatedAt = now();
    order.status = "awaiting_signature";
    order.updatedAt = now();
    ctx.save();
    return { transaction: txBase64, lastValidBlockHeight: latest.lastValidBlockHeight };
  });
}

/** POST /payments/confirm. Never marks confirmed without verifying the landed transaction. Same signature again = re-check. */
export function confirmPayment(order: Order, signature: unknown, ctx: PaymentCtx): Promise<void> {
  return withOrderLock(order.id, async () => {
    if (!isSignature(signature)) throw new HttpError(400, "bad_request", "signature must be a base58 transaction signature.");
    const payment = order.payment;
    if (!payment) throw new HttpError(409, "conflict", "No payment to confirm.");
    if (ctx.attempts.some((a) => a.signature === signature && a.paymentId !== payment.id))
      throw new HttpError(409, "conflict", "This signature was already used for a different payment.");
    if (payment.status === "confirmed") {
      if (payment.signature === signature) return;
      throw new HttpError(409, "conflict", "Payment already confirmed with a different transaction.");
    }

    const before = { status: payment.status, signature: payment.signature, orderStatus: order.status, error: payment.error };
    payment.signature = signature;
    payment.status = "submitted";
    payment.updatedAt = now();
    order.status = "payment_submitted";
    ctx.save();

    const tries = ctx.confirmTries ?? 5;
    let tx = null;
    try {
      for (let i = 0; i < tries && !tx; i++) {
        if (i) await sleep(ctx.confirmDelayMs ?? 2000);
        tx = await ctx.rpc.getParsedTransaction(signature, { commitment: COMMITMENT, maxSupportedTransactionVersion: 0 });
      }
    } catch (err) {
      payment.status = "unknown";
      payment.error = `Could not reach Solana to check the transaction: ${(err as Error).message}. Check again.`;
      ctx.save();
      return;
    }

    if (!tx) {
      let live;
      try {
        live = await liveAttempts(order, ctx);
      } catch (err) {
        payment.status = "unknown";
        payment.error = (err as Error).message;
        ctx.save();
        return;
      }
      if ((payment.status as string) === "confirmed") return; // resolveExpired found it landed
      if (live.some((a) => a.paymentId === payment.id)) {
        payment.error = "Not confirmed yet. Check again in a few seconds.";
      } else {
        payment.status = "failed";
        payment.error = "Transaction not found and its blockhash has expired, so it can never land. Sign a new one.";
        order.status = "payment_failed";
      }
      payment.updatedAt = now();
      ctx.save();
      return;
    }

    const bound = bindAttempt(payment.id, payment.memo, tx, ctx.attempts);
    if (!bound) {
      Object.assign(payment, { status: before.status, signature: before.signature, error: before.error });
      order.status = before.orderStatus;
      ctx.save();
      throw new HttpError(409, "conflict", "That transaction was not issued by ClearDock for this payment.");
    }
    const result = verifyPayment(tx, bound.expected);
    applyResult(order, bound.attempt, signature, result);
    ctx.save();
    if (result.kind === "mismatch") throw new HttpError(409, "conflict", `Transaction does not match the approved payment: ${result.reason}`);
  });
}

/**
 * Evidence may not change while a payment transaction could still land.
 * A signed transfer can't be recalled, so we wait until it provably expired
 * (about 60-90 s after issue) or it confirms. RPC errors keep the lock.
 */
export function assertEvidenceUnlocked(order: Order, ctx: PaymentCtx): Promise<void> {
  return withOrderLock(order.id, async () => {
    const locked = () => {
      const p = order.payment;
      if (p && ["submitted", "unknown", "confirmed"].includes(p.status))
        throw new HttpError(409, "conflict", `Payment is ${p.status}; evidence is locked.`);
    };
    locked();
    let live;
    try {
      live = await liveAttempts(order, ctx);
    } catch {
      throw new HttpError(409, "conflict", "Can't confirm the outstanding payment transaction expired (Solana RPC unavailable). Evidence is locked; try again.");
    }
    locked();
    if (live.length)
      throw new HttpError(409, "conflict", "A payment transaction was issued and could still land. Evidence is locked until it expires (about a minute) or confirms.");
  });
}

/** Sync guard for evidenceChanged: any attempt still marked issued blocks the change. */
export const hasIssuedAttempt = (orderId: string, attempts: PaymentAttempt[]) =>
  attempts.some((a) => a.orderId === orderId && a.status === "issued");
