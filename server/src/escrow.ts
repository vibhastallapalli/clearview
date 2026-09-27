import { createHash } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import type { ApiError, EscrowRecord, Order, OrderDetail } from "@cleardock/shared";
import { db, orderDetail, save } from "./store.ts";

export type EscrowAction = "fund" | "accept_all" | "claim" | "settle";

class EscrowRouteError extends Error {
  constructor(
    public status: number,
    public code: ApiError["code"],
    message: string,
  ) {
    super(message);
  }
}

const ACTIONS: readonly EscrowAction[] = ["fund", "accept_all", "claim", "settle"];

// Anchor logs "Program log: Instruction: <Name>" for each instruction it runs.
const INSTRUCTION_LOG: Record<EscrowAction, string> = {
  fund: "Program log: Instruction: Fund",
  accept_all: "Program log: Instruction: AcceptAll",
  claim: "Program log: Instruction: Claim",
  settle: "Program log: Instruction: Settle",
};

// On-chain status each action can leave behind (later actions may already have run).
const STATUS_AFTER: Record<EscrowAction, readonly EscrowRecord["status"][]> = {
  fund: ["funded", "claimed", "settled", "released"],
  accept_all: ["released"],
  claim: ["claimed", "settled"],
  settle: ["settled"],
};

// Variant order of `EscrowStatus` in solana/escrow/programs/escrow/src/lib.rs.
const ON_CHAIN_STATUS: readonly EscrowRecord["status"][] = ["funded", "claimed", "settled", "released"];

const ESCROW_DISCRIMINATOR = createHash("sha256").update("account:Escrow").digest().subarray(0, 8);
const ESCROW_ACCOUNT_SIZE = 8 + 32 * 4 + 32 * 2 + 8 * 4 + 1 + 1;

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const isBase58 = (value: unknown, min: number, max: number): value is string =>
  typeof value === "string" && value.length >= min && value.length <= max && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value);

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export interface DecodedEscrow {
  buyer: string;
  supplier: string;
  mint: string;
  vault: string;
  orderIdHash: Buffer;
  totalMinor: number;
  releasedMinor: number;
  claimedMinor: number;
  refundedMinor: number;
  status: EscrowRecord["status"];
}

export function decodeEscrowAccount(data: Buffer): DecodedEscrow {
  if (data.length < ESCROW_ACCOUNT_SIZE || !data.subarray(0, 8).equals(ESCROW_DISCRIMINATOR)) {
    throw new EscrowRouteError(409, "conflict", "Account is not a ClearDock escrow");
  }
  const key = (offset: number) => base58(data.subarray(offset, offset + 32));
  const amount = (offset: number) => {
    const value = data.readBigUInt64LE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new EscrowRouteError(409, "conflict", "Escrow amount too large");
    return Number(value);
  };
  const status = ON_CHAIN_STATUS[data[232]];
  if (!status) throw new EscrowRouteError(409, "conflict", "Unknown on-chain escrow status");
  return {
    buyer: key(8),
    supplier: key(40),
    mint: key(72),
    vault: key(104),
    orderIdHash: Buffer.from(data.subarray(136, 168)),
    totalMinor: amount(200),
    releasedMinor: amount(208),
    claimedMinor: amount(216),
    refundedMinor: amount(224),
    status,
  };
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const url = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  let res: globalThis.Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    });
  } catch {
    throw new EscrowRouteError(502, "upstream_error", "Can't reach the Solana RPC");
  }
  const body = (await res.json().catch(() => null)) as { result?: T; error?: { message?: string } } | null;
  if (!res.ok || !body || body.error) {
    throw new EscrowRouteError(502, "upstream_error", `Solana RPC ${method} failed: ${body?.error?.message ?? res.status}`);
  }
  return body.result as T;
}

