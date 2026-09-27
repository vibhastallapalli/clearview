import assert from "node:assert/strict";
import { test } from "node:test";
import type { EscrowRecord, OrderDetail, RemedySchedule } from "@cleardock/shared";
import { ApiRequestError } from "../api";
import { missingReason, type Line } from "../escrow/demo";
import { WalletError } from "../wallet/phantom";
import { claimWrite } from "./claim";
import { isConflict, isNetwork, isUnavailable, isWrongWallet, type AgreementApi } from "./client";
import type { AgreementWrite, Party } from "./contract";
import { SimulatedAgreementApi, WALLETS, fakeSign } from "./fixture";
import { OFFER_CHANGED, belowSchedule, currentOffer, heldMinor, remedyPrefill, offerError, parseAmountToMinor, reviewedFrom, settlePlan, splitFor, viewFor } from "./model";
import { AgreementSession, UNAVAILABLE } from "./session";
import { WrongWalletError, type Signer } from "./signer";

// Unit tests against the SIMULATED stand-in for Account 1's API (fixture.ts). The real server is checked separately.

const ORDER = "ord_1001";
const escrow = (over: Partial<EscrowRecord> = {}): EscrowRecord => ({
  programId: "prog",
  escrowAddress: "esc",
  buyer: WALLETS.buyer,
  supplier: WALLETS.supplier,
  mint: "mint",
  totalMinor: 3000,
  releasedMinor: 2000,
  claimedMinor: 1000,
  refundedMinor: 0,
  status: "claimed",
  events: [],
  ...over,
});

/** A device with Phantom connected to `wallet`. Refuses, like phantomSigner, to sign for another party's wallet. */
function device(connected: Party | "stranger", opts: { decline?: boolean; signs?: string[] } = {}): Signer {
  return async (orderId, w) => {
    if (opts.decline) throw new WalletError("rejected", "You declined the message signature in Phantom.");
    const wallet = connected === "stranger" ? "StrangerWallet1" : WALLETS[connected];
    if (wallet !== WALLETS[w.as]) throw new WrongWalletError(`Switch Phantom to the ${w.as} wallet. Nothing was sent.`);
    opts.signs?.push(w.action);
    return fakeSign(orderId, w, wallet);
  };
}

const reviewedLines: Line[] = [1, 2, 3].map((i) => ({
  id: `A-${i}`,
  label: `Product A · unit ${i}`,
  sub: i < 3 ? "Seen on scan" : "Not seen on scan",
  priceMinor: 1000,
  claim: i === 3,
  miss: i === 3,
}));
const detail = { order: { id: ORDER, latestScanId: "scan_1" }, proofs: [{ id: "prf_1", stationScanId: "scan_1" }, { id: "prf_old", stationScanId: "scan_0" }] } as unknown as OrderDetail;

async function filed(remedies?: RemedySchedule) {
  const api = new SimulatedAgreementApi();
  if (remedies) api.schedule = { remedies, termsVersion: 2 };
  const buyer = new AgreementSession(api, ORDER, device("buyer"));
  const supplier = new AgreementSession(api, ORDER, device("supplier"));
  await buyer.refresh();
  assert.ok(await buyer.write(claimWrite(buyer.state!, detail, reviewedLines, { scanId: "scan_1", revision: 3 })));
  await api.confirmClaim(ORDER, "claimSig");
  await buyer.refresh();
  await supplier.refresh();
  return { api, buyer, supplier };
}

test("amounts are parsed as text into whole cents; offers follow the server's kind rules", () => {
  assert.equal(parseAmountToMinor("5.5"), 550);
  assert.equal(parseAmountToMinor("1,012.50"), 101250);
  for (const bad of ["", "-1", "5.555", "abc", "1e3"]) assert.equal(parseAmountToMinor(bad), null, bad);
  assert.deepEqual(splitFor("split", 1000, 250), { toSupplierMinor: 250, toBuyerMinor: 750 });
  assert.equal(offerError("split", 1000, 0, 1000), "A split gives both sides something. Use full refund or full release instead.");
  assert.equal(offerError("full_refund", 1000, 0, 1000), null);
  assert.equal(offerError("split", 1000, 400, 500), "The split must add up to exactly the amount held in escrow.");
  assert.equal(heldMinor(escrow()), 1000);
  assert.equal(heldMinor(escrow({ status: "settled" })), null);
});

