/**
 * Devnet setup for CDT (ClearDock test dollars): a standard SPL token with 2 decimals.
 * Devnet only. Not real money, not USDC.
 *
 * Run from server/ (or the repo root with -w server):
 *   npm run setup:devnet -- [--check] [--new-mint] [--buyer-target=1000]
 *
 *   --check              read-only: verify mint, token accounts and balances, change nothing
 *   --new-mint           create a new CDT mint (refused if one is configured or recorded)
 *   --buyer-target=N     top the buyer up to N WHOLE CDT (default 1000). Never mints above it.
 *
 * Env: SOLANA_RPC_URL, DEMO_TOKEN_MINT, DEMO_BUYER_WALLET, DEMO_SUPPLIER_WALLET (public keys),
 * DEMO_MINT_AUTHORITY_PATH (optional; default solana/.keys/cdt-mint-authority.json, gitignored).
 * The mint authority keypair is setup-only; the server's payment flow never needs it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintToChecked,
} from "@solana/spl-token";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DECIMALS = 2;
const LABEL = "CDT · ClearDock test dollars (devnet)";
const MIN_AUTHORITY_LAMPORTS = 0.05 * LAMPORTS_PER_SOL; // mint + 2 token accounts + mintTo, with margin
const MIN_BUYER_LAMPORTS = 0.01 * LAMPORTS_PER_SOL; // Phantom fees (+ supplier account rent if ever missing)
const FAUCET = "https://faucet.solana.com (choose Devnet)";

// Throw instead of process.exit(): exiting mid-request crashes libuv on Windows (exit 127).
class SetupError extends Error {}
function fail(message: string): never {
  throw new SetupError(message);
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
process.on("uncaughtException", (e) => {
  console.error(`\n✗ ${e instanceof SetupError ? e.message : `Setup stopped: ${errText(e)}`}`);
  process.exitCode = 1;
});
const cdt = (base: bigint) => `${base / 100n}.${(base % 100n).toString().padStart(2, "0")} CDT`;
const sol = (lamports: number) => `${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
const explorer = (address: PublicKey) => `https://explorer.solana.com/address/${address.toBase58()}?cluster=devnet`;

// ---- arguments ----
const args = process.argv.slice(2);
for (const a of args) {
  if (a !== "--check" && a !== "--new-mint" && !a.startsWith("--buyer-target=")) fail(`Unknown argument ${a}`);
}
const check = args.includes("--check");
const newMint = args.includes("--new-mint");
if (check && newMint) fail("--check is read-only; it cannot be combined with --new-mint.");
const targetArg = args.find((a) => a.startsWith("--buyer-target="))?.slice("--buyer-target=".length) ?? "1000";
if (!/^\d{1,9}$/.test(targetArg)) fail(`--buyer-target must be a whole number of CDT (e.g. 1000), got "${targetArg}".`);
const targetBase = BigInt(targetArg) * 10n ** BigInt(DECIMALS); // integer base units (cents)

// ---- configuration ----
function wallet(name: string): PublicKey {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is not set. Add the wallet's PUBLIC address (Phantom → devnet → copy address) to .env.`);
  let key: PublicKey;
  try {
    key = new PublicKey(value);
  } catch {
    fail(`${name} is not a valid Solana public key.`);
  }
  if (!PublicKey.isOnCurve(key.toBytes())) fail(`${name} is not a wallet address (did you paste a token account?).`);
  return key;
}

const rpcUrl = process.env.SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com";
let rpcHost: string;
try {
  rpcHost = new URL(rpcUrl).host; // print host only: a private RPC URL may carry an API key
} catch {
  fail("SOLANA_RPC_URL is not a valid URL.");
}
const buyer = wallet("DEMO_BUYER_WALLET");
const supplier = wallet("DEMO_SUPPLIER_WALLET");
if (buyer.equals(supplier)) fail("DEMO_BUYER_WALLET and DEMO_SUPPLIER_WALLET must be different wallets.");

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const authorityPath = resolve(repoRoot, process.env.DEMO_MINT_AUTHORITY_PATH?.trim() || "solana/.keys/cdt-mint-authority.json");
// Public record of the mint this key created, so a forgotten .env edit can't lead to a second mint.
const mintRecordPath = resolve(dirname(authorityPath), "cdt-mint-address.txt");
const recordedMint = existsSync(mintRecordPath) ? readFileSync(mintRecordPath, "utf8").trim() : "";

function loadAuthority(): Keypair | null {
  if (!existsSync(authorityPath)) return null;
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(authorityPath, "utf8"))));
  } catch {
    fail(`Could not read the mint authority keypair at ${authorityPath} (expected a Solana keypair JSON array).`);
  }
}

// ---- run ----
const connection = new Connection(rpcUrl, "confirmed"); // web3.js retries 429s itself (bounded)
const problems: string[] = [];
const notes: string[] = [];

let genesis: string;
try {
  genesis = await connection.getGenesisHash();
} catch (e) {
  fail(`Cannot reach RPC ${rpcHost}: ${errText(e)}`);
}
if (genesis !== DEVNET_GENESIS) fail(`SOLANA_RPC_URL (${rpcHost}) is not Solana devnet. This script only runs on devnet.`);
console.log(`✓ RPC ${rpcHost} is Solana devnet${check ? " (read-only check)" : ""}`);

let authority = loadAuthority();
if (authority && (authority.publicKey.equals(buyer) || authority.publicKey.equals(supplier))) {
  fail("The mint authority must be a separate setup key, not the buyer or supplier wallet.");
}

let funded = false;
async function ensureSetupSol(payer: Keypair) {
  if (funded) return;
  const balance = await connection.getBalance(payer.publicKey);
  if (balance < MIN_AUTHORITY_LAMPORTS) {
    console.log(`… setup key ${payer.publicKey.toBase58()} has ${sol(balance)}; requesting 1 devnet SOL (one attempt)`);
    try {
      const signature = await connection.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, "confirmed");
    } catch (e) {
      fail(
        `Devnet airdrop failed: ${errText(e)}\n` +
          `  Send at least 0.05 devnet SOL to the setup key ${payer.publicKey.toBase58()} via ${FAUCET}, then rerun.\n` +
          `  No on-chain changes were made in this run.`,
      );
    }
    console.log(`✓ airdrop confirmed, setup key now has ${sol(await connection.getBalance(payer.publicKey))}`);
  }
  funded = true;
}

// Mint: reuse the configured one, or create one only when explicitly asked and nothing is configured.
const configuredMint = process.env.DEMO_TOKEN_MINT?.trim();
let mint: PublicKey;
if (newMint) {
  if (configuredMint || recordedMint) {
    fail(
      `A CDT mint already exists (${configuredMint || `${recordedMint}, recorded in ${mintRecordPath}`}). Refusing to create a second one.\n` +
        `  To really start over, clear DEMO_TOKEN_MINT in .env, delete ${mintRecordPath}, and rerun with --new-mint.`,
    );
  }
  if (!authority) {
    authority = Keypair.generate();
    mkdirSync(dirname(authorityPath), { recursive: true });
    writeFileSync(authorityPath, JSON.stringify(Array.from(authority.secretKey)), { mode: 0o600 });
    console.log(`+ new mint authority key saved to ${authorityPath} (secret, never commit)`);
  }
  await ensureSetupSol(authority);
  mint = await createMint(connection, authority, authority.publicKey, null, DECIMALS);
  writeFileSync(mintRecordPath, `${mint.toBase58()}\n`);
  console.log(`+ created CDT mint ${mint.toBase58()} (recorded in ${mintRecordPath})`);
} else {
  if (!configuredMint && recordedMint) {
    fail(`DEMO_TOKEN_MINT is not set, but this key already created mint ${recordedMint}. Add DEMO_TOKEN_MINT=${recordedMint} to .env and rerun.`);
  }
  if (!configuredMint) fail("DEMO_TOKEN_MINT is not set. Run once with --new-mint to create the CDT mint, then add it to .env.");
  try {
    mint = new PublicKey(configuredMint);
  } catch {
    fail("DEMO_TOKEN_MINT is not a valid public key.");
  }
}

const mintAccount = await connection.getAccountInfo(mint);
if (!mintAccount) {
  fail(`DEMO_TOKEN_MINT ${mint.toBase58()} does not exist on devnet. To start over, clear it in .env and rerun with --new-mint.`);
}
if (!mintAccount.owner.equals(TOKEN_PROGRAM_ID)) {
  fail(`DEMO_TOKEN_MINT is owned by ${mintAccount.owner.toBase58()}, not the SPL Token program. CDT must be a standard SPL token.`);
}
let mintInfo: Awaited<ReturnType<typeof getMint>>;
try {
  mintInfo = await getMint(connection, mint);
} catch {
  fail(`DEMO_TOKEN_MINT ${mint.toBase58()} is not a mint account (a token account address perhaps?).`);
}
if (mintInfo.decimals !== DECIMALS) {
  fail(`DEMO_TOKEN_MINT has ${mintInfo.decimals} decimals; CDT must have ${DECIMALS}. Clear it in .env and rerun with --new-mint.`);
}
console.log(`✓ mint ${mint.toBase58()}: SPL Token program, ${DECIMALS} decimals, supply ${cdt(mintInfo.supply)}`);

const canMint = !!authority && !!mintInfo.mintAuthority?.equals(authority.publicKey);
if (!canMint) {
  notes.push(
    authority
      ? `The key at ${authorityPath} is not this mint's authority. Existing CDT still works, but top-ups are blocked.`
      : `No mint authority key at ${authorityPath}. Existing CDT still works, but top-ups and account creation are blocked here.`,
  );
}
const write = !check && !!authority;

async function tokenAccount(owner: PublicKey, label: string) {
  const address = getAssociatedTokenAddressSync(mint, owner);
  let account = await getAccount(connection, address).catch((e) => {
    if (e instanceof TokenAccountNotFoundError) return null;
    throw e;
  });
  if (!account && write) {
    await ensureSetupSol(authority!);
    account = await getOrCreateAssociatedTokenAccount(connection, authority!, mint, owner);
    console.log(`+ created ${label} CDT token account ${address.toBase58()}`);
  }
  if (!account) {
    problems.push(`${label} CDT token account ${address.toBase58()} does not exist yet.`);
    return null;
  }
  if (!account.owner.equals(owner) || !account.mint.equals(mint)) {
    problems.push(`${label} token account ${address.toBase58()} has an unexpected owner or mint.`);
  }
  return account;
}

{
  let buyerAccount = await tokenAccount(buyer, "Buyer");
  const supplierAccount = await tokenAccount(supplier, "Supplier");

  if (buyerAccount && buyerAccount.amount < targetBase) {
    const missing = targetBase - buyerAccount.amount;
    if (write && canMint) {
      await ensureSetupSol(authority!);
      const signature = await mintToChecked(connection, authority!, mint, buyerAccount.address, authority!, missing, DECIMALS);
      console.log(`+ minted ${cdt(missing)} to buyer (tx https://explorer.solana.com/tx/${signature}?cluster=devnet)`);
      buyerAccount = await getAccount(connection, buyerAccount.address);
    } else {
      notes.push(`Buyer holds ${cdt(buyerAccount.amount)}, below the ${cdt(targetBase)} target${check ? " (run without --check to top up)" : ""}.`);
    }
  }
  if (buyerAccount && buyerAccount.amount === 0n) problems.push("Buyer holds 0 CDT, so there is nothing to pay with.");

  const [buyerSol, supplierSol] = await Promise.all([connection.getBalance(buyer), connection.getBalance(supplier)]);
  if (buyerSol < MIN_BUYER_LAMPORTS) {
    problems.push(`Buyer wallet has ${sol(buyerSol)}; it needs at least 0.01 devnet SOL for fees. Fund ${buyer.toBase58()} via ${FAUCET}.`);
  }

  console.log(`\n${LABEL}`);
  console.log(`  Mint              ${mint.toBase58()}`);
  console.log(`  Mint authority    ${mintInfo.mintAuthority?.toBase58() ?? "none (fixed supply)"}${canMint ? "  (key available locally)" : ""}`);
  console.log(`  Buyer wallet      ${buyer.toBase58()}  ${sol(buyerSol)}`);
  console.log(`  Buyer CDT acct    ${buyerAccount ? `${buyerAccount.address.toBase58()}  ${cdt(buyerAccount.amount)}` : "missing"}`);
  console.log(`  Supplier wallet   ${supplier.toBase58()}  ${sol(supplierSol)}`);
  console.log(`  Supplier CDT acct ${supplierAccount ? `${supplierAccount.address.toBase58()}  ${cdt(supplierAccount.amount)}` : "missing"}`);
  console.log(`  Explorer          ${explorer(mint)}`);
}

for (const n of notes) console.log(`! ${n}`);
for (const p of problems) console.log(`✗ ${p}`);

console.log(`\n.env values (public, safe to share):`);
console.log(`DEMO_TOKEN_MINT=${mint.toBase58()}`);
console.log(`DEMO_BUYER_WALLET=${buyer.toBase58()}`);
console.log(`DEMO_SUPPLIER_WALLET=${supplier.toBase58()}`);
console.log(`(the server seeds the supplier wallet from DEMO_SUPPLIER_WALLET; after changing it, POST /api/dev/reset)`);

if (problems.length) fail(`Setup incomplete: ${problems.length} problem(s) above.`);
console.log(`\n✓ ${check ? "Check passed" : "Setup done"}: verified on devnet.`);