interface RpcTransaction {
  blockTime: number | null;
  meta: {
    err: unknown;
    logMessages?: string[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
  } | null;
  transaction: { message: { accountKeys: string[] } };
}

async function verifyTransaction(signature: string, action: EscrowAction, programId: string, escrowAddress: string) {
  const tx = await rpc<RpcTransaction | null>("getTransaction", [
    signature,
    { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
  ]);
  if (!tx) throw new EscrowRouteError(409, "conflict", "Transaction not confirmed yet. Retry in a few seconds.");
  if (!tx.meta || tx.meta.err) throw new EscrowRouteError(409, "conflict", "Transaction failed on-chain; nothing moved.");

  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  const logs = tx.meta.logMessages ?? [];
  if (!keys.includes(programId) || !logs.some((line) => line.startsWith(`Program ${programId} invoke`))) {
    throw new EscrowRouteError(409, "conflict", "Transaction did not call the ClearDock escrow program");
  }
  if (!keys.includes(escrowAddress)) {
    throw new EscrowRouteError(409, "conflict", "Transaction did not touch this escrow");
  }
  if (!logs.includes(INSTRUCTION_LOG[action])) {
    throw new EscrowRouteError(409, "conflict", `Transaction did not run "${action}"`);
  }
  return new Date((tx.blockTime ?? Date.now() / 1000) * 1000).toISOString();
}

async function readEscrow(escrowAddress: string, programId: string): Promise<DecodedEscrow> {
  const info = await rpc<{ value: { data: [string, string]; owner: string } | null }>("getAccountInfo", [
    escrowAddress,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  if (!info.value) throw new EscrowRouteError(409, "conflict", "Escrow account not found on devnet");
  if (info.value.owner !== programId) throw new EscrowRouteError(409, "conflict", "Account is not owned by the escrow program");
  return decodeEscrowAccount(Buffer.from(info.value.data[0], "base64"));
}

function assertBelongsToOrder(state: DecodedEscrow, order: Order, verifiedWallet: string) {
  const expectedHash = createHash("sha256").update(order.reference).digest();
  if (!state.orderIdHash.equals(expectedHash)) {
    throw new EscrowRouteError(409, "conflict", `Escrow was funded for a different order, not ${order.reference}`);
  }
  if (state.supplier !== verifiedWallet) {
    throw new EscrowRouteError(409, "conflict", "Escrow pays a wallet that is not the verified supplier wallet");
  }
  // Fail closed: without a configured mint or buyer, any token or funder would pass.
  const mint = process.env.DEMO_TOKEN_MINT?.trim();
  if (!mint || state.mint !== mint) {
    throw new EscrowRouteError(409, "conflict", "Escrow holds a token other than the demo test token");
  }
  // Seeds are (buyer, order hash), so anyone can fund *an* escrow for this order; only the buyer's may be linked.
  const buyer = process.env.DEMO_BUYER_WALLET?.trim();
  if (!buyer || state.buyer !== buyer) {
    throw new EscrowRouteError(409, "conflict", "Escrow was funded by a wallet other than the demo buyer");
  }
}

const toOrderDetail = orderDetail;

async function recordEscrowEvent(req: Request, res: Response) {
  const programId = process.env.ESCROW_PROGRAM_ID;
  if (!programId) throw new EscrowRouteError(501, "not_implemented", "ESCROW_PROGRAM_ID is not configured");

  const order = db.orders.find((o) => o.id === req.params.id) ;
  if (!order) throw new EscrowRouteError(404, "not_found", `Order ${req.params.id} not found`);
  const supplier = db.suppliers.find((s) => s.id === order.supplierId);
  if (!supplier?.verified) throw new EscrowRouteError(409, "conflict", "Supplier wallet is not verified");

  const { action, signature } = req.body ?? {};
  const escrowAddress: unknown = req.body?.escrowAddress ?? order.escrow?.escrowAddress;
  if (!ACTIONS.includes(action)) throw new EscrowRouteError(400, "bad_request", `action must be one of ${ACTIONS.join(", ")}`);
  if (!isBase58(signature, 64, 88)) throw new EscrowRouteError(400, "bad_request", "signature must be a base58 transaction signature");
  if (!isBase58(escrowAddress, 32, 44)) throw new EscrowRouteError(400, "bad_request", "escrowAddress is required for the first event");
  if (order.escrow && order.escrow.escrowAddress !== escrowAddress) {
    throw new EscrowRouteError(409, "conflict", "This order is already linked to a different escrow");
  }

  const events = order.escrow?.events ?? [];
  const alreadyRecorded = events.some((e) => e.signature === signature);
  const at = alreadyRecorded ? null : await verifyTransaction(signature, action, programId, escrowAddress);

  const state = await readEscrow(escrowAddress, programId);
  assertBelongsToOrder(state, order, supplier.walletAddress);
  if (!STATUS_AFTER[action as EscrowAction].includes(state.status)) {
    throw new EscrowRouteError(409, "conflict", `On-chain escrow is "${state.status}", which "${action}" can't produce`);
  }

  order.escrow = {
    programId,
    escrowAddress,
    buyer: state.buyer,
    supplier: state.supplier,
    mint: state.mint,
    totalMinor: state.totalMinor,
    releasedMinor: state.releasedMinor,
    claimedMinor: state.claimedMinor,
    refundedMinor: state.refundedMinor,
    status: state.status,
    events: at ? [...events, { action, signature, at }] : events,
  };
  order.updatedAt = new Date().toISOString();
  save();
  res.json(toOrderDetail(order));
}

export const escrowRouter = Router();

escrowRouter.post("/api/orders/:id/escrow/events", (req: Request, res: Response, next: NextFunction) => {
  recordEscrowEvent(req, res).catch((err) => {
    if (err instanceof EscrowRouteError) {
      res.status(err.status).json({ error: err.message, code: err.code } satisfies ApiError);
    } else {
      next(err);
    }
  });
});
