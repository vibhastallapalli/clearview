import type React from "react";
import type { OrderDetail, OrderStatus } from "@cleardock/shared";
import { PaymentPanel } from "@cleardock/web-ui";

// Everything in ClearDock renders inside the .app root, which carries the glass backdrop.
const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="app" style={{ padding: 20, borderRadius: 14 }}>
    {children}
  </div>
);

const at = "2026-09-26T14:05:00.000Z";
const supplierWallet = "8vHc2QRKm3XoTzK6qfJmZ1DkY5tB9sWvLnEaP4uGhR7c";

function order(status: OrderStatus, outcome: "match" | "discrepancy", extra: Partial<OrderDetail["order"]> = {}): OrderDetail {
  const matched = outcome === "match";
  return {
    supplier: { id: "sup_cafe_roasters", name: "Tostadores del Norte", walletAddress: supplierWallet, verified: true },
    documents: [],
    latestCapture: null,
    latestScan: null,
    order: {
      id: "ord_1001",
      reference: "PO-1001",
      supplierId: "sup_cafe_roasters",
      currency: "USD",
      status,
      evidenceRevision: 4,
      documentIds: [],
      latestCaptureId: null,
      latestScanId: null,
      comparison: {
        orderId: "ord_1001",
        evidenceRevision: 4,
        outcome,
        lines: [],
        orderedTotalMinor: 3000,
        billedTotalMinor: 3000,
        undisputedMinor: matched ? 3000 : 2000,
        summary: matched ? "Everything ordered, billed and delivered matches." : "1 bag of Product A missing ($10.00).",
        computedAt: at,
      },
      approval: null,
      payment: null,
      createdAt: at,
      updatedAt: at,
      ...extra,
    },
  };
}

const approval = { id: "apr_7k2m", orderId: "ord_1001", evidenceRevision: 4, recipient: supplierWallet, amountMinor: 3000, approvedAt: at };

const run = async () => {};
const Rail = ({ detail }: { detail: OrderDetail }) => (
  <div style={{ maxWidth: 360 }}>
    <PaymentPanel detail={detail} busy={false} run={run} />
  </div>
);

export const ReadyForReview = () => (
  <Surface>
    <Rail detail={order("ready_for_review", "match")} />
  </Surface>
);

export const Discrepancy = () => (
  <Surface>
    <Rail detail={order("discrepancy", "discrepancy")} />
  </Surface>
);

export const Approved = () => (
  <Surface>
    <Rail detail={order("approved", "match", { approval })} />
  </Surface>
);

export const AwaitingSignature = () => (
  <Surface>
    <Rail
      detail={order("awaiting_signature", "match", {
        approval,
        payment: {
          id: "pay_3f9x",
          orderId: "ord_1001",
          approvalId: "apr_7k2m",
          network: "devnet",
          recipient: supplierWallet,
          amountMinor: 3000,
          idempotencyKey: "ord_1001:apr_7k2m",
          status: "awaiting_signature",
          signature: null,
          error: null,
          updatedAt: at,
        },
      })}
    />
  </Surface>
);
