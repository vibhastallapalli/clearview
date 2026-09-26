import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
  type TokenBalance,
} from "@solana/web3.js";
import type { PublicConfig } from "@cleardock/shared";

/**
 * Pure Solana pieces: config, building the unsigned CDT transfer, and checking
 * a fetched transaction against what we issued. No network calls in here.
 */

export const DECIMALS = 2;
export const TOKEN_LABEL = "CDT · ClearDock test dollars (devnet)";
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export const rpcUrl = () => process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
export const configuredMint = () => process.env.DEMO_TOKEN_MINT?.trim() || null;

export function publicConfig(): PublicConfig {
  return {
    network: "devnet",
    rpcUrl: rpcUrl(),
    mint: configuredMint(),
    decimals: DECIMALS,
    tokenLabel: TOKEN_LABEL,
    escrowProgramId: null,
  };
}

/** A wallet address: valid base58 pubkey on the ed25519 curve (so it can own an ATA and sign). */
export function isWallet(address: unknown): address is string {
  if (typeof address !== "string") return false;
  try {
    return PublicKey.isOnCurve(new PublicKey(address).toBytes());
  } catch {
    return false;
  }
}

export function isPubkey(address: unknown): address is string {
  if (typeof address !== "string") return false;
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/** Token base units. Decimals are 2, so base units == cents. */
export const isValidAmount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;

/** Transaction signatures are 64 bytes, base58 encoded (87 or 88 chars, rarely fewer). */
export const isSignature = (s: unknown): s is string =>
  typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s);

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Base58 (Bitcoin alphabet), for turning signature bytes into the usual string. */
export function base58(bytes: Uint8Array): string {
  let out = "";
  for (let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0")); n > 0n; n /= 58n) out = B58[Number(n % 58n)] + out;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out = "1" + out;
  return out;
}

export const ata = (mint: string, owner: string) =>
  getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner)).toBase58();

export interface PaymentTerms {
  payer: string;
  supplier: string;
  mint: string;
  amountMinor: number;
  memo: string;
}

/**
 * Unsigned legacy transaction, buyer is fee payer and only signer:
 * 1. create supplier ATA if missing (idempotent), 2. transferChecked, 3. memo.
 */
export function buildPaymentTx(t: PaymentTerms & { blockhash: string; lastValidBlockHeight: number }): string {
  if (!isValidAmount(t.amountMinor)) throw new Error(`Amount must be a positive whole number of cents, got ${t.amountMinor}`);
  if (!isWallet(t.payer)) throw new Error("Payer is not a valid wallet address");
  if (!isWallet(t.supplier)) throw new Error("Supplier is not a valid wallet address");
  const payer = new PublicKey(t.payer);
  const supplier = new PublicKey(t.supplier);
  const mint = new PublicKey(t.mint);
  const payerAta = getAssociatedTokenAddressSync(mint, payer);
  const supplierAta = getAssociatedTokenAddressSync(mint, supplier);

  const tx = new Transaction({ feePayer: payer, blockhash: t.blockhash, lastValidBlockHeight: t.lastValidBlockHeight }).add(
    createAssociatedTokenAccountIdempotentInstruction(payer, supplierAta, supplier, mint),
    createTransferCheckedInstruction(payerAta, mint, supplierAta, payer, BigInt(t.amountMinor), DECIMALS),
    new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(t.memo, "utf8") }),
  );
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

export type VerifyResult =
  | { kind: "confirmed" }
  | { kind: "failed"; reason: string }
  | { kind: "mismatch"; reason: string };

type Ix = ParsedInstruction | PartiallyDecodedInstruction;
const isParsed = (ix: Ix): ix is ParsedInstruction => "parsed" in ix;

/** Token-program instructions the ATA program runs internally when it creates the supplier account. */
const ATA_CREATE_INNER = new Set(["getAccountDataSize", "initializeImmutableOwner", "initializeAccount3"]);