test("the reviewed claim is saved (signed by the buyer) before the chain claim; another device reads it; offers wait for devnet", async () => {
  const api = new SimulatedAgreementApi();
  const signs: string[] = [];
  const buyer = new AgreementSession(api, ORDER, device("buyer", { signs }));
  await buyer.refresh();
  const w = claimWrite(buyer.state!, detail, reviewedLines, { scanId: "scan_1", revision: 3 });
  assert.deepEqual(w.action === "prepare_claim" && [w.claimedMinor, w.proofIds, w.lines.map((l) => l.description)], [1000, ["prf_1"], ["Product A · unit 3"]]);
  await buyer.write(w);
  assert.deepEqual(signs, ["prepare_claim"]);

  const otherDevice = new AgreementSession(api, ORDER, device("supplier"));
  await otherDevice.refresh();
  assert.equal(otherDevice.state!.claim!.status, "prepared");
  assert.equal(otherDevice.state!.claim!.lines[0].description, "Product A · unit 3");
  assert.equal(viewFor(otherDevice.state!, "supplier", escrow()).phase, "claim_saved");
  assert.equal(viewFor(otherDevice.state!, "supplier", escrow()).canPropose, false);

  await api.confirmClaim(ORDER, "claimSig");
  await otherDevice.refresh();
  assert.equal(viewFor(otherDevice.state!, "supplier", escrow()).phase, "no_offer");
});

test("both devices see the same signed offer, who proposed it and who acts next", async () => {
  const { buyer, supplier } = await filed();
  await buyer.propose("buyer", "split", 300, 700);
  await supplier.refresh();
  const b = viewFor(buyer.state!, "buyer", escrow());
  const s = viewFor(supplier.state!, "supplier", escrow());
  assert.equal(s.current!.id, b.current!.id);
  assert.deepEqual([s.current!.proposedBy, s.current!.toSupplierMinor, s.current!.toBuyerMinor], ["buyer", 300, 700]);
  assert.deepEqual([b.waitingOn, b.canRespond], ["supplier", false]);
  assert.deepEqual([s.waitingOn, s.canRespond], ["supplier", true]);
});

test("a counter replaces the actionable offer; the old one is superseded", async () => {
  const { buyer, supplier } = await filed();
  await buyer.propose("buyer", "full_refund", 0, 1000);
  await supplier.refresh();
  await supplier.propose("supplier", "split", 500, 500);
  await buyer.refresh();
  const v = viewFor(buyer.state!, "buyer", escrow());
  assert.deepEqual([v.current!.version, v.current!.proposedBy, v.current!.status, v.current!.replacesOfferId], [2, "supplier", "open", v.past[0].id]);
  assert.deepEqual(v.past.map((o) => [o.version, o.status]), [[1, "superseded"]]);
});

test("an answer signed for an offer that changed on another device is refused by the server, not carried to the new split", async () => {
  const { api, buyer, supplier } = await filed();
  await supplier.propose("supplier", "full_release", 1000, 0);
  const buyerTab2 = new AgreementSession(api, ORDER, device("buyer"));
  await buyer.refresh();
  await buyerTab2.refresh();
  const sawV1 = reviewedFrom(buyer.state!, currentOffer(buyer.state!)!);
  await buyerTab2.propose("buyer", "split", 200, 800);
  await buyer.respond("buyer", sawV1, true); // tab 1 is behind and doesn't know yet
  assert.match(buyer.notice!.text, /changed on another device/);
  const st = await api.get(ORDER);
  assert.equal(st.offers.find((o) => o.id === sawV1.offerId)!.status, "superseded");
  assert.equal(st.settlement, null, "nothing was accepted");
  assert.equal(currentOffer(buyer.state!)!.version, 2, "the refused tab now shows the new offer");
});

test("a tab that already has the newer offer refuses locally: nothing is signed or sent", async () => {
  const { api, buyer, supplier } = await filed();
  await buyer.propose("buyer", "full_refund", 0, 1000);
  await supplier.refresh();
  const sawV1 = reviewedFrom(supplier.state!, currentOffer(supplier.state!)!);
  const supplierTab2 = new AgreementSession(api, ORDER, device("supplier"));
  await supplierTab2.refresh();
  await supplierTab2.propose("supplier", "split", 600, 400);
  const signs: string[] = [];
  const guarded = new AgreementSession(api, ORDER, device("supplier", { signs }));
  await guarded.refresh();
  const before = api.writes;
  await guarded.respond("supplier", sawV1, true);
  assert.deepEqual(signs, []);
  assert.equal(api.writes, before);
  assert.equal(guarded.notice!.text, OFFER_CHANGED);
});

