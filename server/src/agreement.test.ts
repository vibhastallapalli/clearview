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
import { agreementMessage, chatSessionMessage, orderTermsMessage, type AgreementState, type AgreementWrite, type ClaimLine, type OrderTermsState, type TermsPreview } from "@cleardock/shared";

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
// A fresh order for the order-terms tests: no escrow yet.
const OID2 = "ord_2002";
const REF2 = "PO-2002";
const ESCROW2 = randomKey().toBase58();
const txSig = () => randomKey().toBase58() + randomKey().toBase58();

const STATUS = { funded: 0, claimed: 1, settled: 2, released: 3 };
const chain = {
  escrow: { total: 1000, released: 0, claimed: 0, refunded: 0, status: STATUS.funded },
  txs: new Map<string, unknown>(),
  rpcDown: new Set<string>(),
  seen: new Set<string>(),
  height: 0,
  /** The fresh order's escrow on chain, once the buyer funds it. */
  escrow2: null as null | { total: number; termsHash: string; released?: number; claimed?: number; status?: number },
};

function escrowData(address: string) {
  const fresh = address === ESCROW2 && chain.escrow2;
  const e = fresh ? { total: fresh.total, released: fresh.released ?? 0, claimed: fresh.claimed ?? 0, refunded: 0, status: fresh.status ?? STATUS.funded } : chain.escrow;
  const b = Buffer.alloc(234);
  createHash("sha256").update("account:Escrow").digest().copy(b, 0, 0, 8);
  [buyer.pk, supplier.pk, MINT, VAULT].forEach((k, i) => k.toBuffer().copy(b, 8 + 32 * i));
  createHash("sha256").update(fresh ? REF2 : REF).digest().copy(b, 136);
  if (fresh) Buffer.from(fresh.termsHash, "hex").copy(b, 168);
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
      if (method === "getAccountInfo") return reply({ value: { data: [escrowData(params[0]).toString("base64"), "base64"], owner: PROGRAM } });
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
  const capture = (id: string) => ({ id, orderId: OID, sessionId: null, source: "station", imageUrl: `/files/${id}.jpg`, imageSha256: id, capturedAt: t, sensors: [], fixture: "test photo" });
  const scan = (id: string) => ({ id, orderId: OID, captureId: id === "scan_old" ? "cap_1" : "cap_2", observed: [], unreadable: [], notes: "fixture", analyzedBy: "mock", analyzedAt: t });
  const proof = { id: "prf_1", orderId: OID, captureId: "cap_p", imageSha256: "0", kind: "live", stationScanId: "scan_old", stationCaptureId: "cap_1", evidenceRevision: 2, createdAt: t };
  const fresh = { ...order, id: OID2, reference: REF2, status: "needs_documents", evidenceRevision: 0, latestCaptureId: null, latestScanId: null, escrow: null };
  writeFileSync(join(dataDir, "db.json"), JSON.stringify({
    suppliers: [sup], orders: [order, fresh], documents: [], sessions: [], captures: [capture("cap_1"), capture("cap_2")], scans: [scan("scan_old"), scan("scan_new"), { ...scan("scan_fresh"), orderId: OID2 }],
    proofs: [proof], paymentAttempts: [], archivedOrders: [], agreements: [],
  }));
}

let rpcUrl = "";
const dataDir = mkdtempSync(join(tmpdir(), "cleardock-agreement-"));

