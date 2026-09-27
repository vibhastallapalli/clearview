import type { Order, ScanResult } from "@cleardock/shared";

/** The only order data the demo needs; both OrderDetail and a queue row satisfy it. */
export type OrderLike = { order: Order; latestScan?: ScanResult | null };

// Client-side model of the $30 escrow demo (docs/escrow-rulebook.md). Every
// money movement goes through a SignRequest. Requests with `chain` are real
// devnet transactions to the escrow program (sign.ts); the rest (offers,
// counters, rejections) are off-chain agreement steps and stay SIMULATED.

export type Role = "buyer" | "supplier";
export type Step = "delivered" | "scanning" | "report" | "claimed" | "offer" | "physical" | "settled";
export type OfferId = "refund" | "release" | "split" | "replacement" | "cancel";
export type EscrowStatus = "funded" | "claimed" | "settlement_proposed" | "settled" | "released";

export interface Physical {
  who: Role;
  wait: string;
  act: string;
  text: string;
}

export interface Offer {
  id: OfferId;
  label: string;
  desc: string;
  sup: number;
  buy: number;
  phys?: Physical;
}

export interface Line {
  id: string;
  label: string;
  sub: string;
  priceMinor: number;
  claim: boolean;
  miss: boolean;
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
  offer: { by: Role; id: OfferId } | null;
  countering: boolean;
  pick: OfferId;
  pending: (Physical & { id: OfferId; label: string }) | null;
  outcome: Outcome | null;
  rejected: boolean;
  events: EscrowEvent[];
  esc: { released: number; refunded: number; locked: number; status: EscrowStatus };
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
  apply: (tx: Tx, st: DemoState) => Partial<DemoState>;
}

