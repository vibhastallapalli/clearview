/**
 * MOCKED-RPC tests. Every Solana call goes to a fake in this file, and the
 * transactions are hand-built in the jsonParsed shape. They prove our logic,
 * not that devnet or Phantom behave this way; that needs a live run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import type { Order } from "@cleardock/shared";
import { ata, buildPaymentTx, MEMO_PROGRAM_ID, verifyPayment } from "./tx.ts";
import {
  assertEvidenceUnlocked,
  confirmPayment,
  HttpError,
  issueTransaction,
  type PaymentAttempt,
  type PaymentCtx,
  type Rpc,
} from "./payments.ts";

const addr = () => Keypair.generate().publicKey.toBase58();
const fakeSig = () => addr() + addr(); // base58, 86-88 chars; shape is all the server checks
const AMOUNT = 3000;

function fakeRpc() {
  const s = {
    height: 1000,
    down: false,
    txs: new Map<string, any>(),
    sigsForAddress: [] as { signature: string; blockTime: number | null; memo: string | null }[],
    blockhashes: 0,
  };
  const guard = () => {
    if (s.down) throw new Error("fetch failed");
  };
  const rpc = {
    async getLatestBlockhash() {
      guard();
      s.blockhashes++;
      return { blockhash: addr(), lastValidBlockHeight: s.height + 150 };
    },
    async getBlockHeight() {
      guard();
      return s.height;
    },
    async getParsedTransaction(sig: string) {
      guard();
      return s.txs.get(sig) ?? null;
    },
    async getParsedAccountInfo() {
      guard();
      return { context: { slot: 1 }, value: { owner: TOKEN_PROGRAM_ID, data: { program: "spl-token", space: 82, parsed: { type: "mint", info: { decimals: 2 } } } } };
    },
    async getSignaturesForAddress(_a: unknown, opts: { limit: number; before?: string }) {
      guard();
      const start = opts.before ? s.sigsForAddress.findIndex((x) => x.signature === opts.before) + 1 : 0;
      return s.sigsForAddress.slice(start, start + opts.limit);
    },
  };
  return { s, rpc: rpc as unknown as Rpc };
}

let seq = 0;
function setup() {
  const payer = addr();
  const supplier = addr();
  const mint = addr();
  const { s, rpc } = fakeRpc();
  const attempts: PaymentAttempt[] = [];
  const ctx: PaymentCtx = { rpc, attempts, save: () => {}, newId: (p) => `${p}_${++seq}`, confirmTries: 1, confirmDelayMs: 0 };
  const order = makeOrder(supplier, mint);
  return { payer, supplier, mint, s, ctx, attempts, order };
}

function makeOrder(supplier: string, mint: string): Order {
  const n = ++seq;
  const t = new Date().toISOString();
  return {
    id: `ord_${n}`,
    reference: `PO-${n}`,
    supplierId: "sup",
    currency: "USD",
    status: "awaiting_signature",
    evidenceRevision: 2,
    documentIds: [],
    latestCaptureId: null,
    latestScanId: null,
    comparison: null,
    approval: { id: `apr_${n}`, orderId: `ord_${n}`, evidenceRevision: 2, recipient: supplier, amountMinor: AMOUNT, approvedAt: t },
    payment: {
      id: `pay_${n}`,
      orderId: `ord_${n}`,
      approvalId: `apr_${n}`,
      network: "devnet",
      recipient: supplier,
      amountMinor: AMOUNT,
      mint,
      payer: null,
      lastValidBlockHeight: null,
      memo: `ClearDock PO-${n} pay_${n}`,
      idempotencyKey: `ord_${n}:apr_${n}`,
      status: "awaiting_signature",
      signature: null,
      error: null,
      updatedAt: t,
    },
    escrow: null,
    createdAt: t,
    updatedAt: t,
  };
}

/** A landed transaction in getParsedTransaction(jsonParsed) shape, matching `a` unless `edit` changes it. */
function landed(a: PaymentAttempt, edit: (tx: any) => void = () => {}) {
  const payerAta = ata(a.mint, a.payer);
  const keyList = [a.payer, payerAta, a.supplierAta, a.supplier, a.mint, TOKEN_PROGRAM_ID.toBase58(), MEMO_PROGRAM_ID.toBase58()];
  const tokenIx = (type: string, info: object) => ({ programId: TOKEN_PROGRAM_ID, program: "spl-token", parsed: { type, info } });
  const tx: any = {
    slot: 1,
    blockTime: Math.floor(Date.now() / 1000),
    transaction: {
      signatures: [fakeSig()],
      message: {
        recentBlockhash: a.blockhash,
        accountKeys: keyList.map((k, i) => ({ pubkey: new PublicKey(k), signer: i === 0, writable: i < 3, source: "transaction" })),
        instructions: [
          { programId: ASSOCIATED_TOKEN_PROGRAM_ID, program: "spl-associated-token-account", parsed: { type: "createIdempotent", info: {} } },
          tokenIx("transferChecked", {
            source: payerAta,
            mint: a.mint,
            destination: a.supplierAta,
            authority: a.payer,
            tokenAmount: { amount: String(a.amountMinor), decimals: 2, uiAmount: a.amountMinor / 100, uiAmountString: "" },
          }),
          { programId: MEMO_PROGRAM_ID, program: "spl-memo", parsed: a.memo },
        ],
      },
    },
    meta: {
      err: null,
      fee: 5000,
      innerInstructions: [{ index: 0, instructions: [tokenIx("getAccountDataSize", {}), tokenIx("initializeImmutableOwner", {}), tokenIx("initializeAccount3", {})] }],
      preTokenBalances: [{ accountIndex: 1, mint: a.mint, owner: a.payer, uiTokenAmount: { amount: "100000", decimals: 2 } }],
      postTokenBalances: [
        { accountIndex: 1, mint: a.mint, owner: a.payer, uiTokenAmount: { amount: String(100000 - a.amountMinor), decimals: 2 } },
        { accountIndex: 2, mint: a.mint, owner: a.supplier, uiTokenAmount: { amount: String(a.amountMinor), decimals: 2 } },
      ],
    },
  };
  edit(tx);
  return tx;
}

