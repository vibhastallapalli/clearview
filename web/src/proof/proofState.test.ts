import assert from "node:assert/strict";
import { test } from "node:test";
import type { PhoneProof, ProofAssessment } from "@cleardock/shared";
import { STALLED_AFTER_MS, proofDisplay } from "./proofState";

const CREATED = "2026-09-26T20:00:00.000Z";
const t0 = Date.parse(CREATED);

const pending: ProofAssessment = {
  status: "pending", verdict: null, coverage: null, findings: [], observed: [], untrustedText: [],
  summary: "Assessing the photo…", analyzedBy: null, model: null, error: null, assessedAt: null,
};
const proof = (a: Partial<ProofAssessment> = {}, stationScanId = "scan_1"): PhoneProof => ({
  id: "prf_1", orderId: "ord_1", captureId: "cap_p", imageSha256: "ab".repeat(32),
  stationScanId, stationCaptureId: "cap_s", evidenceRevision: 2,
  assessment: { ...pending, ...a }, createdAt: CREATED,
});

test("pending while the server assesses, stalled once it clearly stopped", () => {
  assert.equal(proofDisplay(proof(), "scan_1", t0 + 5_000).state, "pending");
  assert.equal(proofDisplay(proof(), "scan_1", t0 + 5_000).canRetry, false);
  const stalled = proofDisplay(proof(), "scan_1", t0 + STALLED_AFTER_MS + 1);
  assert.equal(stalled.state, "stalled");
  assert.equal(stalled.canRetry, true);
});

test("failed keeps the photo and offers a new photo as the retry", () => {
  const d = proofDisplay(proof({ status: "failed", error: "model down", assessedAt: CREATED }), "scan_1", t0);
  assert.equal(d.state, "failed");
  assert.equal(d.tone, "bad");
  assert.equal(d.canRetry, true);
});

test("complete verdicts map one to one; a missing verdict is never read as support", () => {
  const done = (verdict: ProofAssessment["verdict"]) =>
    proofDisplay(proof({ status: "complete", verdict, coverage: "partial", analyzedBy: "gemini" }), "scan_1", t0).state;
  assert.equal(done("supports"), "supports");
  assert.equal(done("contradicts"), "contradicts");
  assert.equal(done("insufficient_evidence"), "insufficient_evidence");
  assert.equal(done(null), "insufficient_evidence");
});

test("a proof checked against an older station scan is historical", () => {
  assert.equal(proofDisplay(proof({}, "scan_1"), "scan_1", t0).historical, false);
  assert.equal(proofDisplay(proof({}, "scan_1"), "scan_2", t0).historical, true);
  assert.equal(proofDisplay(proof({}, "scan_1"), null, t0).historical, true);
});

test("mock results are flagged so the UI labels them", () => {
  assert.equal(proofDisplay(proof({ status: "complete", verdict: "supports", analyzedBy: "mock" }), "scan_1", t0).mock, true);
  assert.equal(proofDisplay(proof({ status: "complete", verdict: "supports", analyzedBy: "gemini" }), "scan_1", t0).mock, false);
});
