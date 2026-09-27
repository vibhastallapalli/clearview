import assert from "node:assert/strict";
import { test } from "node:test";
import type { EscrowRecord } from "@cleardock/shared";
import { ApiRequestError } from "../api";
import { isConflict, isNetwork, isUnavailable, type AgreementApi } from "./client";
import { SimulatedAgreementApi } from "./fixture";
import { OFFER_CHANGED, currentOffer, heldMinor, parseAmountToMinor, reviewedFrom, settlePlan, splitError, splitFor, viewFor } from "./model";
import { AgreementSession, UNAVAILABLE } from "./session";

// Tests run against the SIMULATED stand-in for the PROPOSED agreement API (fixture.ts), never a live server.

const ORDER = "ord_1001";
const escrow = (over: Partial<EscrowRecord> = {}): EscrowRecord => ({
  programId: "prog",
  escrowAddress: "esc",
  buyer: "buyer",
  supplier: "supplier",
  mint: "mint",
  totalMinor: 3000,
  releasedMinor: 2000,
  claimedMinor: 1000,
  refundedMinor: 0,
  status: "claimed",
  events: [],
  ...over,
});

async function claimed() {
  const api = new SimulatedAgreementApi();
  await api.fileClaim(ORDER, {
    as: "buyer",
    scanId: "scan_1",
    evidenceRevision: 3,
    lines: [{ sku: null, description: "Product A · unit 3", claimedMinor: 1000, reason: "missing" }],
    claimedMinor: 1000,
    proofIds: ["prf_1"],
    claimSignature: "claimsig",
  });
  // Two devices: each has its own session on the same server.
  const buyer = new AgreementSession(api, ORDER);
  const supplier = new AgreementSession(api, ORDER);
  await buyer.refresh();
  await supplier.refresh();
  return { api, buyer, supplier };
}

test("amounts are parsed as text into whole cents, never floats", () => {
  assert.equal(parseAmountToMinor("5"), 500);
  assert.equal(parseAmountToMinor("5.5"), 550);
  assert.equal(parseAmountToMinor("$0.10"), 10);
  assert.equal(parseAmountToMinor("1,012.50"), 101250);
  for (const bad of ["", "-1", "5.555", "abc", "1.2.3", "1e3"]) assert.equal(parseAmountToMinor(bad), null, bad);
  assert.deepEqual(splitFor("split", 1000, 250), { toSupplierMinor: 250, toBuyerMinor: 750 });
  assert.deepEqual(splitFor("full_refund", 1000), { toSupplierMinor: 0, toBuyerMinor: 1000 });
  assert.deepEqual(splitFor("full_release", 1000), { toSupplierMinor: 1000, toBuyerMinor: 0 });
  assert.equal(splitError(1000, 1200, -200), "Neither side can get less than $0.00.");
  assert.equal(splitError(1000, 400, 500), "The split must add up to exactly the amount held in escrow.");
  assert.equal(splitError(1000, 400, 600), null);
  assert.equal(heldMinor(escrow()), 1000);
  assert.equal(heldMinor(escrow({ status: "settled" })), null);
});

test("both devices see the same offer, who proposed it and who acts next", async () => {
  const { buyer, supplier } = await claimed();
  assert.equal(viewFor(buyer.state!, "buyer", escrow()).phase, "no_offer");

  await buyer.propose("buyer", "split", 300, 700);
  await supplier.refresh();
  const b = viewFor(buyer.state!, "buyer", escrow());
  const s = viewFor(supplier.state!, "supplier", escrow());
  assert.equal(s.current!.id, b.current!.id);
  assert.deepEqual([s.current!.proposedBy, s.current!.toSupplierMinor, s.current!.toBuyerMinor], ["buyer", 300, 700]);
  assert.deepEqual([b.waitingOn, b.youAct, b.canRespond], ["supplier", false, false]);
  assert.deepEqual([s.waitingOn, s.youAct, s.canRespond, s.canPropose], ["supplier", true, true, true]);
});

test("a counter replaces the actionable offer; the old one is shown as superseded", async () => {
  const { buyer, supplier } = await claimed();
  await buyer.propose("buyer", "full_refund", 0, 1000);
  await supplier.refresh();
  await supplier.propose("supplier", "split", 500, 500);
  await buyer.refresh();
  const v = viewFor(buyer.state!, "buyer", escrow());
  assert.deepEqual([v.current!.version, v.current!.proposedBy, v.current!.status], [2, "supplier", "open"]);
  assert.deepEqual(v.past.map((o) => [o.version, o.status]), [[1, "superseded"]]);
  assert.equal(v.current!.replacesOfferId, v.past[0].id);
  assert.equal(v.canRespond, true);
});

