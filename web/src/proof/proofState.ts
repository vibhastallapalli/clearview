import type { PhoneProof, ProofCoverage } from "@cleardock/shared";

export type Tone = "ok" | "warn" | "bad" | "info";

/** What the UI shows for one phone proof. Derived only from the saved proof and the order's current station scan. */
export type ProofState =
  | "pending" // assessment still running on the server
  | "stalled" // still pending long after upload: the server likely stopped mid-assessment
  | "failed" // model call failed; the photo is saved but not assessed
  | "insufficient_evidence"
  | "supports"
  | "contradicts";

export interface ProofDisplay {
  state: ProofState;
  label: string;
  tone: Tone;
  /** Assessed against an earlier station scan than the one the order uses now. */
  historical: boolean;
  /** Mock AI result, not a real model reading of the photo. */
  mock: boolean;
  /** The buyer can take another photo; there is no server-side retry, so a retry is a new proof. */
  canRetry: boolean;
  coverage: string | null;
}

/** A pending assessment older than this is shown as stalled rather than as still running. */
export const STALLED_AFTER_MS = 3 * 60 * 1000;

const COVERAGE: Record<ProofCoverage, string> = {
  full_shipment: "Shows the whole delivery",
  partial: "Shows part of the delivery; counts are for the photo only",
  none: "Doesn't show the delivery",
};

export function proofDisplay(proof: PhoneProof, latestScanId: string | null, nowMs: number): ProofDisplay {
  const a = proof.assessment;
  const historical = proof.stationScanId !== latestScanId;
  const mock = a.analyzedBy === "mock";
  const coverage = a.coverage ? COVERAGE[a.coverage] : null;
  const base = { historical, mock, coverage };

  if (a.status === "pending") {
    const stalled = nowMs - Date.parse(proof.createdAt) > STALLED_AFTER_MS;
    return stalled
      ? { ...base, state: "stalled", label: "Assessment didn't finish", tone: "warn", canRetry: true }
      : { ...base, state: "pending", label: "Assessing photo…", tone: "info", canRetry: false };
  }
  if (a.status === "failed") return { ...base, state: "failed", label: "Not assessed", tone: "bad", canRetry: true };
  // status "complete": a null verdict is treated as insufficient, never as support.
  switch (a.verdict) {
    case "supports":
      return { ...base, state: "supports", label: "Supports the station report", tone: "ok", canRetry: false };
    case "contradicts":
      return { ...base, state: "contradicts", label: "Contradicts the station report", tone: "bad", canRetry: false };
    default:
      return { ...base, state: "insufficient_evidence", label: "Not enough in the photo to tell", tone: "warn", canRetry: true };
  }
}

