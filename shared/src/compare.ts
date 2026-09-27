import type {
  Comparison,
  ComparisonLine,
  ComparisonOutcome,
  ExtractedDocument,
  LineItem,
  ScanResult,
} from "./contracts.ts";

/**
 * Deterministic three-way comparison: purchase order vs invoice vs observed delivery.
 *
 * This is ordinary code on purpose. AI output feeds in as structured data that
 * has already been validated; nothing here trusts free-form model text, and
 * nothing here moves money.
 */

/** Convert a line to a count of sellable units, or null if it can't be done exactly. */
export function toUnitCount(line: Pick<LineItem, "quantity" | "unit" | "unitSizeGrams">): number | null {
  if (line.unit === "bag" || line.unit === "box" || line.unit === "unit") return line.quantity;
  if (!line.unitSizeGrams || line.unitSizeGrams <= 0) return null;
  const grams = line.unit === "kg" ? line.quantity * 1000 : line.quantity;
  const count = grams / line.unitSizeGrams;
  // "1.5 kg" of 500 g bags is exactly 3 bags; 1.4 kg is not a whole number of bags.
  const rounded = Math.round(count);
  return Math.abs(count - rounded) < 1e-9 ? rounded : null;
}

interface Tally {
  sku: string | null;
  description: string;
  count: number | null;
  unitPriceMinor: number | null;
}

function tallyDocument(doc: ExtractedDocument | undefined): Map<string, Tally> {
  const out = new Map<string, Tally>();
  if (!doc) return out;
  for (const line of doc.lines) {
    const key = line.sku ?? `?${line.description}`;
    const count = toUnitCount(line);
    const prev = out.get(key);
    if (prev) {
      prev.count = prev.count === null || count === null ? null : prev.count + count;
    } else {
      out.set(key, {
        sku: line.sku,
        description: line.description,
        count,
        unitPriceMinor: line.unitPriceMinor,
      });
    }
  }
  return out;
}

function tallyScan(scan: ScanResult | undefined): Map<string, Tally> {
  const out = new Map<string, Tally>();
  if (!scan) return out;
  for (const item of scan.observed) {
    const key = item.sku ?? `?${item.labelText}`;
    const prev = out.get(key);
    if (prev) prev.count = (prev.count ?? 0) + item.count;
    else out.set(key, { sku: item.sku, description: item.labelText, count: item.count, unitPriceMinor: null });
  }
  return out;
}

const money = (minor: number) => `$${(minor / 100).toFixed(2)}`;

export interface CompareInput {
  orderId: string;
  evidenceRevision: number;
  purchaseOrder?: ExtractedDocument;
  invoice?: ExtractedDocument;
  scan?: ScanResult;
  now?: string;
}

