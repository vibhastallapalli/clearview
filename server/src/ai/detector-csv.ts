import { createHash } from "node:crypto";
import type { ObservedItem, ScanResult } from "@cleardock/shared";

// Proposed types stay local until the integrator accepts the shared contract.
export type Condition = "intact" | "damaged" | "unknown";
export interface DetectorConfig {
  version: string;
  delimiter: "," | ";" | "\t";
  columns: { itemId: string; classId: string; confidence: string; damage: string };
  damageValues: Record<string, Condition>;
  minConfidence: number;
  model: { name: string; version: string };
}
export interface DetectorMetadata {
  format: "cleardock.csv.v1";
  orderId: string;
  imageSha256: string;
  csvSha256: string;
  model: { name: string; version: string };
  rowCount: number;
  frames: 1;
  complete: true;
  emptyTray: boolean;
  synthetic: boolean;
}
export interface DetectorItem {
  itemId: string;
  classId: string;
  sku: string | null;
  confidence: number;
  condition: Condition;
}
export interface DetectorProvenance extends DetectorMetadata {
  mappingVersion: string;
  configSha256: string;
  catalogSha256: string;
}
export interface DetectorResult {
  observed: (ObservedItem & { damagedCount: number })[];
  unreadable: string[];
  notes: string;
  detector: DetectorProvenance;
  items: DetectorItem[];
}
export type DetectorScan = Omit<ScanResult, "analyzedBy" | "observed"> & DetectorResult & { analyzedBy: "detector" };
export interface DetectorProduct { sku: string; detectorClasses?: string[] }
export class DetectorError extends Error {}
const fail = (s: string): never => { throw new DetectorError(`Detector CSV rejected: ${s}`); };
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 200;
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const MAX_BYTES = 1_000_000;
const MAX_ROWS = 500;

/** Strict CSV: quoted cells, escaped quotes and CRLF; no ragged/blank rows or quote recovery. */
function parseCsv(input: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, closed = false;
  const field = () => { row.push(cell); cell = ""; closed = false; };
  const record = () => {
    field(); rows.push(row); row = [];
    if (rows.length > MAX_ROWS + 1) fail("too many rows");
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === delimiter) field();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[++i] !== "\n") fail("bare CR");
      record();
    } else if (closed) fail("text after closing quote");
    else if (c === '"') {
      if (cell !== "") fail("quote inside unquoted cell");
      quoted = true;
    } else cell += c;
  }
  if (quoted) fail("unterminated quote");
  if (cell !== "" || row.length || closed) record();
  return rows;
}