const transferInfo = (tx: any) => tx.transaction.message.instructions[1].parsed.info;
const rejects = (p: Promise<unknown>, status: number, code?: string) =>
  assert.rejects(p, (e: unknown) => e instanceof HttpError && e.status === status && (!code || e.code === code));

// ---------- building ----------

test("issued transaction: buyer is fee payer, unsigned, ATA-create + transferChecked + memo", async () => {
  const { payer, order, ctx, attempts } = setup();
  const { transaction } = await issueTransaction(order, payer, ctx);
  const tx = Transaction.from(Buffer.from(transaction, "base64"));
  assert.equal(tx.feePayer?.toBase58(), payer);
  assert.ok(tx.signatures.every((s) => s.signature === null), "server must not sign");
  assert.deepEqual(
    tx.instructions.map((i) => i.programId.toBase58()),
    [ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, MEMO_PROGRAM_ID].map((p) => p.toBase58()),
  );
  assert.equal(tx.instructions[2].data.toString("utf8"), order.payment!.memo);
  assert.equal(attempts.length, 1);
  assert.equal(order.payment!.payer, payer);
});

test("amounts must be positive safe integers", () => {
  const base = { payer: addr(), supplier: addr(), mint: addr(), memo: "m", blockhash: addr(), lastValidBlockHeight: 1 };
  for (const amountMinor of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])
    assert.throws(() => buildPaymentTx({ ...base, amountMinor }));
  assert.ok(buildPaymentTx({ ...base, amountMinor: 1 }));
});

// ---------- issuing ----------

test("stale approval is refused", async () => {
  const { payer, order, ctx } = setup();
  order.evidenceRevision = 3;
  await rejects(issueTransaction(order, payer, ctx), 409, "stale_approval");
});

test("invalid payer is refused", async () => {
  const { order, ctx } = setup();
  await rejects(issueTransaction(order, "not-a-wallet", ctx), 400);
});

test("5 concurrent requests from the same wallet get one attempt and identical bytes", async () => {
  const { payer, order, ctx, attempts, s } = setup();
  const results = await Promise.all(Array.from({ length: 5 }, () => issueTransaction(order, payer, ctx)));
  assert.equal(attempts.length, 1);
  assert.equal(s.blockhashes, 1);
  assert.equal(new Set(results.map((r) => r.transaction)).size, 1);
});

test("a different wallet cannot get a second payable transaction while the first could land", async () => {
  const { payer, order, ctx } = setup();
  await issueTransaction(order, payer, ctx);
  await rejects(issueTransaction(order, addr(), ctx), 409);
});

test("wrong mint decimals are refused before issuing", async () => {
  const { payer, order, ctx } = setup();
  (ctx.rpc as any).getParsedAccountInfo = async () => ({ value: { owner: TOKEN_PROGRAM_ID, data: { parsed: { type: "mint", info: { decimals: 6 } } } } });
  await rejects(issueTransaction(order, payer, ctx), 409);
});

// ---------- verification ----------

test("a correct transfer verifies", async () => {
  const { payer, order, ctx, attempts } = setup();
  await issueTransaction(order, payer, ctx);
  assert.deepEqual(verifyPayment(landed(attempts[0]), attempts[0]), { kind: "confirmed" });
});