export const OFFERS: Offer[] = [
  { id: "refund", label: "Full refund", desc: "All locked money goes back to the buyer.", sup: 0, buy: 1 },
  { id: "release", label: "Full release", desc: "All locked money goes to the supplier.", sup: 1, buy: 0 },
  { id: "split", label: "Split", desc: "Half to each side.", sup: 0.5, buy: 0.5 },
  {
    id: "replacement",
    label: "Replacement",
    desc: "Supplier ships the missing bag. The money releases when the buyer scans it and signs.",
    sup: 1,
    buy: 0,
    phys: {
      who: "buyer",
      wait: "Replacement bag in transit",
      act: "Scan replacement & sign acceptance",
      text: "The locked amount stays locked until the buyer scans the replacement and signs acceptance. Then it pays the supplier.",
    },
  },
  {
    id: "cancel",
    label: "Cancel with return",
    desc: "Buyer returns the Product B bag. The refund releases when the supplier scans the return and signs.",
    sup: 0,
    buy: 1,
    phys: {
      who: "supplier",
      wait: "Product B bag being returned",
      act: "Scan returned bag & sign",
      text: "The refund releases when the supplier scans the returned bag and signs acceptance.",
    },
  },
];

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
      for (let i = 1; i <= ordered; i++) {
        const seen = i <= (l.observed ?? 0);
        lines.push({
          id: `${l.sku ?? l.description}-${i}`,
          label: `${l.description} · unit ${i}`,
          sub: seen ? "Seen on scan · label matches" : "Not seen on scan",
          priceMinor: l.unitPriceMinor,
          claim: !seen,
          miss: !seen,
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
export const claimedOf = (lines: Line[]) => lines.filter((l) => l.claim).reduce((sum, l) => sum + l.priceMinor, 0);

export function initialState(detail: OrderLike | null): DemoState {
  const lines = linesFor(detail);
  const total = totalOf(lines);
  return {
    step: "delivered",
    lines,
    offer: null,
    countering: false,
    pick: "refund",
    pending: null,
    outcome: null,
    rejected: false,
    events: [
      { label: "Both parties signed the order terms", detail: "3 × Product A 500 g at $10.00 · 3-day inspection window", at: "09:12", sim: true },
      { label: "Carrier: delivered", detail: "Inspection window starts", at: "10:42", sim: true },
    ],
    esc: { released: 0, refunded: 0, locked: 0, status: "funded" },
  };
}

const withEvent = (st: DemoState, e: Omit<EscrowEvent, "at">): EscrowEvent[] => [...st.events, { at: now(), ...e }];
const txEvent = (tx: Tx) => ({ sig: tx.sig, sim: tx.simulated });

export function fundRequest(st: DemoState, reference: string): SignRequest {
  const total = totalOf(st.lines);
  return {
    title: "Fund escrow",
    rows: [
      ["Order", reference],
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
 * demo scan: no photo was analysed, so it must not claim Gemini saw anything.
 */
export function scanned(st: DemoState, detail?: OrderLike): Partial<DemoState> {
  const lines = detail ? scanLines(detail) : null;
  const scan = detail?.latestScan;
  if (!lines || !scan) {
    return {
      step: "report",
      events: withEvent(st, { label: "Receiving report (evidence)", detail: "Demo scan, no photo analysed: 2 × Product A and 1 × Product B", sim: true }),
    };
  }
  const seen = scan.observed.map((o) => `${o.count} × ${o.labelText}`).join(", ") || "nothing it could read";
  return {
    step: "report",
    lines,
    events: withEvent(st, { label: "Receiving report (evidence)", detail: `Station scan · ${scan.analyzedBy === "mock" ? "Mock AI" : "Gemini"} saw ${seen}`, sim: scan.analyzedBy === "mock" }),
  };
}

function settle(st: DemoState, o: Offer, tx: Tx, label: string): Partial<DemoState> {
  const L = st.esc.locked;
  const sup = Math.round(L * o.sup);
  const buy = L - sup;
  const rel = st.esc.released + sup;
  const ref = st.esc.refunded + buy;
  return {
    step: "settled",
    offer: null,
    pending: null,
    esc: { released: rel, refunded: ref, locked: 0, status: "settled" },
    outcome: {
      title: `Both signed. Supplier paid ${usd(rel)}, buyer refunded ${usd(ref)}.`,
      label: o.label,
      sup: rel,
      buy: ref,
      sig: tx.sig,
      simulated: tx.simulated,
      claim: L,
    },
    events: withEvent(st, { label, detail: `Program paid ${usd(sup)} to supplier and refunded ${usd(buy)} to buyer`, ...txEvent(tx) }),
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

export function proposeRequest(st: DemoState, role: Role): SignRequest {
  const o = OFFERS.find((x) => x.id === st.pick)!;
  const L = st.esc.locked;
  const sup = Math.round(L * o.sup);
  return {
    title: st.countering ? "Send counter-offer" : "Send settlement offer",
    rows: [
      ["Offer", o.label],
      ["To supplier", usd(sup)],
      ["Back to buyer", usd(L - sup)],
      ["Expires", "in 24 h"],
    ],
    apply: (tx, s) => ({
      step: "offer",
      offer: { by: role, id: o.id },
      countering: false,
      rejected: false,
      esc: { ...s.esc, status: "settlement_proposed" },
      events: withEvent(s, {
        label: `${PARTY[role].name} offered: ${o.label}`,
        detail: `${usd(sup)} to supplier · ${usd(L - sup)} to buyer`,
        ...txEvent(tx),
      }),
    }),
  };
}

export function acceptRequest(st: DemoState): SignRequest {
  const o = OFFERS.find((x) => x.id === st.offer!.id)!;
  const L = st.esc.locked;
  const sup = Math.round(L * o.sup);
  const rows: [string, string][] = [
    ["Offer", o.label],
    ["To supplier", usd(sup)],
    ["Back to buyer", usd(L - sup)],
  ];
  if (o.phys) {
    const phys = o.phys;
    return {
      title: "Accept offer",
      rows,
      apply: (tx, s) => ({
        step: "physical",
        pending: { ...phys, id: o.id, label: o.label },
        events: withEvent(s, { label: `Both signed: ${o.label}`, detail: `${phys.wait} · ${usd(L)} stays locked`, ...txEvent(tx) }),
      }),
    };
  }
  return { title: "Accept & execute settlement", rows, apply: (tx, s) => settle(s, o, tx, `Both signed: ${o.label}`) };
}

export function physicalRequest(st: DemoState): SignRequest {
  const pending = st.pending!;
  const o = OFFERS.find((x) => x.id === pending.id)!;
  const L = st.esc.locked;
  const sup = Math.round(L * o.sup);
  return {
    title: pending.act,
    rows: [
      ["To supplier", usd(sup)],
      ["Back to buyer", usd(L - sup)],
    ],
    apply: (tx, s) =>
      settle(s, o, tx, o.id === "replacement" ? "Buyer scanned replacement & signed" : "Supplier scanned return & signed"),
  };
}

export const rejected = (st: DemoState, role: Role): Partial<DemoState> => ({
  step: "claimed",
  offer: null,
  rejected: true,
  esc: { ...st.esc, status: "claimed" },
  events: withEvent(st, { label: `${PARTY[role].name} rejected the offer`, detail: `${usd(st.esc.locked)} stays locked · case still open` }),
});

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
    scanning: ["Scanning delivery", "info"],
    report: ["Discrepancy found", "warn"],
    claimed: [`Claim open · ${usd(L)} locked`, "bad"],
    offer: ["Settlement offer pending", "warn"],
    physical: [st.pending?.wait ?? "Waiting on the physical step", "info"],
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
