import * as anchor from "@coral-xyz/anchor";
import {
  createAccount,
  createMint,
  getAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

// Runs under `anchor test` and unchanged in Solana Playground, which injects `pg`.
declare const pg: any;

const inPlayground = typeof pg !== "undefined";
if (!inPlayground) {
  // "confirmed", not the default "processed": public devnet RPC nodes lag, and a processed blockhash can fail preflight.
  const env = anchor.AnchorProvider.env();
  const opts = { commitment: "confirmed", preflightCommitment: "confirmed" } as const;
  anchor.setProvider(new anchor.AnchorProvider(new anchor.web3.Connection(env.connection.rpcEndpoint, "confirmed"), env.wallet, opts));
}

const program: anchor.Program = inPlayground ? pg.program : anchor.workspace.Escrow;
const provider = program.provider as anchor.AnchorProvider;
const connection = provider.connection;
const payer: Keypair = inPlayground ? pg.wallet.keypair : (provider.wallet as anchor.Wallet).payer;
const confirmed = { commitment: "confirmed" as const };
const BN = anchor.BN;

const DECIMALS = 2; // integer cents, like every *Minor field in the app
const TOTAL = 3000; // the rulebook's $30.00 demo order
const ACCEPTED = 2000;
const CLAIMED = 1000;

interface EscrowState {
  totalAmount: anchor.BN;
  releasedAmount: anchor.BN;
  claimedAmount: anchor.BN;
  refundedAmount: anchor.BN;
  status: Record<string, object>;
}

// Web Crypto: same bytes in Node and the browser (anchor.utils.sha256 differs by version).
async function sha256(text: string): Promise<Buffer> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function assertEqual(actual: unknown, expected: unknown, what: string) {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
}

async function expectFailure(action: Promise<unknown>, code: string) {
  try {
    await action;
  } catch (err) {
    const e = err as {
      message?: string;
      logs?: string[];
      transactionLogs?: string[];
      error?: { errorCode?: { code?: string } };
    };
    const detail = [e.error?.errorCode?.code, e.message, ...(e.logs ?? []), ...(e.transactionLogs ?? [])]
      .filter(Boolean)
      .join("\n");
    const reason = detail.split("\n").find((line) => line.includes(code));
    if (reason) return console.log(`      rejected as expected: ${reason.trim()}`);
    throw new Error(`expected ${code}, got:\n${detail || String(err)}`);
  }
  throw new Error(`expected ${code}, but the transaction succeeded`);
}

describe("ClearDock escrow", function () {
  this.timeout(180_000);

  const runId = Date.now().toString(36);
  const buyer = Keypair.generate();
  const supplier = Keypair.generate();
  const stranger = Keypair.generate();
  let mint: PublicKey;
  let buyerAta: PublicKey;
  let supplierAta: PublicKey;
  let strangerAta: PublicKey;

  const balance = async (tokenAccount: PublicKey) =>
    Number((await getAccount(connection, tokenAccount, "confirmed")).amount);

  const accounts = program.account as unknown as Record<string, anchor.AccountClient>;
  const fetchEscrow = async (escrow: PublicKey) =>
    (await accounts.escrow.fetch(escrow, "confirmed")) as unknown as EscrowState;

  const statusOf = (state: EscrowState) => Object.keys(state.status)[0];

  // Signatures are the evidence recorded in docs/escrow-status.md.
  const log = (what: string, signature: string) => console.log(`      tx ${what}: ${signature}`);

  // Everything a rejected transaction must leave untouched: every token balance and the escrow account.
  const snapshot = async (escrow: PublicKey, vault: PublicKey) =>
    JSON.stringify({
      vault: await balance(vault),
      buyer: await balance(buyerAta),
      supplier: await balance(supplierAta),
      stranger: await balance(strangerAta),
      escrow: await fetchEscrow(escrow),
    });

  async function expectRejected(escrow: PublicKey, vault: PublicKey, action: () => Promise<unknown>, code: string) {
    const before = await snapshot(escrow, vault);
    await expectFailure(action(), code);
    assertEqual(await snapshot(escrow, vault), before, "balances and escrow state after rejection");
  }

  const releaseAccounts = (escrow: PublicKey, vault: PublicKey, signer = buyer.publicKey, destination = supplierAta) => ({
    escrow,
    buyer: signer,
    mint,
    vault,
    supplierTokenAccount: destination,
    tokenProgram: TOKEN_PROGRAM_ID,
  });

  const settleAccounts = (escrow: PublicKey, vault: PublicKey) => ({
    escrow,
    buyer: buyer.publicKey,
    supplier: supplier.publicKey,
    mint,
    vault,
    supplierTokenAccount: supplierAta,
    buyerTokenAccount: buyerAta,
    tokenProgram: TOKEN_PROGRAM_ID,
  });

  async function fundEscrow(label: string) {
    const orderIdHash = await sha256(`PO-${runId}-${label}`);
    const termsHash = await sha256(`terms:${label}:${TOTAL}`);
    const [escrow] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), buyer.publicKey.toBuffer(), orderIdHash],
      program.programId,
    );
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), escrow.toBuffer()], program.programId);

    const signature = await program.methods
      .fund([...orderIdHash], new BN(TOTAL), [...termsHash])
      .accountsStrict({
        buyer: buyer.publicKey,
        supplier: supplier.publicKey,
        mint,
        buyerTokenAccount: buyerAta,
        escrow,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc(confirmed);
    log(`fund ${label}`, signature);

    const state = (await fetchEscrow(escrow)) as EscrowState & Record<string, unknown>;
    assertEqual(statusOf(state), "funded", "status after fund");
    assertEqual(state.totalAmount.toNumber(), TOTAL, "total_amount");
    assertEqual(String(state.buyer), buyer.publicKey.toBase58(), "stored buyer");
    assertEqual(String(state.supplier), supplier.publicKey.toBase58(), "stored supplier");
    assertEqual(await balance(vault), TOTAL, "vault after fund");
    return { escrow, vault };
  }

  const acceptAll = (escrow: PublicKey, vault: PublicKey) =>
    program.methods.acceptAll().accountsStrict(releaseAccounts(escrow, vault)).signers([buyer]);

  const claim = async (escrow: PublicKey, vault: PublicKey) =>
    log(
      "claim",
      await program.methods
        .claim(new BN(ACCEPTED), new BN(CLAIMED))
        .accountsStrict(releaseAccounts(escrow, vault))
        .signers([buyer])
        .rpc(confirmed),
    );

  before(async () => {
    // Fund the buyer from the provider wallet: devnet airdrops are rate-limited.
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: buyer.publicKey,
          lamports: LAMPORTS_PER_SOL / 10,
        }),
      ),
      [],
      confirmed,
    );
    mint = await createMint(connection, payer, payer.publicKey, null, DECIMALS, undefined, confirmed);
    buyerAta = await createAccount(connection, payer, mint, buyer.publicKey, undefined, confirmed);
    supplierAta = await createAccount(connection, payer, mint, supplier.publicKey, undefined, confirmed);
    strangerAta = await createAccount(connection, payer, mint, stranger.publicKey, undefined, confirmed);
    await mintTo(connection, payer, mint, buyerAta, payer, 20 * TOTAL, [], confirmed);
  });

  it("happy path: fund, then accept_all pays the supplier in full", async () => {
    const supplierBefore = await balance(supplierAta);
    const buyerBefore = await balance(buyerAta);
    const { escrow, vault } = await fundEscrow("happy");
    assertEqual(buyerBefore - (await balance(buyerAta)), TOTAL, "buyer paid into escrow");

    log("accept_all", await acceptAll(escrow, vault).rpc(confirmed));

    assertEqual((await balance(supplierAta)) - supplierBefore, TOTAL, "supplier received");
    assertEqual(await balance(vault), 0, "vault after release");
    const state = await fetchEscrow(escrow);
    assertEqual(statusOf(state), "released", "status");
    assertEqual(state.releasedAmount.toNumber(), TOTAL, "released_amount");
    assertEqual(state.refundedAmount.toNumber(), 0, "refunded_amount");
  });

  it("demo split: $30 order, $10 claimed, $20 paid now, settlement refunds the $10", async () => {
    const supplierBefore = await balance(supplierAta);
    const buyerBefore = await balance(buyerAta);
    const { escrow, vault } = await fundEscrow("demo-split");

    await claim(escrow, vault);
    assertEqual((await balance(supplierAta)) - supplierBefore, ACCEPTED, "supplier paid for accepted lines");
    assertEqual(await balance(vault), CLAIMED, "claimed amount still held");
    const claimed = await fetchEscrow(escrow);
    assertEqual(statusOf(claimed), "claimed", "status after claim");
    assertEqual(claimed.releasedAmount.toNumber(), ACCEPTED, "released_amount after claim");
    assertEqual(claimed.claimedAmount.toNumber(), CLAIMED, "claimed_amount after claim");

    log(
      "settle",
      await program.methods
        .settle(new BN(0), new BN(CLAIMED))
        .accountsStrict(settleAccounts(escrow, vault))
        .signers([buyer, supplier])
        .rpc(confirmed),
    );

    assertEqual(await balance(vault), 0, "vault after settlement");
    assertEqual((await balance(supplierAta)) - supplierBefore, ACCEPTED, "supplier total");
    assertEqual(buyerBefore - (await balance(buyerAta)), ACCEPTED, "buyer net cost");
    const state = await fetchEscrow(escrow);
    assertEqual(statusOf(state), "settled", "status");
    assertEqual(state.releasedAmount.toNumber(), ACCEPTED, "released_amount");
    assertEqual(state.claimedAmount.toNumber(), CLAIMED, "claimed_amount");
    assertEqual(state.refundedAmount.toNumber(), CLAIMED, "refunded_amount");
  });

  it("must fail: someone other than the buyer cannot release funds", async () => {
    const { escrow, vault } = await fundEscrow("wrong-signer");
    await expectRejected(
      escrow,
      vault,
      () =>
        program.methods
          .acceptAll()
          .accountsStrict(releaseAccounts(escrow, vault, stranger.publicKey))
          .signers([stranger])
          .rpc(confirmed),
      "Unauthorized",
    );
  });

  it("must fail: payout to an account the supplier doesn't own", async () => {
    const { escrow, vault } = await fundEscrow("changed-destination");
    await expectRejected(
      escrow,
      vault,
      () =>
        program.methods
          .acceptAll()
          .accountsStrict(releaseAccounts(escrow, vault, buyer.publicKey, strangerAta))
          .signers([buyer])
          .rpc(confirmed),
      "WrongDestination",
    );
  });

  it("must fail: a second payout from the same escrow", async () => {
    const supplierBefore = await balance(supplierAta);
    const { escrow, vault } = await fundEscrow("double-payout");
    log("accept_all (first)", await acceptAll(escrow, vault).rpc(confirmed));
    await expectRejected(
      escrow,
      vault,
      () =>
        acceptAll(escrow, vault)
          // A distinct transaction, so the RPC can't dedupe it against the first release.
          .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 })])
          .rpc(confirmed),
      "InvalidStatus",
    );
    assertEqual((await balance(supplierAta)) - supplierBefore, TOTAL, "supplier paid exactly once");
  });

  it("must fail: a settlement that doesn't add up to the held amount", async () => {
    const { escrow, vault } = await fundEscrow("bad-sum");
    await claim(escrow, vault);
    const settle = (toSupplier: number, toBuyer: number) => () =>
      program.methods
        .settle(new BN(toSupplier), new BN(toBuyer))
        .accountsStrict(settleAccounts(escrow, vault))
        .signers([buyer, supplier])
        .rpc(confirmed);
    await expectRejected(escrow, vault, settle(0, CLAIMED - 100), "AmountMismatch"); // under
    await expectRejected(escrow, vault, settle(100, CLAIMED), "AmountMismatch"); // over
  });

  it("must fail: the buyer cannot settle (refund itself) without the supplier's signature", async () => {
    const { escrow, vault } = await fundEscrow("one-signature");
    await claim(escrow, vault);
    const ix = await program.methods
      .settle(new BN(0), new BN(CLAIMED))
      .accountsStrict(settleAccounts(escrow, vault))
      .instruction();
    // Drop the supplier's signer flag so the program itself, not the client, must reject it.
    for (const meta of ix.keys) if (meta.pubkey.equals(supplier.publicKey)) meta.isSigner = false;
    await expectRejected(
      escrow,
      vault,
      () => provider.sendAndConfirm(new Transaction().add(ix), [buyer], confirmed),
      "AccountNotSigner",
    );
  });

  it("must fail: held (claimed) funds can't be released by the buyer alone", async () => {
    const { escrow, vault } = await fundEscrow("claim-then-accept");
    await claim(escrow, vault);
    await expectRejected(escrow, vault, () => acceptAll(escrow, vault).rpc(confirmed), "InvalidStatus");
  });
});
