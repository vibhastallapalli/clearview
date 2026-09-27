import type { Comparison, ProofAssessment, ScanResult } from "@cleardock/shared";
import type { MockScenario } from "./ai/analyze.ts";

/** What the AI workstream receives for one phone photo. Everything is data, never instructions. */
export interface AssessPhoneProofInput {
  proofId: string;
  captureId: string;
  image: Buffer;
  mimeType: string;
  /** The authoritative station evidence the photo is checked against. */
  stationScan: ScanResult;
  comparison: Comparison;
  mockScenario?: MockScenario;
}

/** The server adds status, error and assessedAt. Throw on a model failure; the server records it as "failed". */
export type AssessPhoneProofOutput = Pick<
  ProofAssessment,
  "verdict" | "coverage" | "findings" | "observed" | "untrustedText" | "summary" | "analyzedBy" | "model"
>;

// ponytail: stub until the AI workstream ships assessPhoneProof in server/src/ai/analyze.ts; then import it here.
export async function assessPhoneProof(_input: AssessPhoneProofInput): Promise<AssessPhoneProofOutput> {
  throw new Error("Phone proof assessment isn't available yet (AI workstream). The photo is saved for the supplier.");
}
