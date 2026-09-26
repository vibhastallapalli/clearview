import type { OrderDetail } from "@cleardock/shared";
import { api, money } from "../api";
import { short } from "../format";

/**
 * Approval + devnet payment card on the order screen.
 * Owned by the Solana/payments workstream; keep wallet code inside web/src/payment/.
 */
export function PaymentPanel({
  detail,
  busy,
  run,
}: {
  detail: OrderDetail;
  busy: boolean;
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const { order, supplier } = detail;
  const c = order.comparison;

  return (
    <div className="card">
      <h2>Approval and payment</h2>
      {order.status === "ready_for_review" && c && (
        <button
          className="primary"
          disabled={busy}
          onClick={() => run("approve", () => api.approve(order.id, order.evidenceRevision))}
        >
          Approve {money(c.billedTotalMinor)} to {short(supplier.walletAddress)}
        </button>
      )}
      {order.status === "discrepancy" && (
        <p className="muted">Resolve the discrepancy first: fix the delivery and recapture, or (Phase 2) file a claim.</p>
      )}
      {order.approval && (
        <p className="small">
          Approved {money(order.approval.amountMinor)} → {short(order.approval.recipient)} at rev{" "}
          {order.approval.evidenceRevision}
        </p>
      )}
      {order.status === "approved" && (
        <button className="primary" disabled={busy} onClick={() => run("pay", () => api.preparePayment(order.id))}>
          Prepare devnet payment
        </button>
      )}
      {order.payment && (
        <div className="small">
          <p>
            Payment {order.payment.status} · {money(order.payment.amountMinor)} · devnet test token
          </p>
          {/* TODO(payments): connect wallet (Phantom/Solflare), build the SPL transfer,
              sign, then POST /api/orders/:id/payments/confirm with the signature. */}
          <p className="muted">Wallet signing not wired yet.</p>
        </div>
      )}
    </div>
  );
}
