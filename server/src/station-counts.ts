import { HttpError } from "./solana/payments.ts";

/** Aggregate YOLO counts as the station posts them (form fields totalCount, normalCount, damagedCount). */
export interface YoloCounts {
  total: number;
  normal: number;
  damaged: number;
}

const FIELDS = { total: "totalCount", normal: "normalCount", damaged: "damagedCount" } as const;

/**
 * Null when the post carries none of the YOLO fields. Otherwise all three must be nonnegative integers
 * with total = normal + damaged, or it throws 400. Counts carry no product class or confidence.
 */
export function parseYoloCounts(body: Record<string, unknown>): YoloCounts | null {
  if (Object.values(FIELDS).every((f) => body[f] === undefined)) return null;
  const counts = {} as YoloCounts;
  for (const [k, f] of Object.entries(FIELDS) as [keyof YoloCounts, string][]) {
    const raw = body[f];
    const n = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    if (!Number.isSafeInteger(n)) throw new HttpError(400, "bad_request", `${f} must be a nonnegative whole number, got ${JSON.stringify(raw ?? null)}`);
    counts[k] = n;
  }
  if (counts.normal + counts.damaged !== counts.total)
    throw new HttpError(400, "bad_request", `totalCount ${counts.total} must equal normalCount ${counts.normal} + damagedCount ${counts.damaged}`);
  return counts;
}

/**
 * The YOLO counts name no product class, and hardware hasn't confirmed a class-to-SKU mapping, so ClearDock
 * can't tell which product was seen. Refused for this release rather than guessed; see
 * samples/detector (branch ai/detector-csv) for the per-item detector format planned instead.
 */
export const YOLO_DISABLED =
  "YOLO station counts are disabled in this release: the detections carry no confirmed product class, so ClearDock can't map them to an ordered product. Nothing was recorded. Send the photo without count fields, or wait for the detector CSV integration.";
