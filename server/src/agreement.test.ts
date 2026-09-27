/**
 * Agreement API (CONTRACTS.md "Agreement"), black-box.
 *
 * Starts the real server as a child process on a temp CLEARDOCK_DATA_DIR seeded with a funded escrow,
 * pointed at an in-process fake Solana RPC (SOLANA_RPC_URL). Buyer and supplier are real ed25519 keys
 * signing agreementMessage(), like Phantom's signMessage. No hardware, Gemini or devnet involved.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { agreementMessage, type AgreementState, type AgreementWrite, type ClaimLine } from "@cleardock/shared";

type ClaimWrite = Extract<AgreementWrite, { action: "prepare_claim" }>;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

// ---------- identities and chain fixtures ----------

function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  return { key: privateKey, address: new PublicKey(raw).toBase58(), pk: new PublicKey(raw) };
}
const buyer = wallet();
const supplier = wallet();
const intruder = wallet();
const randomKey = () => new PublicKey(randomBytes(32));
const PROGRAM = randomKey().toBase58();
const ESCROW = randomKey().toBase58();
const MINT = randomKey();
const VAULT = randomKey();
const OID = "ord_1001";
const REF = "PO-1001";
const txSig = () => randomKey().toBase58() + randomKey().toBase58();

const STATUS = { funded: 0, claimed: 1, settled: 2, released: 3 };
const chain = {
  escrow: { total: 1000, released: 0, claimed: 0, refunded: 0, status: STATUS.funded },
  txs: new Map<string, unknown>(),
  rpcDown: new Set<string>(),
  seen: new Set<string>(),
  height: 0,
};

function escrowData() {
  const e = chain.escrow;
  const b = Buffer.alloc(234);
  createHash("sha256").update("account:Escrow").digest().copy(b, 0, 0, 8);
  [buyer.pk, supplier.pk, MINT, VAULT].forEach((k, i) => k.toBuffer().copy(b, 8 + 32 * i));
  createHash("sha256").update(REF).digest().copy(b, 136);
  [e.total, e.released, e.claimed, e.refunded].forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 200 + 8 * i));
  b[232] = e.status;
  return b;
}

const tx = (instruction: string, opts: { err?: unknown; escrow?: string } = {}) => ({
  blockTime: 1_800_000_000,
  meta: { err: opts.err ?? null, logMessages: [`Program ${PROGRAM} invoke [1]`, `Program log: Instruction: ${instruction}`] },
  transaction: { message: { accountKeys: [buyer.address, supplier.address, opts.escrow ?? ESCROW, PROGRAM] } },
});

let rpcServer: ReturnType<typeof createHttpServer> | undefined;
after(() => rpcServer?.close());

function startRpc(): Promise<string> {
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body);
      const reply = (result: unknown) => res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      if (method === "getTransaction") {
        if (chain.rpcDown.has(params[0])) return res.writeHead(503).end("down");
        return reply(chain.txs.get(params[0]) ?? null);
      }
      if (method === "getBlockHeight") return reply(chain.height);
      if (method === "getSignatureStatuses") return reply({ value: [chain.seen.has(params[0][0]) ? { confirmations: 0 } : null] });
      if (method === "getAccountInfo") return reply({ value: { data: [escrowData().toString("base64"), "base64"], owner: PROGRAM } });
      res.writeHead(400).end();
    });
  });
  rpcServer = server;
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

// ---------- server harness ----------

const running = new Set<ChildProcess>();
after(() => running.forEach((c) => c.kill()));

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

function seedDb(dataDir: string) {
  const sup = { ...JSON.parse(readFileSync(join(REPO, "shared", "fixtures", "supplier.json"), "utf8")), walletAddress: supplier.address, verified: true };
  const t = new Date().toISOString();
  const order = {
    id: OID, reference: REF, supplierId: sup.id, currency: "USD", status: "discrepancy", evidenceRevision: 3, documentIds: [],
    latestCaptureId: "cap_2", latestScanId: "scan_new", comparison: null, approval: null, payment: null, createdAt: t, updatedAt: t,
    escrow: {
      programId: PROGRAM, escrowAddress: ESCROW, buyer: buyer.address, supplier: supplier.address, mint: MINT.toBase58(),
      totalMinor: 1000, releasedMinor: 0, claimedMinor: 0, refundedMinor: 0, status: "funded", events: [],
    },
  };
  const scan = (id: string) => ({ id, orderId: OID, captureId: "cap_1", observed: [], unreadable: [], notes: "fixture", analyzedBy: "mock", analyzedAt: t });
  const proof = { id: "prf_1", orderId: OID, captureId: "cap_p", imageSha256: "0", kind: "live", stationScanId: "scan_old", stationCaptureId: "cap_1", evidenceRevision: 2, createdAt: t };
  writeFileSync(join(dataDir, "db.json"), JSON.stringify({
    suppliers: [sup], orders: [order], documents: [], sessions: [], captures: [], scans: [scan("scan_old"), scan("scan_new")],
    proofs: [proof], paymentAttempts: [], archivedOrders: [], agreements: [],
  }));
}

let rpcUrl = "";
const dataDir = mkdtempSync(join(tmpdir(), "cleardock-agreement-"));

async function startServer() {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env, PORT: String(port), CLEARDOCK_DATA_DIR: dataDir, GEMINI_API_KEY: "", SOLANA_RPC_URL: rpcUrl,
    ESCROW_PROGRAM_ID: PROGRAM, DEMO_TOKEN_MINT: MINT.toBase58(), DEMO_BUYER_WALLET: buyer.address, DEMO_SUPPLIER_WALLET: supplier.address,
  };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--no-warnings", "--import", "tsx", join(HERE, "index.ts")], { cwd: join(HERE, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
  running.add(child);
  let log = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 30_000);
    const onData = (b: Buffer) => {
      log += b.toString();
      if (log.includes("ClearDock server on")) (clearTimeout(timer), resolve());
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
  });
  return {
    base: `http://localhost:${port}`,
    stop: () => new Promise<void>((r) => (child.once("exit", () => r()), child.kill(), running.delete(child))),
  };
}

let server: Awaited<ReturnType<typeof startServer>>;

async function call(method: string, path: string, body?: object) {
  const r = await fetch(server.base + `/api/orders/${OID}/agreement` + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body && JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as AgreementState & { code?: string; error?: string } };
}

const signed = <W extends AgreementWrite>(w: W, key: KeyObject) => ({ ...w, walletSignature: sign(null, Buffer.from(agreementMessage(OID, w)), key).toString("base64") });
const get = async () => (await call("GET", "")).body;

const claimWrite = (expectedRevision: number, lines: ClaimLine[] = [{ sku: "SKU-A", description: "Cola 12oz", claimedMinor: 250, reason: "missing" as const }, { sku: null, description: "Lime 12oz", claimedMinor: 150, reason: "damaged" as const }]): ClaimWrite => ({
  action: "prepare_claim", as: "buyer", expectedRevision, scanId: "scan_old", evidenceRevision: 2, lines,
  claimedMinor: lines.reduce((s, l) => s + l.claimedMinor, 0), proofIds: ["prf_1"],
  // The scan saw one Cola (accepted as suggested) and the Lime; the buyer overrides it to claim the damaged Lime.
  decisions: [
    { description: "Cola 12oz · unit 2", priceMinor: 250, suggested: "accept", decided: "accept", overrideReason: null },
    ...lines.map((l) =>
      l.reason === "damaged"
        ? { description: l.description, priceMinor: l.claimedMinor, suggested: "accept" as const, decided: "claim" as const, overrideReason: "Can crushed; the scan can't see damage" }
        : { description: l.description, priceMinor: l.claimedMinor, suggested: "claim" as const, decided: "claim" as const, overrideReason: null },
    ),
  ],
});
const offer = (as: "buyer" | "supplier", expectedRevision: number, kind: "full_refund" | "full_release" | "split", toSupplierMinor: number, toBuyerMinor: number, replacesOfferId: string | null = null): AgreementWrite =>
  ({ action: "propose", as, expectedRevision, kind, toSupplierMinor, toBuyerMinor, replacesOfferId });
const answer = (action: "accept" | "reject", as: "buyer" | "supplier", st: AgreementState, offerId = st.currentOfferId!): AgreementWrite => {
  const o = st.offers.find((x) => x.id === offerId)!;
  return { action, as, expectedRevision: st.revision, offerId, version: o.version, toSupplierMinor: o.toSupplierMinor, toBuyerMinor: o.toBuyerMinor };
};
const settle = (as: "buyer" | "supplier", st: AgreementState, signature: string, lastValidBlockHeight: number): AgreementWrite =>
  ({ action: "record_settlement", as, offerId: st.settlement!.offerId, signature, lastValidBlockHeight });
const postAnswer = (w: AgreementWrite, key: KeyObject) => call("POST", `/offers/${(w as { offerId: string }).offerId}/${w.action}`, signed(w, key));

// ---------- the flow ----------

before(async () => {
  rpcUrl = await startRpc();
  seedDb(dataDir);
  server = await startServer();
});

describe("agreement", () => {
  test("empty agreement for a new order; unknown order is 404", async () => {
    assert.deepEqual(await get(), { orderId: OID, revision: 0, claim: null, offers: [], currentOfferId: null, nextActor: null, settlement: null });
    assert.equal((await fetch(server.base + "/api/orders/nope/agreement")).status, 404);
  });

  test("claim writes need the buyer's wallet signature", async () => {
    assert.equal((await call("POST", "/claim", signed(claimWrite(0), supplier.key))).status, 401);
    assert.equal((await call("POST", "/claim", signed(claimWrite(0), intruder.key))).status, 401);
    assert.equal((await call("POST", "/claim", { ...claimWrite(0), walletSignature: "" })).status, 401);
    // A valid signature over different content doesn't carry over.
    const s = signed(claimWrite(0), buyer.key);
    assert.equal((await call("POST", "/claim", { ...s, claimedMinor: 1, lines: [{ ...s.lines[0], claimedMinor: 1 }] })).status, 401);
  });

  test("invalid claim amounts, scans and proofs are refused", async () => {
    const bad = (w: ClaimWrite) => call("POST", "/claim", signed(w, buyer.key)).then((r) => r.status);
    const one = (claimedMinor: number) => [{ sku: null, description: "x", claimedMinor, reason: "missing" as const }];
    assert.equal(await bad({ ...claimWrite(0), claimedMinor: 399 }), 400); // lines don't add up
    assert.equal(await bad(claimWrite(0, one(12.5))), 400);
    assert.equal(await bad(claimWrite(0, one(-5))), 400);
    assert.equal(await bad(claimWrite(0, one(1001))), 409); // more than the escrow holds
    assert.equal(await bad({ ...claimWrite(0), scanId: "scan_other_order" }), 400);
    assert.equal(await bad({ ...claimWrite(0), proofIds: ["prf_nope"] }), 400);
    const d = claimWrite(0).decisions;
    assert.equal(await bad({ ...claimWrite(0), decisions: d.map((x) => ({ ...x, overrideReason: null })) }), 400); // override without a reason
    assert.equal(await bad({ ...claimWrite(0), decisions: d.map((x) => ({ ...x, overrideReason: "because" })) }), 400); // reason without an override
    assert.equal(await bad({ ...claimWrite(0), decisions: d.map((x) => ({ ...x, decided: "accept" as const, overrideReason: x.suggested === "claim" ? "x" : null })) }), 400); // decisions don't match the claim
    assert.equal((await get()).revision, 0);
  });

  test("the reviewed claim is saved before the chain claim and a fresh client recovers it", async () => {
    const r = await call("POST", "/claim", signed(claimWrite(0), buyer.key));
    assert.equal(r.status, 200);
    const fresh = await get(); // another browser, no localStorage
    assert.equal(fresh.claim?.status, "prepared");
    assert.equal(fresh.claim?.scanId, "scan_old"); // not the newer station scan
    assert.deepEqual(fresh.claim?.lines.map((l) => l.claimedMinor), [250, 150]);
    assert.deepEqual(fresh.claim?.proofIds, ["prf_1"]);
    // The scan suggestion is kept next to the buyer decision and the override reason.
    assert.deepEqual(fresh.claim?.decisions.map((x) => [x.suggested, x.decided, x.overrideReason]), [
      ["accept", "accept", null],
      ["claim", "claim", null],
      ["accept", "claim", "Can crushed; the scan can't see damage"],
    ]);
    // Offers wait for a filed claim.
    assert.equal((await call("POST", "/offers", signed(offer("supplier", 1, "full_release", 400, 0), supplier.key))).status, 409);
  });

  test("claim confirmation checks the transaction and the held amount on chain", async () => {
    const other = txSig();
    chain.txs.set(other, tx("Claim", { escrow: randomKey().toBase58() }));
    const o = await call("POST", "/claim/confirm", { claimSignature: other });
    assert.equal(o.status, 409, JSON.stringify(o.body)); // not this escrow

    const wrong = txSig();
    chain.txs.set(wrong, tx("Claim"));
    chain.escrow = { total: 1000, released: 700, claimed: 300, refunded: 0, status: STATUS.claimed };
    assert.equal((await call("POST", "/claim/confirm", { claimSignature: wrong })).status, 409); // chain holds 300, claim says 400

    const good = txSig();
    chain.txs.set(good, tx("Claim"));
    chain.escrow = { total: 1000, released: 600, claimed: 400, refunded: 0, status: STATUS.claimed };
    const r = await call("POST", "/claim/confirm", { claimSignature: good });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.claim?.status, "filed");
    assert.deepEqual(r.body.claim?.chain, { escrowAddress: ESCROW, heldMinor: 400, releasedMinor: 600, refundedMinor: 0 });
    assert.equal((await call("POST", "/claim/confirm", { claimSignature: good })).body.revision, r.body.revision); // idempotent
    assert.equal((await call("POST", "/claim", signed(claimWrite(r.body.revision), buyer.key))).status, 409); // filed = final
  });

  test("offer, counter, stale and duplicate writes, rejection, acceptance", async () => {
    let st = await get();
    // Amounts must split exactly what's held.
    assert.equal((await call("POST", "/offers", signed(offer("supplier", st.revision, "split", 100, 299), supplier.key))).status, 400);
    assert.equal((await call("POST", "/offers", signed(offer("supplier", st.revision, "full_refund", 1, 399), supplier.key))).status, 400);
    assert.equal((await call("POST", "/offers", { ...offer("supplier", st.revision, "split", 100.5, 299.5), walletSignature: "x" })).status, 400);
    assert.equal((await call("POST", "/offers", signed(offer("supplier", st.revision, "split", 100, 300), buyer.key))).status, 401);

    const v1 = await call("POST", "/offers", signed(offer("supplier", st.revision, "split", 100, 300), supplier.key));
    assert.equal(v1.status, 200);
    st = v1.body;
    assert.equal(st.nextActor, "buyer");
    const off1 = st.currentOfferId!;

    // Both clients see the same state.
    assert.deepEqual(await get(), st);

    // Can't counter or accept your own offer.
    assert.equal((await call("POST", "/offers", signed(offer("supplier", st.revision, "split", 150, 250, off1), supplier.key))).status, 409);
    assert.equal((await postAnswer(answer("accept", "supplier", st), supplier.key)).status, 409);

    // Buyer counters. Retrying the same signed request doesn't create a second offer.
    const counter = signed(offer("buyer", st.revision, "split", 50, 350, off1), buyer.key);
    const v2 = await call("POST", "/offers", counter);
    assert.equal(v2.status, 200);
    const retry = await call("POST", "/offers", counter);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.revision, v2.body.revision);
    assert.equal(retry.body.offers.length, 2);
    const stale = st;
    st = v2.body;
    assert.equal(st.offers.find((o) => o.id === off1)?.status, "superseded");
    assert.equal(st.nextActor, "supplier");

    // Stale revision, and the superseded offer, can't be answered.
    assert.equal((await postAnswer(answer("accept", "supplier", stale, off1), supplier.key)).status, 409);
    assert.equal((await postAnswer({ ...answer("accept", "supplier", st, off1) }, supplier.key)).status, 409);
    // Accepting with amounts other than the offer's is refused.
    assert.equal((await postAnswer({ ...answer("accept", "supplier", st), toSupplierMinor: 60, toBuyerMinor: 340 } as AgreementWrite, supplier.key)).status, 409);

    // Supplier rejects; then either side may propose again.
    const rej = await postAnswer(answer("reject", "supplier", st), supplier.key);
    assert.equal(rej.status, 200);
    st = rej.body;
    assert.equal(st.currentOfferId, null);
    assert.equal(st.offers[0].status, "rejected");

    const v3 = await call("POST", "/offers", signed(offer("supplier", st.revision, "full_refund", 0, 400), supplier.key));
    st = v3.body;
    const acc = await postAnswer(answer("accept", "buyer", st), buyer.key);
    assert.equal(acc.status, 200);
    st = acc.body;
    assert.equal(st.offers[0].status, "accepted");
    assert.equal(st.nextActor, null);
    assert.deepEqual({ ...st.settlement, updatedAt: "" }, { offerId: st.currentOfferId, status: "awaiting_signatures", signature: null, error: null, updatedAt: "", attempts: [] });
    assert.equal((await call("POST", "/offers", signed(offer("buyer", st.revision, "split", 1, 399), buyer.key))).status, 409);
  });

  test("everything survives a server restart", async () => {
    const prior = await get();
    await server.stop();
    server = await startServer();
    assert.deepEqual(await get(), prior);
  });

  test("settlement: submitted, no unsafe second send, expiry proven, wrong transactions, unknown, then confirmed", async () => {
    let st = await get();
    const a = txSig();
    chain.height = 50;
    assert.equal((await call("POST", "/settlement", { ...settle("buyer", st, a, 100), walletSignature: "" })).status, 401);
    let r = await call("POST", "/settlement", signed(settle("buyer", st, a, 100), buyer.key));
    assert.equal(r.body.settlement?.status, "submitted");
    // While A could still land, no other settle transaction is accepted.
    assert.equal((await call("POST", "/settlement", signed(settle("buyer", st, txSig(), 200), buyer.key))).status, 409);
    // Re-check (no signature needed for a known transaction): past expiry, never seen, escrow still holds 400 → failed.
    chain.height = 101;
    r = await call("POST", "/settlement", { signature: a });
    assert.equal(r.body.settlement?.status, "failed", JSON.stringify(r.body.settlement));

    // A successful transaction that isn't a settle of this escrow is not the settlement.
    const notSettle = txSig();
    chain.txs.set(notSettle, tx("Claim"));
    r = await call("POST", "/settlement", signed(settle("supplier", st, notSettle, 500), supplier.key));
    assert.equal(r.body.settlement?.status, "failed");

    // Failed on chain.
    const failed = txSig();
    chain.txs.set(failed, tx("Settle", { err: { InstructionError: [0, "Custom"] } }));
    r = await call("POST", "/settlement", signed(settle("buyer", st, failed, 500), buyer.key));
    assert.equal(r.body.settlement?.status, "failed");

    // RPC down: unknown, and still no second send.
    const d = txSig();
    chain.rpcDown.add(d);
    r = await call("POST", "/settlement", signed(settle("buyer", st, d, 500), buyer.key));
    assert.equal(r.body.settlement?.status, "unknown");
    assert.equal((await call("POST", "/settlement", signed(settle("buyer", st, txSig(), 500), buyer.key))).status, 409);

    // It landed, but with other amounts than agreed: not confirmed.
    chain.rpcDown.delete(d);
    chain.txs.set(d, tx("Settle"));
    chain.escrow = { total: 1000, released: 700, claimed: 400, refunded: 300, status: STATUS.settled };
    r = await call("POST", "/settlement", { signature: d });
    assert.equal(r.body.settlement?.status, "unknown");
    assert.match(r.body.settlement?.error ?? "", /not the agreed 0 \/ 400/);

    // Chain shows exactly the agreed split: confirmed, and recorded on the escrow.
    chain.escrow = { total: 1000, released: 600, claimed: 400, refunded: 400, status: STATUS.settled };
    r = await call("POST", "/settlement", { signature: d });
    assert.equal(r.body.settlement?.status, "confirmed", JSON.stringify(r.body.settlement));
    st = r.body;
    assert.deepEqual(st.settlement!.attempts.map((x) => x.status), ["failed", "failed", "failed", "confirmed"]);
    const order = await (await fetch(`${server.base}/api/orders/${OID}`)).json();
    assert.equal(order.order.escrow.status, "settled");
    assert.ok(order.order.escrow.events.some((e: { action: string; signature: string }) => e.action === "settle" && e.signature === d));
    assert.equal((await call("POST", "/settlement", signed(settle("buyer", st, txSig(), 900), buyer.key))).status, 409);
  });
});