test("an acceptance of an offer that changed on another device is refused, not carried to the new split", async () => {
  const { api, buyer, supplier } = await claimed();
  await supplier.propose("supplier", "full_release", 1000, 0);
  // Two buyer devices showing offer v1.
  const buyerTab2 = new AgreementSession(api, ORDER);
  await buyer.refresh();
  await buyerTab2.refresh();
  const sawV1 = reviewedFrom(buyer.state!, currentOffer(buyer.state!)!);

  // Tab 2 counters; tab 1 (behind) then presses Accept on v1.
  await buyerTab2.propose("buyer", "split", 200, 800);
  await buyer.respond("buyer", sawV1, true);
  assert.equal(buyer.notice?.text, OFFER_CHANGED);
  const st = await api.get(ORDER);
  assert.equal(st.offers.find((o) => o.id === sawV1.offerId)!.status, "superseded");
  assert.equal(currentOffer(st)!.status, "open");
  assert.equal(st.settlement, null, "nothing was accepted");
  // The refused tab now shows the new offer (after its refresh).
  assert.equal(currentOffer(buyer.state!)!.version, 2);
});

test("a tab that already has the newer offer refuses locally to send an answer reviewed on the old one", async () => {
  const { api, buyer, supplier } = await claimed();
  await buyer.propose("buyer", "full_refund", 0, 1000);
  await supplier.refresh();
  const sawV1 = reviewedFrom(supplier.state!, currentOffer(supplier.state!)!);
  // Another supplier device counters; this tab's poll picks it up before the click lands.
  const supplierTab2 = new AgreementSession(api, ORDER);
  await supplierTab2.refresh();
  await supplierTab2.propose("supplier", "split", 600, 400);
  await supplier.refresh();
  let writes = 0;
  const counting: AgreementApi = { ...bind(api), accept: (...a) => (writes++, api.accept(...a)) };
  const guarded = new AgreementSession(counting, ORDER);
  await guarded.refresh();
  await guarded.respond("supplier", sawV1, true);
  assert.equal(writes, 0, "no request was sent");
  assert.equal(guarded.notice?.text, OFFER_CHANGED);
});

test("an agreement only lets the settle transaction carry the accepted split and the amount devnet holds", async () => {
  const { buyer, supplier } = await claimed();
  await buyer.propose("buyer", "split", 250, 750);
  await supplier.refresh();
  const seen = reviewedFrom(supplier.state!, currentOffer(supplier.state!)!);
  await supplier.respond("supplier", seen, true);
  const st = supplier.state!;
  assert.equal(viewFor(st, "supplier", escrow()).phase, "agreed");
  const reviewed = reviewedFrom(st, currentOffer(st)!);

  const plan = settlePlan(st, escrow(), reviewed);
  assert.deepEqual(plan.ok && [plan.toSupplier, plan.toBuyer], [250, 750]);
  // The chain no longer holds that amount: refuse.
  assert.equal(settlePlan(st, escrow({ refundedMinor: 100 }), reviewed).ok, false);
  // Escrow not in "claimed": refuse.
  assert.equal(settlePlan(st, escrow({ status: "settled" }), reviewed).ok, false);
  // What was reviewed differs from the agreement (e.g. an older render): refuse.
  assert.equal(settlePlan(st, escrow(), { ...reviewed, toSupplierMinor: 300, toBuyerMinor: 700 }).ok, false);
});

test("no paid/refunded/settled until the settlement is confirmed; a sent one can't be signed again", async () => {
  const { api, buyer, supplier } = await claimed();
  await buyer.propose("buyer", "full_refund", 0, 1000);
  await supplier.refresh();
  await supplier.respond("supplier", reviewedFrom(supplier.state!, currentOffer(supplier.state!)!), true);
  const offerId = currentOffer(supplier.state!)!.id;

  await api.recordSettlement(ORDER, { offerId, signature: "settlesig" });
  await buyer.refresh();
  assert.equal(viewFor(buyer.state!, "buyer", escrow()).phase, "settling");
  const again = settlePlan(buyer.state!, escrow());
  assert.equal(again.ok, false);
  assert.match(!again.ok ? again.reason : "", /already sent/);

  api.resolveSettlement(ORDER, "unknown");
  await buyer.refresh();
  assert.equal(viewFor(buyer.state!, "buyer", escrow()).phase, "settling", "unknown is not success");

  api.resolveSettlement(ORDER, "confirmed");
  await buyer.refresh();
  assert.equal(viewFor(buyer.state!, "buyer", escrow({ status: "settled" })).phase, "settled");
});