test("an accept carries the exact offer reviewed: id, version and both amounts", async () => {
  const { api, buyer, supplier } = await filed();
  await buyer.propose("buyer", "split", 250, 750);
  await supplier.refresh();
  const seen = reviewedFrom(supplier.state!, currentOffer(supplier.state!)!);
  // A tampered review (e.g. from an older render) is refused by the server with a conflict.
  await supplier.respond("supplier", { ...seen, toSupplierMinor: 300, toBuyerMinor: 700 }, true);
  // (refused locally first: the reviewed split doesn't match the current offer)
  assert.equal(supplier.notice!.text, OFFER_CHANGED);
  await supplier.respond("supplier", seen, true);
  const st = await api.get(ORDER);
  assert.deepEqual([currentOffer(st)!.status, st.settlement!.status], ["accepted", "awaiting_signatures"]);
});

test("only the party's own wallet can sign: a wrong account is stopped before signing, a forged signature gets 401", async () => {
  const { api, buyer } = await filed();
  await buyer.propose("buyer", "full_refund", 0, 1000);
  // The supplier view, but Phantom is still on the buyer wallet.
  const wrong = new AgreementSession(api, ORDER, device("buyer"));
  await wrong.refresh();
  const before = api.writes;
  await wrong.respond("supplier", reviewedFrom(wrong.state!, currentOffer(wrong.state!)!), true);
  assert.equal(api.writes, before, "nothing sent");
  assert.match(wrong.notice!.text, /Switch Phantom to the supplier wallet/);

  // A signature from some other wallet reaching the server is refused.
  const forged: Signer = async (orderId, w: AgreementWrite) => fakeSign(orderId, w, "StrangerWallet1");
  const intruder = new AgreementSession(api, ORDER, forged);
  await intruder.refresh();
  await intruder.respond("supplier", reviewedFrom(intruder.state!, currentOffer(intruder.state!)!), true);
  assert.match(intruder.notice!.text, /must be signed by the supplier wallet/);
  assert.equal(currentOffer(await api.get(ORDER))!.status, "open");
});

test("declining the signature in Phantom sends nothing and says so", async () => {
  const { api } = await filed();
  const s = new AgreementSession(api, ORDER, device("buyer", { decline: true }));
  await s.refresh();
  const before = api.writes;
  await s.propose("buyer", "full_refund", 0, 1000);
  assert.equal(api.writes, before);
  assert.equal(s.notice!.text, "You declined the signature in Phantom. Nothing was sent.");
});

test("a dropped connection keeps the signed request; Retry resends the same bytes and never duplicates an offer", async () => {
  const { api, buyer } = await filed();
  api.dropNext = { applied: false };
  await buyer.propose("buyer", "split", 100, 900);
  assert.equal(buyer.notice?.retry, true);
  assert.equal((await api.get(ORDER)).offers.length, 0);
  await buyer.retry();
  assert.equal((await api.get(ORDER)).offers.length, 1);

  api.dropNext = { applied: true }; // applied, but the reply was lost
  const supplier = new AgreementSession(api, ORDER, device("supplier"));
  await supplier.refresh();
  await supplier.propose("supplier", "split", 400, 600);
  assert.equal(supplier.notice?.retry, true);
  await supplier.retry();
  const st = await api.get(ORDER);
  assert.equal(st.offers.length, 2, "the server recognised the resent write");
  assert.equal(supplier.notice?.tone, "ok");
});

test("reload restores the shared negotiation, and a slow poll can't roll it back", async () => {
  const { api, buyer, supplier } = await filed();
  await buyer.propose("buyer", "full_refund", 0, 1000);
  await supplier.refresh();
  await supplier.propose("supplier", "split", 400, 600);
  const reloaded = new AgreementSession(api, ORDER, device("buyer"));
  await reloaded.refresh();
  assert.deepEqual(reloaded.state, await api.get(ORDER));
  const v = viewFor(reloaded.state!, "buyer", escrow());
  assert.deepEqual([v.current!.version, v.waitingOn, v.canRespond], [2, "buyer", true]);

  const older = { ...reloaded.state!, revision: reloaded.state!.revision - 1, offers: [] };
  const slow: AgreementApi = { get: async () => older, send: api.send.bind(api), confirmClaim: api.confirmClaim.bind(api), recheckSettlement: api.recheckSettlement.bind(api) };
  const s2 = new AgreementSession(slow, ORDER, device("buyer"));
  s2.state = reloaded.state;
  await s2.refresh();
  assert.equal(s2.state!.offers.length, 2);
});

