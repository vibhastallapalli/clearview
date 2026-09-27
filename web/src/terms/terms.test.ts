import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_REMEDIES, ORDER_TERMS_RULES, orderTermsMessage, termsHashOf, type ExtractedDocument, type OrderTerms, type OrderTermsState } from "@cleardock/shared";
import { RETIRED_EVENTS, fundRequest, initialState } from "../escrow/demo";
import { fundingBlock, initialDraft, parseDraft, termsToSign } from "./terms";

const terms = (over: Partial<OrderTerms> = {}): OrderTerms => ({
  rulesVersion: 2,
  remedies: { ...DEFAULT_REMEDIES },
  orderId: "ord_terms_qa",
  reference: "PO-QA-T1",
  network: "devnet",
  escrowProgramId: "prog",
  mint: "mint",
  buyerWallet: "BuyerWallet111",
  supplierWallet: "SupplierWallet111",
  lines: [{ sku: "PROD-A", description: "Product A 500 g", quantity: 3, unitPriceMinor: 1000 }],
  totalMinor: 3000,
  inspection: { hours: 72, startsAt: "first_station_scan_after_funding", enforced: false },
  rules: [...ORDER_TERMS_RULES],
  ...over,
});

const state = (status: OrderTermsState["status"], over: Partial<OrderTermsState> = {}): OrderTermsState => ({
  orderId: "ord_terms_qa",
  revision: 1,
  status,
  current: status === "none" ? null : { version: 2, terms: terms(), termsHash: "h", proposedBy: "buyer", proposedAt: "", approvals: [] },
  history: [],
  outstanding: [],
  staleReason: null,
  funded: null,
  ...over,
});

test("the draft starts from the purchase order, or the current version when there is one", () => {
  const po = { kind: "purchase_order", source: { filename: "PO.pdf" }, lines: [{ sku: "PROD-A", description: "Beans", quantity: 3, unitPriceMinor: 1000 }] } as unknown as ExtractedDocument;
  const fromPo = initialDraft(null, { documents: [po] });
  assert.deepEqual(fromPo.lines, [{ sku: "PROD-A", description: "Beans", quantity: "3", unitPrice: "10.00" }]);
  assert.match(fromPo.from!, /purchase order PO.pdf/);
  assert.equal(initialDraft(state("awaiting_approval"), { documents: [po] }).from, "terms v2");
  assert.equal(initialDraft(null, { documents: [] }).from, null);
});

test("the remedy schedule starts at 100/100/100, or from the current version; pre-schedule terms start from the defaults", () => {
  assert.deepEqual(initialDraft(null, { documents: [] }).remedies, { missing: "100", damaged: "100", wrong_item: "100" });
  const cur = state("agreed");
  cur.current!.terms.remedies = { missing: 100, damaged: 40, wrong_item: 0 };
  assert.deepEqual(initialDraft(cur, { documents: [] }).remedies, { missing: "100", damaged: "40", wrong_item: "0" });
  delete (cur.current!.terms as Partial<OrderTerms>).remedies;
  assert.deepEqual(initialDraft(cur, { documents: [] }).remedies, { missing: "100", damaged: "100", wrong_item: "100" });
});

test("remedy percents are whole numbers 0 to 100, sent with the lines, and part of what is signed", async () => {
  const line = [{ sku: null, description: "Beans", quantity: "3", unitPrice: "10" }];
  const ok = parseDraft(line, "72", { missing: "100", damaged: " 50 ", wrong_item: "0" });
  assert.ok(!("error" in ok));
  assert.deepEqual(ok.remedies, { missing: 100, damaged: 50, wrong_item: 0 });
  for (const bad of ["101", "-1", "12.5", "", "abc", "1000"])
    assert.match((parseDraft(line, "72", { missing: "100", damaged: bad, wrong_item: "100" }) as { error: string }).error, /Damaged refund must be a whole percent from 0 to 100/, bad);

  const t = terms({ remedies: { missing: 100, damaged: 50, wrong_item: 0 } });
  const h = await termsHashOf(t);
  assert.notEqual(h, await termsHashOf(terms()), "changing a percent changes the hash, so it is a new version both sign");
  assert.match(await termsToSign("ord_terms_qa", "buyer", { version: 3, terms: t, termsHash: h }, "BuyerWallet111"), /missing 100%, damaged 50%, wrong item 0%/);
});

test("draft lines parse into whole cents; bad input is refused with the line number", () => {
  const r = { missing: "100", damaged: "100", wrong_item: "100" };
  const ok = parseDraft([{ sku: null, description: "Beans", quantity: "3", unitPrice: "10.5" }], "72", r);
  assert.deepEqual(ok, { lines: [{ sku: null, description: "Beans", quantity: 3, unitPriceMinor: 1050 }], inspectionHours: 72, remedies: DEFAULT_REMEDIES });
  for (const [q, p, h] of [["0", "1", "72"], ["1.5", "1", "72"], ["1", "1.005", "72"], ["1", "1", "0"], ["1", "1", "721"]])
    assert.ok("error" in parseDraft([{ sku: null, description: "Beans", quantity: q, unitPrice: p }], h, r), `${q} ${p} ${h}`);
});

test("funding is blocked unless both approved the current, non-stale version", () => {
  assert.equal(fundingBlock(state("agreed")), null);
  assert.match(fundingBlock(state("awaiting_approval", { outstanding: ["supplier"] }))!, /v2 .*waiting on the supplier/);
  assert.match(fundingBlock(state("stale", { staleReason: "Changed since: supplierWallet." }))!, /stale: Changed since: supplierWallet\. Funding is blocked/);
  assert.match(fundingBlock(state("none"))!, /No order terms/);
  assert.match(fundingBlock(null, "down")!, /Can't read the order terms: down/);
});

test("only the shown terms, hash-checked, are signed, and only by that party's wallet", async () => {
  const t = terms();
  const v = { version: 2, terms: t, termsHash: await termsHashOf(t) };
  assert.equal(await termsToSign("ord_terms_qa", "supplier", v, "SupplierWallet111"), orderTermsMessage("ord_terms_qa", 2, v.termsHash, t));
  await assert.rejects(termsToSign("ord_terms_qa", "supplier", v, "BuyerWallet111"), /Switch Phantom to the supplier wallet/);
  await assert.rejects(termsToSign("ord_terms_qa", "buyer", { ...v, terms: terms({ totalMinor: 1 }) }, "BuyerWallet111"), /don't match their hash/);
});

test("funding uses the agreed total; no simulated 'both signed' event is seeded", () => {
  assert.deepEqual(fundRequest(4250, "PO-QA-T1", 3).chain, { action: "fund", amount: 4250 });
  assert.ok(!initialState(null).events.some((e) => RETIRED_EVENTS.includes(e.label)));
});