test("a dropped connection keeps the answer for a safe retry, and a retry never duplicates an offer", async () => {
  const { api, buyer } = await claimed();

  // Lost before the server applied it: Retry sends it once.
  api.dropNext = { applied: false };
  await buyer.propose("buyer", "split", 100, 900);
  assert.equal(buyer.notice?.retry, true);
  assert.equal((await api.get(ORDER)).offers.length, 0);
  await buyer.retry();
  assert.equal((await api.get(ORDER)).offers.length, 1);
  assert.equal(buyer.notice, null);
});

test("a reply lost after the server applied it is recognised on retry instead of being sent twice", async () => {
  const { api, buyer } = await claimed();
  api.dropNext = { applied: true };
  await buyer.propose("buyer", "split", 100, 900);
  assert.equal(buyer.notice?.retry, true);
  await buyer.retry();
  const st = await api.get(ORDER);
  assert.equal(st.offers.length, 1);
  assert.equal(buyer.notice?.tone, "ok");
});

test("reload restores the shared negotiation from the server, and a slow poll can't roll it back", async () => {
  const { api, buyer, supplier } = await claimed();
  await buyer.propose("buyer", "full_refund", 0, 1000);
  await supplier.refresh();
  await supplier.propose("supplier", "split", 400, 600);

  const reloaded = new AgreementSession(api, ORDER); // a fresh page load: no local state at all
  await reloaded.refresh();
  assert.deepEqual(reloaded.state, await api.get(ORDER));
  const v = viewFor(reloaded.state!, "buyer", escrow());
  assert.deepEqual([v.current!.version, v.waitingOn, v.canRespond], [2, "buyer", true]);

  const older = { ...reloaded.state!, revision: reloaded.state!.revision - 1, offers: [] };
  const slow: AgreementApi = { ...bind(api), get: async () => older };
  const s2 = new AgreementSession(slow, ORDER);
  s2.state = reloaded.state;
  await s2.refresh();
  assert.equal(s2.state!.offers.length, 2);
});

test("a server without the agreement API is reported as unavailable, not as an empty agreement", async () => {
  assert.equal(isUnavailable(new ApiRequestError("Request failed (404)", 404)), true);
  assert.equal(isUnavailable(new ApiRequestError("Order x not found", 404, "not_found")), false);
  assert.equal(isUnavailable(new ApiRequestError("ESCROW_PROGRAM_ID is not configured", 501, "not_implemented")), true);
  assert.equal(isConflict(new ApiRequestError("Evidence changed", 409, "stale_approval")), true);
  assert.equal(isNetwork(new ApiRequestError("Request failed (504)", 504)), true);
  assert.equal(isNetwork(new ApiRequestError("Solana RPC unavailable", 503, "upstream_error")), false);

  const missing: AgreementApi = {
    ...bind(new SimulatedAgreementApi()),
    get: () => Promise.reject(new ApiRequestError("Request failed (404)", 404)),
    propose: () => Promise.reject(new ApiRequestError("Request failed (404)", 404)),
  };
  const s = new AgreementSession(missing, ORDER);
  await s.refresh();
  assert.equal(s.status, "unavailable");
  assert.equal(s.state, null);
  s.state = { orderId: ORDER, revision: 1, claim: null, offers: [], currentOfferId: null, nextActor: null, settlement: null };
  await s.propose("buyer", "full_refund", 0, 1000);
  assert.equal(s.notice?.text, UNAVAILABLE);
});

/** Methods of a class instance as a plain object, so single methods can be overridden. */
function bind(api: SimulatedAgreementApi): AgreementApi {
  return {
    get: api.get.bind(api),
    fileClaim: api.fileClaim,
    propose: api.propose,
    accept: api.accept,
    reject: api.reject,
    recordSettlement: api.recordSettlement,
  };
}