async function startServer(overrides: NodeJS.ProcessEnv = {}) {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env, PORT: String(port), CLEARDOCK_DATA_DIR: dataDir, GEMINI_API_KEY: "", SOLANA_RPC_URL: rpcUrl,
    ESCROW_PROGRAM_ID: PROGRAM, DEMO_TOKEN_MINT: MINT.toBase58(), DEMO_BUYER_WALLET: buyer.address, DEMO_SUPPLIER_WALLET: supplier.address,
    ...overrides,
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
    assert.deepEqual(await get(), { orderId: OID, revision: 0, claim: null, offers: [], currentOfferId: null, nextActor: null, settlement: null, remedy: null });
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
    assert.equal(fresh.claim?.stationCapture?.imageUrl, "/files/cap_1.jpg"); // the photo of that scan, for both parties
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

// ---------- order terms (before funding) ----------

async function tcall(method: string, path: string, body?: object) {
  const r = await fetch(server.base + `/api/orders/${OID2}/terms` + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body && JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as OrderTermsState & { error?: string } };
}
const termsLines = (quantity: number) => [{ sku: "A", description: "Product A 500 g", quantity, unitPriceMinor: 1000 }];
const termsSig = (v: { version: number; termsHash: string; terms: TermsPreview["terms"] }, key: KeyObject) =>
  sign(null, Buffer.from(orderTermsMessage(OID2, v.version, v.termsHash, v.terms)), key).toString("base64");

async function proposeTerms(as: "buyer" | "supplier", key: KeyObject, quantity: number, expectedRevision: number) {
  const pv = (await tcall("POST", "/preview", { lines: termsLines(quantity), inspectionHours: 72 })).body as unknown as TermsPreview;
  return tcall("POST", "/propose", { as, expectedRevision, lines: termsLines(quantity), inspectionHours: 72, walletSignature: termsSig(pv, key) });
}
const approveBody = (as: "buyer" | "supplier", key: KeyObject, v: NonNullable<OrderTermsState["current"]>) => ({ as, version: v.version, termsHash: v.termsHash, walletSignature: termsSig(v, key) });

async function fundEvent(total: number, termsHash: string) {
  chain.escrow2 = { total, termsHash };
  const signature = txSig();
  chain.txs.set(signature, tx("Fund", { escrow: ESCROW2 }));
  const r = await fetch(`${server.base}/api/orders/${OID2}/escrow/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "fund", signature, escrowAddress: ESCROW2 }),
  });
  return { status: r.status, body: await r.json() };
}
const escrowOf = async (oid: string) => (await (await fetch(`${server.base}/api/orders/${oid}`)).json()).order.escrow;

describe("order terms before funding", () => {
  let v1Hash = "";

  test("an escrow funded before terms existed is legacy; a fresh order has none", async () => {
    const legacy = await (await fetch(`${server.base}/api/orders/${OID}/terms`)).json();
    assert.equal(legacy.status, "legacy");
    const st = (await tcall("GET", "")).body;
    assert.equal(st.status, "none");
    assert.deepEqual(st.outstanding, ["buyer", "supplier"]);
  });

  test("the preview builds the canonical terms from server facts, not the client", async () => {
    const pv = (await tcall("POST", "/preview", { lines: termsLines(3), inspectionHours: 72 })).body as unknown as TermsPreview;
    assert.equal(pv.version, 1);
    assert.deepEqual([pv.terms.totalMinor, pv.terms.buyerWallet, pv.terms.supplierWallet, pv.terms.mint, pv.terms.reference], [3000, buyer.address, supplier.address, MINT.toBase58(), REF2]);
    assert.deepEqual(pv.terms.inspection, { hours: 72, startsAt: "first_station_scan_after_funding", enforced: false });
    assert.equal((await tcall("POST", "/preview", { lines: [{ description: "x", quantity: 1.5, unitPriceMinor: 100 }], inspectionHours: 72 })).status, 400);
    assert.deepEqual(pv.terms.remedies, { missing: 100, damaged: 100, wrong_item: 100 }); // default, shown before signing
    const bad = (remedies: object) => tcall("POST", "/preview", { lines: termsLines(3), inspectionHours: 72, remedies }).then((x) => x.status);
    assert.equal(await bad({ missing: 101, damaged: 50, wrong_item: 100 }), 400);
    assert.equal(await bad({ missing: 100, damaged: 12.5, wrong_item: 100 }), 400);
    assert.equal(await bad({ missing: 100, damaged: 50 }), 400);
    const half = (await tcall("POST", "/preview", { lines: termsLines(3), inspectionHours: 72, remedies: { missing: 100, damaged: 50, wrong_item: 100 } })).body as unknown as TermsPreview;
    assert.notEqual(half.termsHash, pv.termsHash); // the schedule is signed: changing it is different terms
    assert.match(orderTermsMessage(OID2, half.version, half.termsHash, half.terms), /damaged 50%/);
  });

  test("wrong wallets are rejected and one approval can't unlock funding", async () => {
    assert.equal((await proposeTerms("buyer", supplier.key, 3, 0)).status, 401);
    assert.equal((await proposeTerms("buyer", intruder.key, 3, 0)).status, 401);
    const r = await proposeTerms("buyer", buyer.key, 3, 0);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "awaiting_approval");
    assert.deepEqual(r.body.outstanding, ["supplier"]);
    v1Hash = r.body.current!.termsHash;
    assert.equal((await tcall("POST", "/approve", approveBody("supplier", buyer.key, r.body.current!))).status, 401);

    // The buyer funds on chain with exactly these terms, but only one party approved: not linked.
    const f = await fundEvent(3000, v1Hash);
    assert.equal(f.status, 409, JSON.stringify(f.body));
    assert.equal(await escrowOf(OID2), null);
  });

  test("editing the terms invalidates earlier approvals; signatures from different versions can't be combined", async () => {
    let st = (await tcall("GET", "")).body;
    assert.equal((await proposeTerms("supplier", supplier.key, 2, st.revision - 1)).status, 409); // stale revision
    const r = await proposeTerms("supplier", supplier.key, 2, st.revision);
    st = r.body;
    assert.deepEqual([st.current!.version, st.status, st.outstanding], [2, "awaiting_approval", ["buyer"]]);
    assert.equal(st.history[0].version, 1);
    const v1 = st.history[0];
    assert.equal((await tcall("POST", "/approve", approveBody("buyer", buyer.key, v1))).status, 409); // not current
    const mixed = { as: "buyer", version: 2, termsHash: st.current!.termsHash, walletSignature: termsSig(v1, buyer.key) };
    assert.equal((await tcall("POST", "/approve", mixed)).status, 401); // a v1 signature doesn't approve v2

    const ok = await tcall("POST", "/approve", approveBody("buyer", buyer.key, st.current!));
    assert.equal(ok.body.status, "agreed");
    assert.deepEqual(ok.body.current!.approvals.map((a) => [a.party, a.wallet]), [["supplier", supplier.address], ["buyer", buyer.address]]);
    const again = await tcall("POST", "/approve", approveBody("buyer", buyer.key, st.current!));
    assert.equal(again.body.revision, ok.body.revision); // no duplicate approval
  });

  test("changed mint or parties can't reuse the acceptance; reload restores the same state on any device", async () => {
    const prior = (await tcall("GET", "")).body;
    await server.stop();
    server = await startServer({ DEMO_TOKEN_MINT: randomKey().toBase58() });
    let st = (await tcall("GET", "")).body;
    assert.equal(st.status, "stale");
    assert.match(st.staleReason ?? "", /mint/);
    assert.equal((await tcall("POST", "/approve", approveBody("buyer", buyer.key, st.current!))).status, 409);

    await server.stop();
    server = await startServer({ DEMO_BUYER_WALLET: intruder.address });
    st = (await tcall("GET", "")).body;
    assert.equal(st.status, "stale");
    assert.match(st.staleReason ?? "", /buyerWallet/);

    await server.stop();
    server = await startServer();
    assert.deepEqual((await tcall("GET", "")).body, prior); // first device
    assert.deepEqual((await tcall("GET", "")).body, prior); // second device
  });

  test("funding links only an escrow holding exactly the agreed terms, then the terms freeze", async () => {
    const st = (await tcall("GET", "")).body;
    const agreed = st.current!;
    assert.equal((await fundEvent(2000, v1Hash)).status, 409); // an earlier version's hash
    assert.equal((await fundEvent(3000, agreed.termsHash)).status, 409); // wrong amount for v2
    const f = await fundEvent(2000, agreed.termsHash);
    assert.equal(f.status, 200, JSON.stringify(f.body));
    const funded = (await tcall("GET", "")).body;
    assert.equal(funded.status, "funded");
    assert.equal(funded.funded?.termsHash, agreed.termsHash);
    assert.equal(funded.funded?.escrowAddress, ESCROW2);

    // Frozen: no new version, no approvals.
    assert.equal((await proposeTerms("buyer", buyer.key, 5, funded.revision)).status, 409);
    assert.equal((await tcall("POST", "/approve", approveBody("buyer", buyer.key, agreed))).status, 409);
    assert.deepEqual((await tcall("GET", "")).body.current, agreed);
  });
});

test("dev-only routes answer local requests but not tunnelled ones", async () => {
  const dev = (headers: Record<string, string>) =>
    fetch(`${server.base}/api/dev/orders/${OID}/sample-proof`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ sample: "nope" }) }).then((r) => r.status);
  assert.equal(await dev({}), 400); // reached the route (bad sample name)
  assert.equal(await dev({ "cf-connecting-ip": "203.0.113.9" }), 404);
  assert.equal(await dev({ "x-forwarded-for": "203.0.113.9" }), 404);
});

test("a filed claim on an order funded with signed terms gets the schedule's default split; legacy orders get none", async () => {
  assert.equal((await get()).remedy, null); // ord_1001: escrow linked before terms existed

  // Continue the funded fresh order: the buyer claims one missing can (1000 held, 1000 released).
  const terms = (await tcall("GET", "")).body;
  assert.equal(terms.status, "funded");
  const claim: ClaimWrite = {
    action: "prepare_claim", as: "buyer", expectedRevision: 0, scanId: "scan_fresh", evidenceRevision: 0,
    lines: [{ sku: "A", description: "Product A 500 g", claimedMinor: 1000, reason: "missing" }], claimedMinor: 1000, proofIds: [],
    decisions: [
      { description: "Product A 500 g · unit 1", priceMinor: 1000, suggested: "accept", decided: "accept", overrideReason: null },
      { description: "Product A 500 g", priceMinor: 1000, suggested: "claim", decided: "claim", overrideReason: null },
    ],
  };
  const sig = sign(null, Buffer.from(agreementMessage(OID2, claim)), buyer.key).toString("base64");
  const at = (path: string, body: object) =>
    fetch(`${server.base}/api/orders/${OID2}/agreement${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await at("/claim", { ...claim, walletSignature: sig })).status, 200);

  const claimSig = txSig();
  chain.txs.set(claimSig, tx("Claim", { escrow: ESCROW2 }));
  chain.escrow2 = { ...chain.escrow2!, released: 1000, claimed: 1000, status: STATUS.claimed };
  const filed = await at("/claim/confirm", { claimSignature: claimSig });
  const st = (await filed.json()) as AgreementState;
  assert.equal(filed.status, 200, JSON.stringify(st));
  assert.deepEqual(
    [st.remedy?.termsVersion, st.remedy?.toBuyerMinor, st.remedy?.toSupplierMinor, st.remedy?.basis[0].refundPercent],
    [terms.current!.version, 1000, 0, 100],
  );
});