/**
 * Check a transaction fetched at "confirmed" (jsonParsed) against the issued attempt.
 * The memo is one check among many; it never confirms a payment on its own.
 */
export function verifyPayment(
  tx: ParsedTransactionWithMeta,
  expected: PaymentTerms & { blockhash: string },
): VerifyResult {
  const bad = (reason: string): VerifyResult => ({ kind: "mismatch", reason });
  const { message } = tx.transaction;

  if (message.recentBlockhash !== expected.blockhash) return bad("Transaction was not built by ClearDock for this payment (blockhash differs).");

  const keys = message.accountKeys.map((k) => ({ key: k.pubkey.toBase58(), signer: k.signer }));
  if (keys[0]?.key !== expected.payer || !keys[0].signer) return bad("Fee payer / signer is not the buyer wallet this transaction was issued to.");

  const payerAta = ata(expected.mint, expected.payer);
  const supplierAta = ata(expected.mint, expected.supplier);
  const tokenProgram = TOKEN_PROGRAM_ID.toBase58();

  const all: Ix[] = [...message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
  const transfers: ParsedInstruction[] = [];
  for (const ix of all) {
    const program = ix.programId.toBase58();
    if (program === TOKEN_2022_PROGRAM_ID) return bad("Uses Token-2022; CDT is a classic SPL token.");
    if (program !== tokenProgram) continue;
    if (!isParsed(ix)) return bad("Unreadable token-program instruction.");
    const type = (ix.parsed as { type?: string }).type ?? "";
    if (ATA_CREATE_INNER.has(type)) continue;
    if (type !== "transferChecked") return bad(`Unexpected token instruction "${type}".`);
    transfers.push(ix);
  }
  if (transfers.length !== 1) return bad(`Expected exactly one token transfer, found ${transfers.length}.`);

  const info = (transfers[0].parsed as { info: Record<string, any> }).info;
  if (info.mint !== expected.mint) return bad(`Wrong token mint ${info.mint}.`);
  if (info.tokenAmount?.decimals !== DECIMALS) return bad(`Wrong decimals ${info.tokenAmount?.decimals}.`);
  if (info.tokenAmount?.amount !== String(expected.amountMinor))
    return bad(`Wrong amount: sent ${info.tokenAmount?.amount} base units, approved ${expected.amountMinor}.`);
  if (info.destination !== supplierAta) return bad("Destination is not the verified supplier's CDT account.");
  if (info.source !== payerAta) return bad("Source is not the buyer's CDT account.");
  if (info.authority !== expected.payer) return bad("Transfer authority is not the buyer wallet.");
  if (!keys.some((k) => k.key === info.authority && k.signer)) return bad("Transfer authority did not sign.");

  const memoOk = message.instructions.some(
    (ix) => ix.programId.equals(MEMO_PROGRAM_ID) && isParsed(ix) && ix.parsed === expected.memo,
  );
  if (!memoOk) return bad(`Memo "${expected.memo}" missing.`);

  // Anything below needs execution results.
  if (!tx.meta) return bad("Transaction has no execution metadata.");
  if (tx.meta.err) return { kind: "failed", reason: `Transaction failed on-chain: ${JSON.stringify(tx.meta.err)}` };

  const destIndex = keys.findIndex((k) => k.key === supplierAta);
  const bal = (list: TokenBalance[] | null | undefined) => list?.find((b) => b.accountIndex === destIndex);
  const post = bal(tx.meta.postTokenBalances);
  if (!post || post.mint !== expected.mint || post.owner !== expected.supplier)
    return bad("Supplier token account is not owned by the verified supplier.");
  const delta = BigInt(post.uiTokenAmount.amount) - BigInt(bal(tx.meta.preTokenBalances)?.uiTokenAmount.amount ?? "0");
  if (delta !== BigInt(expected.amountMinor)) return bad(`Supplier balance changed by ${delta}, expected ${expected.amountMinor}.`);

  return { kind: "confirmed" };
}