export function compareOrder(input: CompareInput): Comparison {
  const po = tallyDocument(input.purchaseOrder);
  const inv = tallyDocument(input.invoice);
  const seen = tallyScan(input.scan);
  const haveScan = input.scan !== undefined;

  const keys = new Set<string>([...po.keys(), ...inv.keys(), ...seen.keys()]);
  const lines: ComparisonLine[] = [];

  for (const key of keys) {
    const o = po.get(key);
    const b = inv.get(key);
    const s = seen.get(key);
    const description = o?.description ?? b?.description ?? s?.description ?? key;
    const sku = o?.sku ?? b?.sku ?? s?.sku ?? null;
    const unitPriceMinor = o?.unitPriceMinor ?? b?.unitPriceMinor ?? 0;
    const ordered = o ? o.count : null;
    const billed = b ? b.count : null;
    const observed = haveScan ? (s ? s.count : 0) : null;

    let verdict: ComparisonLine["verdict"] = "match";
    let discrepancyMinor = 0;
    let explanation = "Ordered, billed and delivered quantities agree.";

    if (sku === null) {
      verdict = "unknown";
      explanation = `Could not map "${description}" to a known product. Needs review.`;
    } else if (!o) {
      if (b) {
        verdict = "billed_mismatch";
        discrepancyMinor = (b.count ?? 0) * (b.unitPriceMinor ?? 0);
        explanation = `Invoice bills ${b.count} × ${description}, which is not on the purchase order.`;
      } else {
        verdict = "unexpected";
        explanation = `${observed} × ${description} delivered but not ordered or billed.`;
      }
    } else if (ordered === null || (b && billed === null)) {
      verdict = "unknown";
      explanation = "Quantity could not be converted to whole units. Needs review.";
    } else if (!b) {
      verdict = "billed_mismatch";
      explanation = `${description} is on the purchase order but missing from the invoice.`;
    } else if (billed !== ordered) {
      verdict = "billed_mismatch";
      discrepancyMinor = Math.max(0, (billed! - ordered) * unitPriceMinor);
      explanation = `Invoice bills ${billed}, purchase order says ${ordered}.`;
    } else if (b.unitPriceMinor !== o.unitPriceMinor) {
      verdict = "price_mismatch";
      discrepancyMinor = Math.max(0, ((b.unitPriceMinor ?? 0) - (o.unitPriceMinor ?? 0)) * billed!);
      explanation = `Invoice unit price ${money(b.unitPriceMinor ?? 0)} differs from order price ${money(o.unitPriceMinor ?? 0)}.`;
    } else if (observed === null) {
      verdict = "unknown";
      explanation = "Paperwork agrees. Delivery not captured yet.";
    } else if (observed < billed!) {
      verdict = "missing";
      discrepancyMinor = (billed! - observed) * unitPriceMinor;
      explanation = `Billed ${billed}, observed ${observed}: ${billed! - observed} missing (${money(discrepancyMinor)}).`;
    } else if (observed > ordered) {
      verdict = "over";
      explanation = `Observed ${observed}, ordered ${ordered}.`;
    }

    lines.push({ sku, description, unitPriceMinor, ordered, billed, observed, verdict, discrepancyMinor, explanation });
  }

  const unreadable = input.scan?.unreadable.length ?? 0;
  const damagedCount = input.scan?.damagedCount ?? 0;
  const hasUnknown = lines.some((l) => l.verdict === "unknown");
  const hasIssue = lines.some((l) => l.verdict !== "match");
  const missingDocs = !input.purchaseOrder || !input.invoice;

  let outcome: ComparisonOutcome;
  if (missingDocs || !haveScan || hasUnknown || unreadable > 0) outcome = "needs_info";
  else if (hasIssue || damagedCount > 0) outcome = "discrepancy";
  else outcome = "match";

  const sum = (m: Map<string, Tally>) =>
    [...m.values()].reduce((acc, t) => acc + (t.count ?? 0) * (t.unitPriceMinor ?? 0), 0);

  const undisputedMinor = lines.reduce((acc, l) => {
    if (l.sku === null || l.ordered === null || l.billed === null || l.observed === null) return acc;
    if (l.verdict === "price_mismatch" || l.verdict === "billed_mismatch") return acc;
    return acc + Math.min(l.ordered, l.billed, l.observed) * l.unitPriceMinor;
  }, 0);

  return {
    orderId: input.orderId,
    evidenceRevision: input.evidenceRevision,
    outcome,
    lines,
    orderedTotalMinor: sum(po),
    billedTotalMinor: sum(inv),
    undisputedMinor,
    summary: summarize(outcome, lines, {
  missingDocs,
  haveScan,
  unreadable,
  damagedCount,
}),
    computedAt: input.now ?? new Date().toISOString(),
  };
}

function summarize(
  outcome: ComparisonOutcome,
  lines: ComparisonLine[],
  ctx: {
    missingDocs: boolean;
    haveScan: boolean;
    unreadable: number;
    damagedCount: number;
  },
): string {
  if (ctx.missingDocs) return "Upload the purchase order and invoice to compare.";
  if (!ctx.haveScan) return "Paperwork loaded. Capture the delivery to compare.";
  if (ctx.unreadable > 0)
    return `${ctx.unreadable} package(s) could not be read. Recapture or review manually.`;

  if (ctx.damagedCount > 0)
    return `${ctx.damagedCount} damaged item(s) detected. Manual review required.`;

  if (outcome === "match")
    return "Order, invoice and delivery agree. Ready for owner review.";

  const issues = lines
    .filter((l) => l.verdict !== "match")
    .map((l) => l.explanation);

  return issues.join(" ");
}