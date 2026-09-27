import type { AnalysisSource, Order, ScanResult } from "@cleardock/shared";

/** The only order data the demo needs; both OrderDetail and a queue row satisfy it. */
export type OrderLike = { order: Order; latestScan?: ScanResult | null };

// Client-side model of the escrow page up to the claim (docs/escrow-rulebook.md). Every money movement
// is a SignRequest with `chain`: a real devnet transaction to the escrow program (sign.ts). Settlement
// offers are NOT kept here: they live on the server (web/src/agreement), so both devices see one agreement.
// What this file stores in the browser is only this viewer's progress through the screens.

export type Role = "buyer" | "supplier";
/** claimed = the claim transaction is on devnet; negotiation continues in the shared agreement. */
export type Step = "delivered" | "scanning" | "report" | "claimed" | "settled";
export type EscrowStatus = "funded" | "claimed" | "settlement_proposed" | "settled" | "released";

export interface Line {
  id: string;
  label: string;
  sub: string;
  priceMinor: number;
  claim: boolean;
  /** Not seen on the station scan, so the scan suggests claiming it. The buyer confirms or overrides. */
  miss: boolean;
  /** Why the buyer overrode the scan suggestion. Required when claim !== miss. */
  reason?: string;
  /** The claim reason if claimed: the station saw it damaged, or didn't see it. */
  issue?: "missing" | "damaged";
}

export interface EscrowEvent {
  label: string;
  detail: string;
  at: string;
  sig?: string;
  sim?: boolean;
}

export interface Outcome {
  title: string;
  label?: string;
  sup: number;
  buy: number;
  sig: string;
  simulated: boolean;
  claim: number;
}

export interface DemoState {
  step: Step;
  lines: Line[];
  outcome: Outcome | null;
  events: EscrowEvent[];
  esc: { released: number; refunded: number; locked: number; status: EscrowStatus };
  /** The station evidence the current lines were reviewed from. Null for the SIMULATED demo scan. */
  linesFrom?: Evidence | null;
}

/** Which station scan and evidence revision a set of lines (and any transaction from them) came from. */
export interface Evidence {
  scanId: string;
  revision: number;
}

export interface Tx {
  sig: string;
  simulated: boolean;
}

/** An escrow program instruction. Amounts are CDT minor units (cents). */
export type ChainAction =
  | { action: "fund"; amount: number }
  | { action: "accept_all" }
  | { action: "claim"; accepted: number; claimed: number }
  | { action: "settle"; toSupplier: number; toBuyer: number };

export interface SignRequest {
  title: string;
  rows: [string, string][];
  /** Set = a real devnet transaction. Unset = simulated off-chain step. */
  chain?: ChainAction;
  /** Set when the amounts come from reviewed station lines: re-checked against the order just before signing. */
  evidence?: Evidence;
  /** Runs right before anything is signed (and again on "Try again"). Throw to refuse with a message. */
  precheck?: () => Promise<void>;
  /** Runs with the signed transaction's signature before broadcast; if it throws, nothing is sent. */
  beforeSend?: (signature: string, lastValidBlockHeight: number) => Promise<void>;
  /** Runs after the transaction is confirmed and recorded. A failure here is shown, but the transaction stands. */
  confirmed?: (tx: Tx) => Promise<void>;
  /** Called when a transaction was sent but its outcome is unknown or it failed after broadcast. */
  sendFailed?: (signature: string, outcome: "unknown" | "failed", message: string) => void;
  apply: (tx: Tx, st: DemoState) => Partial<DemoState>;
}

export const PARTY: Record<Role, { name: string; wallet: string; role: string }> = {
  buyer: { name: "Café Luma", wallet: "7xKX…q9Pd", role: "Buyer" },
  supplier: { name: "Tostadores del Norte", wallet: "9fQe…Lk2M", role: "Supplier" },
};

export const HISTORY: Record<Role, { base: number; of: number; expired: number; rows: HistoryRow[] }> = {
  supplier: {
    base: 1,
    of: 14,
    expired: 0,
    rows: [{ ref: "PO-0987", what: "Shortage · 1 line · $12.00", outcome: "Split", time: "Resolved in 1 d 4 h" }],
  },
  buyer: {
    base: 2,
    of: 19,
    expired: 1,
    rows: [
      { ref: "PO-0987", what: "Shortage · 1 line · $12.00", outcome: "Split", time: "Resolved in 1 d 4 h" },
      { ref: "PO-0941", what: "Damaged · 1 line · $8.00", outcome: "Replacement", time: "Resolved in 2 d 1 h" },
    ],
  },
};

export interface HistoryRow {
  ref: string;
  what: string;
  outcome: string;
  time: string;
}

export const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;
export const shortSig = (s: string) => `${s.slice(0, 5)}…${s.slice(-5)}`;
export const txUrl = (s: string) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;
const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** Who produced an AI result, in words. A cached result is an earlier real answer replayed, not a live call. */
export const AI_SOURCE: Record<AnalysisSource, string> = {
  gemini: "Gemini",
  cache: "Cached Gemini result",
  mock: "Mock AI",
  yolo: "Station detector (YOLO)",
};