test("settlement: nothing is settled before the server confirms it; a sent one blocks another; only a proven failure allows a fresh one", async () => {
  const { api, buyer, supplier } = await filed();
  await buyer.propose("buyer", "split", 250, 750);
  await supplier.refresh();
  await supplier.respond("supplier", reviewedFrom(supplier.state!, currentOffer(supplier.state!)!), true);
  const st = supplier.state!;
  const reviewed = reviewedFrom(st, currentOffer(st)!);
  assert.equal(viewFor(st, "supplier", escrow()).phase, "agreed");
  const plan = settlePlan(st, escrow(), reviewed);
  assert.deepEqual(plan.ok && [plan.toSupplier, plan.toBuyer], [250, 750]);
  assert.equal(settlePlan(st, escrow({ refundedMinor: 100 }), reviewed).ok, false, "devnet no longer holds the amount");

  // The signature is recorded (signed by whichever party's wallet is connected) before broadcast.
  const offerId = currentOffer(st)!.id;
  assert.ok(await supplier.write({ action: "record_settlement", as: "supplier", offerId, signature: "settleSig1", lastValidBlockHeight: 99 }));
  assert.equal(viewFor(supplier.state!, "supplier", escrow()).phase, "settling");
  assert.equal(settlePlan(supplier.state!, escrow(), reviewed).ok, false);
  await buyer.refresh();
  await buyer.write({ action: "record_settlement", as: "buyer", offerId, signature: "settleSig2", lastValidBlockHeight: 99 });
  assert.match(buyer.notice!.text, /already sent and could still move funds/);

  api.nextSettleOutcome = { status: "unknown", error: "RPC down" };
  await api.recheckSettlement(ORDER, "settleSig1");
  await buyer.refresh();
  assert.equal(viewFor(buyer.state!, "buyer", escrow()).phase, "settling", "unknown is not success");

  api.nextSettleOutcome = { status: "failed", error: "Expired without landing" };
  await api.recheckSettlement(ORDER, "settleSig1");
  await buyer.refresh();
  assert.equal(viewFor(buyer.state!, "buyer", escrow()).phase, "agreed");
  assert.equal(settlePlan(buyer.state!, escrow(), reviewedFrom(buyer.state!, currentOffer(buyer.state!)!)).ok, true, "fresh signatures allowed");

  await buyer.write({ action: "record_settlement", as: "buyer", offerId, signature: "settleSig3", lastValidBlockHeight: 150 });
  api.nextSettleOutcome = { status: "confirmed", error: null };
  await api.recheckSettlement(ORDER, "settleSig3");
  await buyer.refresh();
  assert.equal(viewFor(buyer.state!, "buyer", escrow()).phase, "settled");
  assert.deepEqual(buyer.state!.settlement!.attempts.map((a) => [a.signature, a.status]), [["settleSig1", "failed"], ["settleSig3", "confirmed"]]);
});

test("error classes: unavailable server, conflicts, wrong wallet, gateway errors", async () => {
  assert.equal(isUnavailable(new ApiRequestError("Request failed (404)", 404)), true);
  assert.equal(isUnavailable(new ApiRequestError("Order x not found", 404, "not_found")), false);
  assert.equal(isConflict(new ApiRequestError("changed", 409, "conflict")), true);
  assert.equal(isWrongWallet(new ApiRequestError("must be signed by", 401, "unauthorized")), true);
  assert.equal(isNetwork(new ApiRequestError("Request failed (504)", 504)), true);
  assert.equal(isNetwork(new ApiRequestError("Solana RPC unavailable", 503, "upstream_error")), false);

  const missing: AgreementApi = {
    get: () => Promise.reject(new ApiRequestError("Request failed (404)", 404)),
    send: () => Promise.reject(new ApiRequestError("Request failed (404)", 404)),
    confirmClaim: () => Promise.reject(new ApiRequestError("Request failed (404)", 404)),
    recheckSettlement: () => Promise.reject(new ApiRequestError("Request failed (404)", 404)),
  };
  const s = new AgreementSession(missing, ORDER, device("buyer"));
  await s.refresh();
  assert.equal(s.status, "unavailable");
  s.state = { orderId: ORDER, revision: 1, claim: null, offers: [], currentOfferId: null, nextActor: null, settlement: null, remedy: null };
  await s.propose("buyer", "full_refund", 0, 1000);
  assert.equal(s.notice?.text, UNAVAILABLE);
});

test("a failed fresh read before signing fails closed even when older state is shown", async () => {
  const { api, buyer } = await filed();
  assert.equal(await buyer.refresh(), true);
  const down: AgreementApi = { ...api, get: async () => { throw new ApiRequestError("Network down", 0); }, send: api.send.bind(api), confirmClaim: api.confirmClaim.bind(api), recheckSettlement: api.recheckSettlement.bind(api) };
  const s = new AgreementSession(down, ORDER, device("buyer"));
  s.state = buyer.state;
  assert.equal(await s.refresh(), false); // the precheck throws on false, so nothing is signed
  assert.ok(s.state); // the stale state is still shown, but it isn't trusted for signing
});

