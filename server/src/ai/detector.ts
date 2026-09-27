import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ObservedItem, ScanResult } from "@cleardock/shared";

/**
 * Adapter for the station's custom can detector (hardware teammate's model).
 *
 * The detector counts; this code only validates and maps its output to SKUs.
 * Nothing here compares against the order or touches money: the result feeds
 * compareOrder() exactly like a Gemini ScanResult does.
 *
 * Input format: docs/detector-contract.md ("cleardock.detections.v0", PROVISIONAL
 * until the hardware teammate confirms their real output).
 */

/** Detections below this are never counted, only reported for review. */
// ponytail: one global threshold; per-class thresholds once real captures show which classes need them.
export const MIN_CONFIDENCE = 0.6;
const MAX_FRAMES = 30;

export interface CatalogProduct {
  sku: string;
  detectorClasses?: string[];
}

export interface DetectorProvenance {
  model: string;
  frames: number;
  latencyMs: number | null;
  /** True for hand-written fixtures. The UI must label these SYNTHETIC. */
  synthetic: boolean;
}

export type DetectorScan = Pick<ScanResult, "observed" | "unreadable" | "notes"> & { detector: DetectorProvenance };

const here = dirname(fileURLToPath(import.meta.url));
const defaultCatalog = (): CatalogProduct[] =>
  JSON.parse(readFileSync(join(here, "..", "..", "..", "shared", "fixtures", "products.json"), "utf8"));

function fail(msg: string): never {
  throw new Error(`Detector output rejected: ${msg}`);
}
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function classMap(catalog: CatalogProduct[]) {
  const map = new Map<string, string>();
  for (const p of catalog)
    for (const c of p.detectorClasses ?? []) {
      if (map.has(c)) throw new Error(`Catalog maps detector class "${c}" to two SKUs`);
      map.set(c, p.sku);
    }
  return map;
}

/**
 * Validate one detector result and turn it into scan observations.
 *
 * - `expect` binds the result to the order and the exact photo stored as evidence;
 *   a result for another order or another image is rejected, never merged.
 * - Several frames of the same tray are views of the SAME cans: counts must agree
 *   frame to frame and are never added. Disagreement goes to review.
 * - Unknown classes keep their count with sku null; low-confidence detections and
 *   empty frames go to `unreadable`. Both make the comparison "needs_info".
 */
export function adaptDetections(
  raw: unknown,
  expect: { orderId: string; imageSha256: string },
  catalog: CatalogProduct[] = defaultCatalog(),
): DetectorScan {
  const v = raw as any;
  if (!v || typeof v !== "object") fail("not an object");
  if (v.format !== "cleardock.detections.v0") fail(`unknown format ${JSON.stringify(v.format)}`);
  if (!nonEmpty(v.model?.name) || !nonEmpty(v.model?.version)) fail("model name and version are required");
  if (v.orderId !== expect.orderId) fail(`result is for order ${JSON.stringify(v.orderId)}, not ${expect.orderId}`);
  if (v.imageSha256 !== expect.imageSha256) fail("imageSha256 does not match the uploaded photo");
  if (v.latencyMs != null && !(Number.isFinite(v.latencyMs) && v.latencyMs >= 0)) fail("bad latencyMs");
  if (!Array.isArray(v.frames) || v.frames.length === 0 || v.frames.length > MAX_FRAMES)
    fail(`frames must be a list of 1 to ${MAX_FRAMES}`);

  // Per frame: confident count per class, and the most uncertain detections seen per class.
  const confident = v.frames.map((f: any) => {
    if (!f || !Array.isArray(f.detections)) fail("frame without detections list");
    const counts = new Map<string, number>();
    for (const d of f.detections) {
      if (!nonEmpty(d?.classId)) fail("detection without classId");
      if (!Number.isFinite(d.confidence) || d.confidence < 0 || d.confidence > 1) fail("confidence must be 0..1");
      if (d.confidence >= MIN_CONFIDENCE) counts.set(d.classId, (counts.get(d.classId) ?? 0) + 1);
    }
    return counts;
  }) as Map<string, number>[];
  const uncertain = new Map<string, number>();
  for (const f of v.frames) {
    const perFrame = new Map<string, number>();
    for (const d of f.detections)
      if (d.confidence < MIN_CONFIDENCE) perFrame.set(d.classId, (perFrame.get(d.classId) ?? 0) + 1);
    for (const [c, n] of perFrame) uncertain.set(c, Math.max(uncertain.get(c) ?? 0, n));
  }

  const skus = classMap(catalog);
  const classes = new Set(confident.flatMap((m) => [...m.keys()]));
  const observed: ObservedItem[] = [];
  const unreadable: string[] = [];

  for (const cls of classes) {
    const counts = confident.map((m) => m.get(cls) ?? 0);
    if (counts.some((n) => n !== counts[0])) {
      unreadable.push(`Detector frames disagree on "${cls}" (${counts.join(", ")}). Recapture or count manually.`);
      continue;
    }
    observed.push({ sku: skus.get(cls) ?? null, labelText: `detector class "${cls}"`, count: counts[0], confidence: 1 });
  }
  for (const [cls, n] of uncertain)
    unreadable.push(`${n} low-confidence detection(s) of "${cls}" (below ${MIN_CONFIDENCE}). Not counted; review manually.`);
  if (observed.length === 0 && unreadable.length === 0)
    unreadable.push("Detector found no cans. Empty or irrelevant frame: recapture or review.");

  const detector: DetectorProvenance = {
    model: `${v.model.name}@${v.model.version}`,
    frames: v.frames.length,
    latencyMs: v.latencyMs ?? null,
    synthetic: v.synthetic === true,
  };
  const notes = `${detector.synthetic ? "SYNTHETIC FIXTURE, not a real detector run. " : ""}Detector ${detector.model}, ${detector.frames} frame(s).`;
  // confidence 1 = the frames agree on this count; per-detection scores are gated above, not averaged.
  return { observed, unreadable, notes, detector };
}

/**
 * Optional cross-check when Gemini also reads the same station photo's labels.
 * Gemini never overrides or fills in detector counts: any per-SKU difference
 * becomes a review item, whichever side would have produced a match.
 */
export function crossCheck(detector: ObservedItem[], gemini: ObservedItem[]): string[] {
  const tally = (items: ObservedItem[]) => {
    const m = new Map<string, number>();
    for (const i of items) m.set(i.sku ?? `?${i.labelText}`, (m.get(i.sku ?? `?${i.labelText}`) ?? 0) + i.count);
    return m;
  };
  const d = tally(detector);
  const g = tally(gemini);
  const out: string[] = [];
  for (const key of new Set([...d.keys(), ...g.keys()]))
    if ((d.get(key) ?? 0) !== (g.get(key) ?? 0))
      out.push(`Detector and Gemini label reading disagree on ${key}: detector ${d.get(key) ?? 0}, Gemini ${g.get(key) ?? 0}. Review manually.`);
  return out;
}
