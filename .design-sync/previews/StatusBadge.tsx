import type React from "react";
import { StatusBadge } from "@cleardock/web-ui";

// Everything in ClearDock renders inside the .app root, which carries the glass backdrop.
const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="app" style={{ padding: 20, borderRadius: 14 }}>
    {children}
  </div>
);

const row = { display: "flex", gap: 10, flexWrap: "wrap" as const, alignItems: "center" };

export const Intake = () => (
  <Surface>
    <div style={row}>
      <StatusBadge status="needs_documents" />
      <StatusBadge status="analyzing" />
    </div>
  </Surface>
);

export const Review = () => (
  <Surface>
    <div style={row}>
      <StatusBadge status="discrepancy" />
      <StatusBadge status="needs_info" />
      <StatusBadge status="ready_for_review" />
    </div>
  </Surface>
);

export const Payment = () => (
  <Surface>
    <div style={row}>
      <StatusBadge status="approved" />
      <StatusBadge status="awaiting_signature" />
      <StatusBadge status="payment_submitted" />
      <StatusBadge status="payment_confirmed" />
      <StatusBadge status="payment_failed" />
    </div>
  </Surface>
);

export const InOrderHeader = () => (
  <Surface>
    <div className="page-head" style={{ marginBottom: 0 }}>
      <div>
        <span className="eyebrow">Tostadores del Norte (synthetic)</span>
        <h1 className="mono">PO-1001</h1>
      </div>
      <StatusBadge status="discrepancy" />
    </div>
  </Surface>
);
