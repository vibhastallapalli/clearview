import { Buffer } from "buffer";
import { Connection, PublicKey, SendTransactionError, SystemProgram, Transaction, TransactionExpiredBlockheightExceededError, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { TERMS_PATHS, type OrderDetail, type OrderTermsState } from "@cleardock/shared";
import { api, request } from "../api";
import { short } from "../format";
import * as phantom from "../wallet/phantom";
import type { ChainAction, SignRequest, Tx } from "./demo";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export const simulatedSignature = () => Array.from({ length: 88 }, () => B58[Math.floor(Math.random() * 58)]).join("");

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export interface SignHooks {
  /** Progress text for the wallet sheet. */
  status: (text: string) => void;
  /** settle only: resolves when the user says Phantom is now on the supplier account. */
  waitForSupplier: (supplier: string, note?: string) => Promise<void>;
  /**
   * Called with the fully signed transaction's signature before it is broadcast. If it throws, nothing is
   * sent (the signed bytes are dropped and expire). Used to record a settle signature with the server first.
   */
  beforeSend?: (signature: string, lastValidBlockHeight: number) => Promise<void>;
}

/**
 * The transaction may be on devnet, but this page couldn't establish its outcome ("unknown") or the chain
 * rejected it after broadcast ("failed"). Carries the signature so the UI re-checks instead of re-sending.
 */
export class SentTransactionError extends Error {
  constructor(
    message: string,
    public signature: string,
    public outcome: "unknown" | "failed",
  ) {
    super(message);
  }
}

/**
 * Off-chain steps (no `chain`) are simulated and labelled SIMULATED.
 * Chain steps build the escrow program instruction exactly like
 * solana/escrow/tests/escrow.test.ts (same seeds, Anchor discriminators, account order),
 * Phantom signs only, this page broadcasts, and the server verifies the landed
 * transaction via POST /api/orders/:id/escrow/events. Returns once the server has recorded it.
 */
export async function signAndSend(request: SignRequest, detail: OrderDetail, hooks: SignHooks): Promise<Tx> {
  if (!request.chain) {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    return { sig: simulatedSignature(), simulated: true };
  }
  const chain = request.chain;

  const config = await api.config();
  if (!config.escrowProgramId || !config.mint) throw new Error("The server has no ESCROW_PROGRAM_ID or DEMO_TOKEN_MINT configured.");
  const programId = new PublicKey(config.escrowProgramId);
  const mint = new PublicKey(config.mint);
  const connection = new Connection(config.rpcUrl, "confirmed");

  hooks.status("Connecting Phantom…");
  const signer = phantom.currentPublicKey() ?? (await phantom.connect());
  const recorded = detail.order.escrow;
  const buyer = new PublicKey(recorded?.buyer ?? signer);
  if (signer !== buyer.toBase58())
    throw new Error(`Phantom is on ${short(signer)}. Switch Phantom to the buyer account ${short(buyer.toBase58())} and try again.`);
  const supplier = new PublicKey(detail.supplier.walletAddress);

  const orderIdHash = await sha256(detail.order.reference); // the server checks this ties the escrow to the order
  const [escrow] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), buyer.toBuffer(), orderIdHash], programId);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), escrow.toBuffer()], programId);
  if (recorded && recorded.escrowAddress !== escrow.toBase58()) throw new Error("This order's recorded escrow doesn't match its buyer and reference.");

  // Funding commits money: only for order terms both parties approved, read fresh from the server (fail closed).
  const termsHash = chain.action === "fund" ? await agreedTermsHash(detail.order.id, chain.amount) : null;
  const ixs = await instructions(chain, { programId, mint, buyer, supplier, escrow, vault, orderIdHash, reference: detail.order.reference, termsHash });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  let tx = new Transaction({ feePayer: buyer, blockhash, lastValidBlockHeight }).add(...ixs);

  hooks.status(chain.action === "settle" ? "Buyer: approve the settlement in Phantom…" : "Approve the transaction in Phantom…");
  tx = await phantom.signTransaction(tx);

  if (chain.action === "settle") {
    // Both signatures go on the same transaction, so the same blockhash (valid about a minute).
    let note: string | undefined;
    for (;;) {
      await hooks.waitForSupplier(supplier.toBase58(), note);
      const now = await phantom.connect();
      if (now === supplier.toBase58()) break;
      note = `Phantom is still on ${short(now)}. Select the supplier account ${short(supplier.toBase58())} in Phantom.`;
    }
    hooks.status("Supplier: approve the same settlement in Phantom…");
    tx = await phantom.signTransaction(tx);
  }
  if (!tx.verifySignatures())
    throw new Error("Not sent: the signatures don't match the transaction (a signature is missing, or Phantom changed the transaction after the first signature).");

  // A transaction's id is its fee payer's signature, known before broadcast.
  const signature = base58(tx.signatures[0].signature!);
  if (hooks.beforeSend) {
    hooks.status("Recording the signed transaction with ClearDock before sending…");
    try {
      await hooks.beforeSend(signature, lastValidBlockHeight);
    } catch (err) {
      throw new Error(`Not sent: ${(err as Error).message}`);
    }
  }
  hooks.status("Sending to devnet…");
  try {
    await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
  } catch (err) {
    // The RPC answered with a rejection (e.g. preflight failed): it was not accepted, so nothing can land.
    if (err instanceof SendTransactionError) throw err;
    throw new SentTransactionError(`Couldn't tell whether devnet received transaction ${signature}: ${(err as Error).message}`, signature, "unknown");
  }
  hooks.status("Waiting for devnet to confirm…");
  let result;
  try {
    result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  } catch (err) {
    if (err instanceof TransactionExpiredBlockheightExceededError)
      throw new SentTransactionError(
        `Transaction ${signature} expired before devnet confirmed it. Re-check it on the order page before signing again.`,
        signature,
        "failed",
      );
    throw new SentTransactionError(`Sent ${signature}, but its confirmation couldn't be checked: ${(err as Error).message}`, signature, "unknown");
  }
  if (result.value.err)
    throw new SentTransactionError(`Transaction ${signature} failed on devnet: ${JSON.stringify(result.value.err)}`, signature, "failed");

  hooks.status("Recording on ClearDock (the server verifies it on devnet)…");
  try {
    await recordEvent(detail.order.id, chain.action, signature, escrow.toBase58());
  } catch (err) {
    throw new SentTransactionError((err as Error).message, signature, "unknown");
  }
  return { sig: signature, simulated: false };
}