test("the scan suggests, the buyer confirms: an override needs a reason and is saved next to the suggestion", async () => {
  const api = new SimulatedAgreementApi();
  const buyer = new AgreementSession(api, ORDER, device("buyer"));
  await buyer.refresh();
  // The scan saw unit 2, but the buyer claims it as damaged.
  const lines = reviewedLines.map((l) => (l.id === "A-2" ? { ...l, claim: true } : l));
  assert.equal(missingReason(lines), true);
  const withReason = lines.map((l) => (l.id === "A-2" ? { ...l, reason: " bag torn " } : l));
  assert.equal(missingReason(withReason), false);
  const w = claimWrite(buyer.state!, detail, withReason, { scanId: "scan_1", revision: 3 });
  assert.ok(w.action === "prepare_claim");
  assert.deepEqual(
    w.decisions.map((d) => [d.suggested, d.decided, d.overrideReason]),
    [["accept", "accept", null], ["accept", "claim", "bag torn"], ["claim", "claim", null]],
  );
  assert.equal(w.claimedMinor, 2000);
  assert.ok(await buyer.write(w));
  assert.equal((await api.get(ORDER)).claim?.decisions[1].overrideReason, "bag torn");
});

test("the first offer is pre-filled from the signed remedy schedule, with its per-line basis", async () => {
  const { buyer } = await filed({ missing: 60, damaged: 100, wrong_item: 100 });
  const r = buyer.state!.remedy!;
  assert.deepEqual([r.termsVersion, r.toBuyerMinor, r.toSupplierMinor], [2, 600, 400]);
  assert.deepEqual(r.basis, [{ description: "Product A · unit 3", reason: "missing", claimedMinor: 1000, refundPercent: 60, refundMinor: 600 }]);
  assert.deepEqual(remedyPrefill(r, 1000), { kind: "split", toSupplierMinor: 400 });
  assert.equal(remedyPrefill(r, 999), null, "a schedule that doesn't fit what devnet holds isn't pre-filled");
  assert.equal(remedyPrefill(null, 1000), null);
  assert.equal(remedyPrefill({ ...r, toBuyerMinor: 1000, toSupplierMinor: 0 }, 1000)!.kind, "full_refund");
  assert.equal(remedyPrefill({ ...r, toBuyerMinor: 0, toSupplierMinor: 1000 }, 1000)!.kind, "full_release");
  // The pre-fill is only an offer: nothing is proposed or paid until a party signs one.
  assert.equal(buyer.state!.offers.length, 0);
});

test("offers refunding less than the schedule are flagged, and still accepted when both sign", async () => {
  const { buyer, supplier } = await filed({ missing: 60, damaged: 100, wrong_item: 100 });
  const r = buyer.state!.remedy;
  assert.match(belowSchedule(500, r)!, /^Below the signed remedy schedule \(terms v2\): \$1\.00 less back to the buyer than the schedule's \$6\.00\.$/);
  assert.equal(belowSchedule(600, r), null);
  assert.equal(belowSchedule(1000, r), null);
  await supplier.propose("supplier", "split", 500, 500);
  await buyer.refresh();
  await buyer.respond("buyer", reviewedFrom(buyer.state!, currentOffer(buyer.state!)!), true);
  assert.equal(currentOffer(buyer.state!)!.status, "accepted");
});

test("no signed schedule (legacy or pre-schedule terms, or reason other) means no remedy and no flag, not an error", async () => {
  const { buyer } = await filed();
  assert.equal(buyer.state!.remedy, null);
  assert.equal(belowSchedule(0, buyer.state!.remedy), null);

  const api = new SimulatedAgreementApi();
  api.schedule = { remedies: { missing: 100, damaged: 100, wrong_item: 100 }, termsVersion: 1 };
  const s = new AgreementSession(api, ORDER, device("buyer"));
  await s.refresh();
  const w = claimWrite(s.state!, detail, reviewedLines, { scanId: "scan_1", revision: 3 });
  assert.ok(w.action === "prepare_claim");
  await s.write({ ...w, lines: w.lines.map((l) => ({ ...l, reason: "other" as const })) });
  await api.confirmClaim(ORDER, "claimSig");
  await s.refresh();
  assert.equal(s.state!.remedy, null);
});