/** One escrow line per ordered unit, from the real comparison when there is one. */
export function linesFor(detail: OrderLike | null): Line[] {
  return scanLines(detail) ?? DEMO_LINES;
}

/** Lines from a real scan compared against the PO/invoice, or null if there's nothing to compare. */
export function scanLines(detail: OrderLike | null): Line[] | null {
  const c = detail?.order.comparison;
  if (c && detail?.order.latestScanId) {
    const lines: Line[] = [];
    for (const l of c.lines) {
      const ordered = l.ordered ?? 0;
      // Units in order: seen intact, then seen damaged, then not seen. The scan suggests claiming the last two.
      const observed = l.observed ?? 0;
      const intact = observed - Math.min(l.damaged ?? 0, observed);
      for (let i = 1; i <= ordered; i++) {
        const issue = i <= intact ? null : i <= observed ? "damaged" : "missing";
        lines.push({
          id: `${l.sku ?? l.description}-${i}`,
          label: `${l.description} · unit ${i}`,
          sub: issue === null ? "Seen on scan · intact" : issue === "damaged" ? "Seen on scan · damaged" : "Not seen on scan",
          priceMinor: l.unitPriceMinor,
          claim: issue !== null,
          miss: issue !== null,
          ...(issue ? { issue } : {}),
        });
      }
    }
    if (lines.length) return lines;
  }
  return null;
}

const DEMO_LINES: Line[] = [
    { id: "a1", label: "Product A · bag 1", sub: "Seen on scan · label matches", priceMinor: 1000, claim: false, miss: false },
    { id: "a2", label: "Product A · bag 2", sub: "Seen on scan · label matches", priceMinor: 1000, claim: false, miss: false },
    { id: "a3", label: "Product A · bag 3", sub: "Not seen · a Product B bag arrived instead", priceMinor: 1000, claim: true, miss: true },
];

export const totalOf = (lines: Line[]) => lines.reduce((sum, l) => sum + l.priceMinor, 0);
/** The scan recommends, the buyer confirms: a line differs from the suggestion when claim !== miss. */
export const overridden = (l: Line) => l.claim !== l.miss;
export const missingReason = (lines: Line[]) => lines.some((l) => overridden(l) && !l.reason?.trim());
export const OVERRIDE_REASON = "Give a reason for each line you changed from the station suggestion.";

export const claimedOf = (lines: Line[]) => lines.filter((l) => l.claim).reduce((sum, l) => sum + l.priceMinor, 0);

export function initialState(detail: OrderLike | null): DemoState {
  const lines = linesFor(detail);
  return {
    step: "delivered",
    lines,
    outcome: null,
    // Order terms approvals come from the server (web/src/terms), never from here.
    events: [],
    esc: { released: 0, refunded: 0, locked: 0, status: "funded" },
  };
}

const withEvent = (st: DemoState, e: Omit<EscrowEvent, "at">): EscrowEvent[] => [...st.events, { at: now(), ...e }];
const txEvent = (tx: Tx) => ({ sig: tx.sig, sim: tx.simulated });

/**
 * Placeholder events older builds stored in the browser before order terms were real. Dropped when shown:
 * a simulated "both signed" must never sit next to the real, wallet-signed terms.
 */
export const RETIRED_EVENTS = ["Both parties signed the order terms", "Carrier: delivered"];

/** Funds exactly the agreed order terms total. sign.ts re-reads the terms and refuses if they aren't agreed at this amount. */
export function fundRequest(total: number, reference: string, termsVersion: number): SignRequest {
  return {
    title: "Fund escrow",
    rows: [
      ["Order", reference],
      ["Order terms", `v${termsVersion}, approved by buyer and supplier`],
      ["Lock in escrow", `${usd(total)} CDT`],
    ],
    chain: { action: "fund", amount: total },
    apply: (tx, s) => ({
      events: withEvent(s, { label: "Buyer funded escrow", detail: `${usd(total)} CDT locked in the escrow program`, ...txEvent(tx) }),
    }),
  };
}

/**
 * With a real station scan and comparison, the report uses them. Without one it is the SIMULATED
 * demo scan: no photo was analysed, so it must not claim any AI saw anything.
 */
export function scanned(st: DemoState, detail?: OrderLike): Partial<DemoState> {
  const lines = detail ? scanLines(detail) : null;
  const scan = detail?.latestScan;
  if (!lines || !scan) {
    return {
      step: "report",
      linesFrom: null,
      events: withEvent(st, { label: "Receiving report (evidence)", detail: "Demo scan, no photo analysed: 2 × Product A and 1 × Product B", sim: true }),
    };
  }
  const seen = scan.observed.map((o) => `${o.count} × ${o.labelText}`).join(", ");
  const who = AI_SOURCE[scan.analyzedBy];
  return {
    step: "report",
    lines,
    linesFrom: { scanId: detail!.order.latestScanId!, revision: detail!.order.evidenceRevision },
    events: withEvent(st, {
      label: "Receiving report (evidence)",
      detail: seen ? `Station scan · ${who} saw ${seen}` : `Station scan · ${who} read no packages. Check the tray and scan again.`,
      sim: scan.analyzedBy === "mock",
    }),
  };
}

