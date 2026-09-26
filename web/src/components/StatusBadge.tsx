import type { LineVerdict, OrderStatus } from "@cleardock/shared";

// Every status has words AND an icon, never color alone.
const ORDER: Record<OrderStatus, { label: string; icon: string; tone: string }> = {
  needs_documents: { label: "Needs documents", icon: "○", tone: "muted" },
  analyzing: { label: "Analyzing", icon: "◌", tone: "info" },
  discrepancy: { label: "Discrepancy", icon: "!", tone: "bad" },
  needs_info: { label: "Needs more information", icon: "?", tone: "warn" },
  ready_for_review: { label: "Ready for owner review", icon: "✓", tone: "ok" },
  approved: { label: "Approved", icon: "✔", tone: "ok" },
  awaiting_signature: { label: "Awaiting wallet signature", icon: "✎", tone: "info" },
  payment_submitted: { label: "Payment submitted", icon: "↗", tone: "info" },
  payment_confirmed: { label: "Payment confirmed", icon: "◆", tone: "ok" },
  payment_failed: { label: "Payment failed or unknown", icon: "✕", tone: "bad" },
};

const LINE: Record<LineVerdict, { label: string; tone: string }> = {
  match: { label: "✓ Match", tone: "ok" },
  missing: { label: "! Missing", tone: "bad" },
  over: { label: "! Extra", tone: "warn" },
  unexpected: { label: "! Unexpected", tone: "bad" },
  billed_mismatch: { label: "! Billing differs", tone: "bad" },
  price_mismatch: { label: "! Price differs", tone: "bad" },
  unknown: { label: "? Unknown", tone: "warn" },
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  const s = ORDER[status];
  return (
    <span className={`pill ${s.tone}`}>
      <span aria-hidden>{s.icon}</span> {s.label}
    </span>
  );
}

export function VerdictBadge({ verdict }: { verdict: LineVerdict }) {
  const v = LINE[verdict];
  return <span className={`pill ${v.tone}`}>{v.label}</span>;
}