test("dispute chat: one wallet sign-in per session labels messages; commands and unsigned posts are refused", async () => {
  const chat = (path: string, body?: object, token?: string) =>
    fetch(`${server.base}/api/orders/${OID}/chat${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body && JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const signIn = (as: "buyer" | "supplier", key: KeyObject, issuedAt = new Date().toISOString(), nonce = randomBytes(8).toString("hex")) =>
    chat("/session", { as, issuedAt, nonce, walletSignature: sign(null, Buffer.from(chatSessionMessage(OID, as, issuedAt, nonce)), key).toString("base64") });

  assert.equal((await signIn("buyer", supplier.key)).status, 401); // wrong wallet
  assert.equal((await signIn("buyer", buyer.key, new Date(Date.now() - 3600_000).toISOString())).status, 401); // stale
  const nonce = randomBytes(8).toString("hex");
  const issuedAt = new Date().toISOString();
  const b = await signIn("buyer", buyer.key, issuedAt, nonce);
  assert.equal(b.status, 200);
  assert.equal(b.body.wallet, buyer.address);
  assert.equal((await signIn("buyer", buyer.key, issuedAt, nonce)).status, 401); // replayed sign-in

  assert.equal((await chat("/messages", { text: "hello" })).status, 401); // no session
  assert.equal((await chat("/messages", { text: "/offer 5" }, b.body.token)).status, 400); // offers are signed, not chatted
  assert.equal((await chat("/messages", { text: "One bag never arrived; the station photo shows two." }, b.body.token)).status, 200);
  const s = await signIn("supplier", supplier.key);
  await chat("/messages", { text: "Checking the dispatch photo now.", aiAssisted: true }, s.body.token);
  const thread = (await chat("")).body;
  assert.deepEqual(thread.messages.map((m: { from: string; wallet: string; aiAssisted: boolean }) => [m.from, m.wallet, m.aiAssisted]), [
    ["buyer", buyer.address, false],
    ["supplier", supplier.address, true],
  ]);
  assert.equal((await chat("/assist", { draft: "can u do 5" }, b.body.token)).status, 501); // no Gemini key in tests
});