/**
 * The report's lines are stale when a real station comparison exists that they weren't reviewed from:
 * a newer scan or revision, or a real scan arriving after the SIMULATED demo lines.
 */
export function linesStale(st: DemoState, detail: OrderLike): boolean {
  if (!scanLines(detail)) return false;
  const from = st.linesFrom;
  return !from || from.scanId !== detail.order.latestScanId || from.revision !== detail.order.evidenceRevision;
}

/** Evidence changed since the lines were reviewed, or since the request was prepared. */
export const STALE_EVIDENCE = "The station scan changed since you reviewed it. Review the new station report before signing.";

/**
 * The accept/claim transaction for the reviewed lines. `total` is the escrowed total (on-chain when funded).
 * Refuses stale lines so a transaction can't be prepared from an older station scan.
 */
export function reviewedClaim(st: DemoState, detail: OrderLike, total: number): SignRequest {
  if (linesStale(st, detail)) throw new Error(STALE_EVIDENCE);
  if (missingReason(st.lines)) throw new Error(OVERRIDE_REASON);
  const claimed = claimedOf(st.lines);
  const req = claimRequest(st);
  const ev = st.linesFrom ?? undefined;
  return {
    ...req,
    rows: ev ? [...req.rows, ["Station evidence", `scan ${ev.scanId} · revision ${ev.revision}`]] : req.rows,
    chain: claimed ? { action: "claim", accepted: total - st.esc.released - st.esc.refunded - claimed, claimed } : { action: "accept_all" },
    evidence: ev,
  };
}

export function claimRequest(st: DemoState): SignRequest {
  const total = totalOf(st.lines);
  const claimed = claimedOf(st.lines);
  const released = total - claimed;
  const k = st.lines.filter((l) => l.claim).length;
  const accepted = st.lines.length - k;
  if (!k) {
    return {
      title: "Accept full delivery",
      rows: [["Release to supplier", usd(total)]],
      apply: (tx, s) => ({
        step: "settled",
        esc: { released: total, refunded: 0, locked: 0, status: "released" },
        outcome: { title: `Accepted in full. Supplier paid ${usd(total)}.`, sup: total, buy: 0, sig: tx.sig, simulated: tx.simulated, claim: 0 },
        events: withEvent(s, { label: `Buyer accepted all ${st.lines.length} lines`, detail: `${usd(total)} released to supplier`, ...txEvent(tx) }),
      }),
    };
  }
  return {
    title: "Accept lines & file claim",
    rows: [
      ["Release to supplier now", usd(released)],
      ["Lock for claim", usd(claimed)],
    ],
    apply: (tx, s) => ({
      step: "claimed",
      esc: { released, refunded: 0, locked: claimed, status: "claimed" },
      events: [
        ...withEvent(s, {
          label: `Buyer accepted ${accepted} line${accepted === 1 ? "" : "s"}`,
          detail: `${usd(released)} released to supplier right away`,
          ...txEvent(tx),
        }),
        { at: now(), label: "Claim filed", detail: `${k} line${k === 1 ? "" : "s"} · ${usd(claimed)} locked until both sign a settlement` },
      ],
    }),
  };
}

export function historyFor(key: Role, st: DemoState | null) {
  const h = HISTORY[key];
  const extra: HistoryRow[] =
    st?.outcome?.label
      ? [{ ref: "PO-1001", what: `Shortage · 1 line · ${usd(st.outcome.claim)}`, outcome: st.outcome.label, time: "Resolved today" }]
      : [];
  const n = h.base + extra.length;
  const of = h.of + (st?.step === "settled" ? 1 : 0);
  return {
    name: PARTY[key].name,
    role: PARTY[key].role,
    summary: `Disputed ${n} of the last ${of} orders`,
    expired: `${h.expired} offer${h.expired === 1 ? "" : "s"} expired unanswered`,
    rows: [...extra, ...h.rows],
  };
}

export const TONE = { ok: "ok", warn: "warn", bad: "bad", info: "info" } as const;
export type Tone = keyof typeof TONE;

export function orderStatus(st: DemoState): [string, Tone] {
  const L = st.esc.locked;
  const map: Record<Step, [string, Tone]> = {
    delivered: ["Delivered · awaiting inspection", "info"],
    scanning: ["Demo scan running", "info"],
    report: ["Report ready · buyer reviewing lines", "info"],
    claimed: [`Claim open · ${usd(L)} locked`, "bad"],
    settled: [st.esc.status === "released" ? "Released" : "Settled", "ok"],
  };
  return map[st.step];
}

export const ESCROW_STATUS: Record<EscrowStatus, [string, Tone]> = {
  funded: ["Funded", "info"],
  claimed: ["Claim open", "bad"],
  settlement_proposed: ["Settlement proposed", "warn"],
  settled: ["Settled", "ok"],
  released: ["Released", "ok"],
};