/** Ask the server to (re)verify a sent escrow transaction. Same signature again = refresh (CONTRACTS.md). */
export const recheckEvent = (orderId: string, action: ChainAction["action"], signature: string, escrowAddress: string) =>
  api.escrowEvent(orderId, { action, signature, escrowAddress });

const B58_ALPHABET = B58;
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

// The server reads the transaction at "confirmed"; its RPC node can lag ours by a few seconds.
async function recordEvent(orderId: string, action: ChainAction["action"], signature: string, escrowAddress: string) {
  for (let i = 0; ; i++) {
    try {
      return await api.escrowEvent(orderId, { action, signature, escrowAddress });
    } catch (err) {
      if (i >= 5 || !/not confirmed yet/i.test((err as Error).message)) {
        throw new Error(`Landed on devnet (${signature}) but ClearDock didn't record it: ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

interface Keys {
  programId: PublicKey;
  mint: PublicKey;
  buyer: PublicKey;
  supplier: PublicKey;
  escrow: PublicKey;
  vault: PublicKey;
  orderIdHash: Buffer;
  reference: string;
  /** sha256 of the agreed order terms; set for fund only. */
  termsHash: Buffer | null;
}

// Account order = the #[derive(Accounts)] structs in solana/escrow/programs/escrow/src/lib.rs.
async function instructions(chain: ChainAction, k: Keys): Promise<TransactionInstruction[]> {
  const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
  const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });
  const buyerAta = ata(k.mint, k.buyer);
  const supplierAta = ata(k.mint, k.supplier);
  const ix = async (name: string, keys: AccountMeta[], ...args: Buffer[]) =>
    new TransactionInstruction({ programId: k.programId, keys, data: Buffer.concat([(await sha256(`global:${name}`)).subarray(0, 8), ...args]) });
  // Payouts need the supplier's token account to exist; creating it is a no-op if it does.
  const createSupplierAta = new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [w(k.buyer, true), w(supplierAta), r(k.supplier), r(k.mint), r(SystemProgram.programId), r(TOKEN_PROGRAM)],
    data: Buffer.from([1]), // CreateIdempotent
  });
  const release = [w(k.escrow), r(k.buyer, true), r(k.mint), w(k.vault), w(supplierAta), r(TOKEN_PROGRAM)];

  switch (chain.action) {
    case "fund":
      return [
        await ix(
          "fund",
          [w(k.buyer, true), r(k.supplier), r(k.mint), w(buyerAta), w(k.escrow), w(k.vault), r(TOKEN_PROGRAM), r(SystemProgram.programId)],
          k.orderIdHash,
          u64(chain.amount),
          k.termsHash!,
        ),
      ];
    case "accept_all":
      return [createSupplierAta, await ix("accept_all", release)];
    case "claim":
      return [createSupplierAta, await ix("claim", release, u64(chain.accepted), u64(chain.claimed))];
    case "settle":
      return [
        createSupplierAta,
        await ix(
          "settle",
          [w(k.escrow), r(k.buyer, true), r(k.supplier, true), r(k.mint), w(k.vault), w(supplierAta), w(buyerAta), r(TOKEN_PROGRAM)],
          u64(chain.toSupplier),
          u64(chain.toBuyer),
        ),
      ];
  }
}

const ata = (mint: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

/** The escrow's terms_hash: the current order terms, only if both parties approved them and the amount matches. */
async function agreedTermsHash(orderId: string, amount: number): Promise<Buffer> {
  const st = await request<OrderTermsState>(TERMS_PATHS.state(orderId));
  if (st.status !== "agreed" || !st.current)
    throw new Error(`Not funded: the order terms aren't agreed by both parties (${st.status}${st.outstanding.length ? `, waiting on ${st.outstanding.join(" and ")}` : ""}).`);
  if (st.current.terms.totalMinor !== amount)
    throw new Error(`Not funded: the agreed terms v${st.current.version} total ${st.current.terms.totalMinor}, not ${amount}.`);
  return Buffer.from(st.current.termsHash, "hex");
}

async function sha256(data: string): Promise<Buffer> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data)));
}

function u64(n: number): Buffer {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Bad amount ${n}`);
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
