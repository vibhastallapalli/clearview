import assert from "node:assert/strict";
import { test } from "node:test";
import { termsHashOf, type OrderDetail, type OrderTerms, type OrderTermsState } from "@cleardock/shared";
import type { FundingParams } from "./sign";

// web3.js keeps the fetch it finds when first loaded, so route it through a stub before importing sign.ts.
let handler: (url: string, init?: RequestInit) => Promise<Response>;
globalThis.fetch = ((url: string, init?: RequestInit) => handler(url, init)) as typeof fetch;
const { Keypair } = await import("@solana/web3.js");
const { checkFunding, signAndSend } = await import("./sign");

const key = () => Keypair.generate().publicKey.toBase58();
const buyer = key();
const supplier = key();
const mint = key();
const program = key();

const terms: OrderTerms = {
  rulesVersion: 2,
  orderId: "ord_1",
  reference: "PO-1001",
  network: "devnet",
  escrowProgramId: program,
  mint,
  buyerWallet: buyer,
  supplierWallet: supplier,
  lines: [{ sku: "PROD-A", description: "Product A 500 g", quantity: 3, unitPriceMinor: 1000 }],
  totalMinor: 3000,
  inspection: { hours: 48, startsAt: "first_station_scan_after_funding", enforced: false },
  rules: [],
} as OrderTerms;

const agreed = async (t: OrderTerms = terms): Promise<OrderTermsState> =>
  ({
    orderId: "ord_1",
    revision: 3,
    status: "agreed",
    current: { version: 2, terms: t, termsHash: await termsHashOf(t), proposedBy: "buyer", proposedAt: "", approvals: [] },
    history: [],
    outstanding: [],
    staleReason: null,
    funded: null,
  }) as OrderTermsState;

const params: FundingParams = {
  orderId: "ord_1",
  reference: "PO-1001",
  amount: 3000,
  signer: buyer,
  recordedBuyer: null,
  supplier,
  programId: program,
  mint,
};

test("matching agreed terms return their hash", async () => {
  const st = await agreed();
  assert.equal((await checkFunding(st, params)).toString("hex"), st.current!.termsHash);
});

test("every funding parameter that differs from the agreed terms is refused", async () => {
  const st = await agreed();
  const cases: [Partial<FundingParams>, RegExp][] = [
    [{ signer: key() }, /Switch Phantom to the agreed buyer/],
    [{ recordedBuyer: key() }, /recorded escrow buyer/],
    [{ supplier: key() }, /supplier wallet/],
    [{ mint: key() }, /token mint/],
    [{ programId: key() }, /escrow program/],
    [{ reference: "PO-9999" }, /order reference/],
    [{ orderId: "ord_2" }, /the order is/],
    [{ amount: 2999 }, /amount/],
  ];
  for (const [change, msg] of cases) await assert.rejects(checkFunding(st, { ...params, ...change }), msg, JSON.stringify(change));
});

test("unagreed terms or terms that don't match their hash are refused", async () => {
  const st = await agreed();
  await assert.rejects(checkFunding({ ...st, status: "awaiting_approval", outstanding: ["supplier"] } as OrderTermsState, params), /waiting on supplier/);
  const tampered = { ...st, current: { ...st.current!, terms: { ...terms, totalMinor: 1 } } };
  await assert.rejects(checkFunding(tampered, { ...params, amount: 1 }), /don't hash/);
});

// signAndSend end to end, with the server, devnet RPC and Phantom faked: a mismatch never reaches signing.
const g = globalThis as unknown as { window?: unknown };

async function fund(opts: { wallet: string; configMint?: string }) {
  const st = await agreed();
  const signed: unknown[] = [];
  g.window = {
    phantom: {
      solana: {
        isPhantom: true,
        publicKey: { toBase58: () => opts.wallet },
        signTransaction: async (tx: unknown) => {
          signed.push(tx);
          throw new Error("signing reached");
        },
      },
    },
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  handler = async (url, init) => {
    if (url === "/api/config") return json({ rpcUrl: "http://rpc.test", mint: opts.configMint ?? mint, escrowProgramId: program });
    if (url.includes("/terms")) return json(st);
    const { id } = JSON.parse(String(init!.body));
    return json({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: { blockhash: key(), lastValidBlockHeight: 100 } } });
  };
  const detail = { order: { id: "ord_1", reference: "PO-1001", escrow: null }, supplier: { walletAddress: supplier } } as unknown as OrderDetail;
  const hooks = { status: () => {}, waitForSupplier: async () => {} };
  const result = signAndSend({ chain: { action: "fund", amount: 3000 } } as never, detail, hooks).catch((e: Error) => e.message);
  return { message: await result, signed };
}

test("a wrong buyer wallet never reaches Phantom signing", async () => {
  const { message, signed } = await fund({ wallet: key() });
  assert.match(String(message), /Switch Phantom to the agreed buyer/);
  assert.equal(signed.length, 0);
});

test("a server mint that differs from the agreed terms never reaches Phantom signing", async () => {
  const { message, signed } = await fund({ wallet: buyer, configMint: key() });
  assert.match(String(message), /token mint/);
  assert.equal(signed.length, 0);
});

test("the agreed buyer with matching config reaches Phantom signing", async () => {
  const { message, signed } = await fund({ wallet: buyer });
  assert.match(String(message), /signing reached/);
  assert.equal(signed.length, 1);
});