test("wrong details are mismatches, never confirmations", async () => {
  const { payer, order, ctx, attempts } = setup();
  await issueTransaction(order, payer, ctx);
  const a = attempts[0];
  const other = addr();
  const cases: Record<string, (tx: any) => void> = {
    "wrong amount": (tx) => (transferInfo(tx).tokenAmount.amount = "2999"),
    "wrong mint": (tx) => (transferInfo(tx).mint = other),
    "wrong decimals": (tx) => (transferInfo(tx).tokenAmount.decimals = 6),
    "wrong destination": (tx) => (transferInfo(tx).destination = ata(a.mint, other)),
    "wrong authority": (tx) => (transferInfo(tx).authority = other),
    "wrong blockhash": (tx) => (tx.transaction.message.recentBlockhash = addr()),
    "buyer did not sign": (tx) => (tx.transaction.message.accountKeys[0].signer = false),
    "memo missing": (tx) => tx.transaction.message.instructions.pop(),
    "memo for another order": (tx) => (tx.transaction.message.instructions[2].parsed = "ClearDock PO-9999 pay_x"),
    "memo only, no transfer": (tx) => tx.transaction.message.instructions.splice(1, 1),
    "extra inner transfer": (tx) =>
      tx.meta.innerInstructions[0].instructions.push({ programId: TOKEN_PROGRAM_ID, program: "spl-token", parsed: { type: "transfer", info: {} } }),
    "supplier account owned by someone else": (tx) => (tx.meta.postTokenBalances[1].owner = other),
    "balance delta differs": (tx) => (tx.meta.preTokenBalances.push({ accountIndex: 2, mint: a.mint, owner: a.supplier, uiTokenAmount: { amount: "1" } })),
  };
  for (const [name, edit] of Object.entries(cases))
    assert.equal(verifyPayment(landed(a, edit), a).kind, "mismatch", name);
  assert.equal(verifyPayment(landed(a, (tx) => (tx.meta.err = { InstructionError: [1, "Custom"] })), a).kind, "failed");
});

// ---------- confirming ----------

test("confirm: verified transfer confirms; same signature again is a no-op re-check", async () => {
  const { payer, order, ctx, attempts, s } = setup();
  await issueTransaction(order, payer, ctx);
  const sig = fakeSig();
  s.txs.set(sig, landed(attempts[0]));
  await confirmPayment(order, sig, ctx);
  assert.equal(order.payment!.status, "confirmed");
  assert.equal(order.status, "payment_confirmed");
  assert.equal(order.payment!.signature, sig);
  await confirmPayment(order, sig, ctx);
  await rejects(confirmPayment(order, fakeSig(), ctx), 409);
  await rejects(issueTransaction(order, payer, ctx), 409);
});

test("confirm: missing or malformed signature is a 400", async () => {
  const { order, ctx } = setup();
  await rejects(confirmPayment(order, undefined, ctx), 400);
  await rejects(confirmPayment(order, "0OIl", ctx), 400);
});

test("confirm: wrong amount on-chain is rejected and never confirmed", async () => {
  const { payer, order, ctx, attempts, s } = setup();
  await issueTransaction(order, payer, ctx);
  const sig = fakeSig();
  s.txs.set(sig, landed(attempts[0], (tx) => (transferInfo(tx).tokenAmount.amount = "1")));
  await rejects(confirmPayment(order, sig, ctx), 409);
  assert.equal(order.payment!.status, "failed");
  assert.notEqual(order.status, "payment_confirmed");
});

test("confirm: a transaction ClearDock never issued is rejected and state is restored", async () => {
  const { payer, order, ctx, attempts, s } = setup();
  await issueTransaction(order, payer, ctx);
  const sig = fakeSig();
  s.txs.set(sig, landed(attempts[0], (tx) => {
    tx.transaction.message.recentBlockhash = addr();
    tx.transaction.message.instructions[2].parsed = "ClearDock PO-9999 pay_other";
  }));
  await rejects(confirmPayment(order, sig, ctx), 409);
  assert.equal(order.payment!.status, "awaiting_signature");
  assert.equal(order.payment!.signature, null);
});

test("confirm: a signature already used by another order is refused", async () => {
  const one = setup();
  await issueTransaction(one.order, one.payer, one.ctx);
  const sig = fakeSig();
  one.s.txs.set(sig, landed(one.attempts[0]));
  await confirmPayment(one.order, sig, one.ctx);

  const two = makeOrder(one.supplier, one.mint);
  await issueTransaction(two, one.payer, one.ctx);
  await rejects(confirmPayment(two, sig, one.ctx), 409);
  assert.notEqual(two.payment!.status, "confirmed");
});