/** No mutation and no partial return: all structural checks finish before aggregation. */
export function adaptDetectorCsv(
  bytes: Buffer,
  rawMetadata: unknown,
  expected: { orderId: string; image: Buffer },
  config: DetectorConfig,
  catalog: DetectorProduct[],
): DetectorResult {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BYTES) fail("file must be 1..1000000 bytes");
  if (!config || !text(config.version) || ![",", ";", "\t"].includes(config.delimiter)
    || !Number.isFinite(config.minConfidence) || config.minConfidence < 0 || config.minConfidence > 1
    || !text(config.model?.name) || !text(config.model?.version)) fail("invalid server configuration");
  const columnNames = config.columns && [config.columns.itemId, config.columns.classId, config.columns.confidence, config.columns.damage];
  if (!columnNames || columnNames.some((x) => !text(x)) || new Set(columnNames).size !== 4) fail("invalid column mapping");
  if (!config.damageValues || Object.entries(config.damageValues).some(([k, v]) => !text(k) || !["intact", "damaged", "unknown"].includes(v))) fail("invalid damage mapping");
  const m = rawMetadata as DetectorMetadata;
  if (!m || m.format !== "cleardock.csv.v1" || !text(m.orderId) || m.orderId !== expected.orderId) fail("wrong format or order");
  if (!/^[a-f0-9]{64}$/.test(m.imageSha256) || m.imageSha256 !== hash(expected.image)) fail("wrong image hash");
  if (!/^[a-f0-9]{64}$/.test(m.csvSha256) || m.csvSha256 !== hash(bytes)) fail("wrong CSV hash");
  if (m.model?.name !== config.model.name || m.model?.version !== config.model.version) fail("unapproved model name/version");
  if (m.frames !== 1 || m.complete !== true) fail("one complete frame is required; multi-frame CSV is unsupported");
  if (!Number.isSafeInteger(m.rowCount) || m.rowCount < 0 || m.rowCount > MAX_ROWS
    || typeof m.emptyTray !== "boolean" || typeof m.synthetic !== "boolean") fail("invalid metadata");
  const classMap = new Map<string, string>();
  const skus = new Set<string>();
  for (const product of catalog) {
    if (!text(product.sku) || skus.has(product.sku)) fail("invalid or duplicate catalog SKU");
    skus.add(product.sku);
    if (product.detectorClasses !== undefined && !Array.isArray(product.detectorClasses)) fail("invalid detectorClasses");
    for (const cls of product.detectorClasses ?? []) {
      if (!text(cls) || classMap.has(cls)) fail("invalid or duplicate detector class");
      classMap.set(cls, product.sku);
    }
  }
  let csv: string;
  try { csv = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return fail("invalid UTF-8"); }
  if (csv.includes("\0")) fail("NUL byte");
  const [header, ...rows] = parseCsv(csv, config.delimiter);
  if (!header || header.some((x) => !text(x)) || new Set(header).size !== header.length || columnNames.some((x) => !header.includes(x))) fail("missing or duplicate headers");
  if (rows.length !== m.rowCount || (m.emptyTray && rows.length !== 0)) fail("row count or empty-tray contradiction");
  const positions = columnNames.map((x) => header.indexOf(x));
  const ids = new Set<string>();
  const items: DetectorItem[] = rows.map((row, index) => {
    if (row.length !== header.length) fail(`ragged row ${index + 2}`);
    const [itemId, classId, score, damage] = positions.map((i) => row[i]);
    if (!text(itemId) || ids.has(itemId)) fail(`invalid or duplicate item ID on row ${index + 2}`);
    ids.add(itemId);
    if (!text(classId)) fail(`missing class on row ${index + 2}`);
    if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(score)) fail(`confidence must be a decimal in 0..1 on row ${index + 2}`);
    if (!Object.hasOwn(config.damageValues, damage)) fail(`unmapped damage encoding on row ${index + 2}`);
    return { itemId, classId, confidence: Number(score), condition: config.damageValues[damage], sku: classMap.get(classId) ?? null };
  });
  const unreadable: string[] = [];
  const observed: DetectorResult["observed"] = [];
  for (const item of items) {
    if (item.confidence < config.minConfidence || item.sku === null || item.condition === "unknown") {
      unreadable.push(`Item ${item.itemId}: ${item.confidence < config.minConfidence ? "low confidence" : item.sku === null ? "unknown class" : "unknown damage"}. Review required.`);
      continue;
    }
    let group = observed.find((x) => x.sku === item.sku);
    if (!group) {
      group = { sku: item.sku, labelText: item.sku!, count: 0, damagedCount: 0, confidence: item.confidence };
      observed.push(group);
    }
    group.count++;
    group.damagedCount += Number(item.condition === "damaged");
    group.confidence = Math.min(group.confidence, item.confidence);
  }
  if (items.length === 0 && !m.emptyTray) unreadable.push("Zero detections without an explicit empty-tray result. Review required.");
  // Copy only contract fields, never arbitrary metadata or injected authority fields.
  const detector: DetectorProvenance = {
    format: m.format, orderId: m.orderId, imageSha256: m.imageSha256, csvSha256: m.csvSha256,
    model: { name: m.model.name, version: m.model.version }, rowCount: m.rowCount,
    frames: 1, complete: true, emptyTray: m.emptyTray, synthetic: m.synthetic,
    mappingVersion: config.version, configSha256: hash(JSON.stringify(config)), catalogSha256: hash(JSON.stringify(catalog)),
  };
  return { observed, unreadable, items, detector,
    notes: `${m.synthetic ? "SYNTHETIC fixture. " : ""}Detector ${m.model.name}@${m.model.version}; ${rows.length} item rows.` };
}
