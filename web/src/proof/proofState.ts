/** Attached to an earlier station scan than the one the order uses now. */
export const isHistorical = (proof: { stationScanId: string }, latestScanId: string | null) => proof.stationScanId !== latestScanId;

/** Live in-app photos vs uploaded files. Anything not explicitly "live" (including proofs saved before kind existed) is an upload. */
export function splitProofs<T extends { kind?: string }>(proofs: T[]): { live: T[]; uploads: T[] } {
  return { live: proofs.filter((p) => p.kind === "live"), uploads: proofs.filter((p) => p.kind !== "live") };
}