test("confirm: not found yet stays submitted; after expiry it fails and a new transaction can be issued", async () => {
  const { payer, order, ctx, attempts, s } = setup();
  const first = await issueTransaction(order, payer, ctx);
  const sig = fakeSig();
  await confirmPayment(order, sig, ctx);
  assert.equal(order.payment!.status, "submitted");
  await rejects(issueTransaction(order, payer, ctx), 409);

  s.height += 151; // past lastValidBlockHeight
  await confirmPayment(order, sig, ctx);
  assert.equal(order.payment!.status, "failed");
  assert.equal(attempts[0].status, "expired");

  const second = await issueTransaction(order, payer, ctx);
  assert.notEqual(second.transaction, first.transaction);
  assert.equal(attempts.length, 2);
});

test("expired attempt that actually landed is found and confirmed instead of issuing a duplicate", async () => {
  const { payer, order, ctx, attempts, s } = setup();
  await issueTransaction(order, payer, ctx);
  const sig = fakeSig();
  s.txs.set(sig, landed(attempts[0]));
  s.sigsForAddress = [{ signature: sig, blockTime: Math.floor(Date.now() / 1000), memo: `[20] ${attempts[0].memo}` }];
  s.height += 151;
  await rejects(issueTransaction(order, payer, ctx), 409);
  assert.equal(order.payment!.status, "confirmed");
  assert.equal(attempts.length, 1);
});

test("RPC failure while confirming → unknown, and no new transaction is issued", async () => {
  const { payer, order, ctx, s } = setup();
  await issueTransaction(order, payer, ctx);
  s.down = true;
  await confirmPayment(order, fakeSig(), ctx);
  assert.equal(order.payment!.status, "unknown");
  s.down = false;
  await rejects(issueTransaction(order, payer, ctx), 409);
});

// ---------- evidence lock ----------

test("evidence is locked while an issued transaction could land, unlocked once it provably expired", async () => {
  const { payer, order, ctx, attempts, s } = setup();
  await assertEvidenceUnlocked(order, ctx); // nothing issued yet
  await issueTransaction(order, payer, ctx);
  await rejects(assertEvidenceUnlocked(order, ctx), 409);
  s.height += 151;
  s.down = true;
  await rejects(assertEvidenceUnlocked(order, ctx), 409); // can't prove expiry → stay locked
  s.down = false;
  await assertEvidenceUnlocked(order, ctx);
  assert.equal(attempts[0].status, "expired");
});

// ---------- recovery when the browser never reported the signature ----------

const noise = (n: number) =>
  Array.from({ length: n }, () => ({ signature: fakeSig(), blockTime: Math.floor(Date.now() / 1000), memo: null }));

test("recovery pages past unrelated buyer transactions to find the landed one", async () => {
  const { payer, order, ctx, attempts, s } = setup();
  await issueTransaction(order, payer, ctx);
  const sig = fakeSig();
  s.txs.set(sig, landed(attempts[0]));
  s.sigsForAddress = [...noise(70), { signature: sig, blockTime: Math.floor(Date.now() / 1000), memo: `[1] ${attempts[0].memo}` }];
  s.height += 151;
  await rejects(issueTransaction(order, payer, ctx), 409);
  assert.equal(order.payment!.status, "confirmed");
});

test("recovery refuses to declare expiry when it can't scan back to the issue time", async () => {
  const { payer, order, ctx, attempts, s } = setup();
  await issueTransaction(order, payer, ctx);
  s.sigsForAddress = noise(600);
  s.height += 151;
  await rejects(issueTransaction(order, payer, ctx), 503);
  await rejects(assertEvidenceUnlocked(order, ctx), 409);
  assert.equal(attempts[0].status, "issued");
  assert.equal(attempts.length, 1);
});

test("recovery stops at transactions older than the attempt", async () => {
  const { payer, order, ctx, attempts, s } = setup();
  await issueTransaction(order, payer, ctx);
  s.sigsForAddress = [...noise(3), ...noise(100).map((x) => ({ ...x, blockTime: 1 }))];
  s.height += 151;
  await issueTransaction(order, payer, ctx);
  assert.equal(attempts[0].status, "expired");
  assert.equal(attempts.length, 2);
});

test("a wallet-reblockhashed transaction binds by payment memo + payer and is still fully verified", async () => {
  const { payer, order, ctx, attempts, s } = setup();
  await issueTransaction(order, payer, ctx);
  const good = fakeSig();
  s.txs.set(good, landed(attempts[0], (tx) => (tx.transaction.message.recentBlockhash = addr())));
  await confirmPayment(order, good, ctx);
  assert.equal(order.payment!.status, "confirmed");

  const two = setup();
  await issueTransaction(two.order, two.payer, two.ctx);
  const bad = fakeSig();
  two.s.txs.set(bad, landed(two.attempts[0], (tx) => {
    tx.transaction.message.recentBlockhash = addr();
    transferInfo(tx).tokenAmount.amount = "1";
  }));
  await rejects(confirmPayment(two.order, bad, two.ctx), 409);
  assert.notEqual(two.order.payment!.status, "confirmed");
});
