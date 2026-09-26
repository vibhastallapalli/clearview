import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { OrderStatus } from "@cleardock/shared";
import { api, money, type OrderRow } from "../api";
import { StatusBadge } from "../components/StatusBadge";

const NEEDS_ATTENTION: OrderStatus[] = ["needs_documents", "discrepancy", "needs_info", "payment_failed"];

export function OrdersPage() {
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.orders().then(setOrders).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const count = (pred: (o: OrderRow) => boolean) => orders?.filter(pred).length ?? 0;

  return (
    <section>
      <div className="page-head">
        <div>
          <span className="eyebrow">Receiving desk</span>
          <h1>Order queue</h1>
          <p className="muted">What was ordered, what arrived and what was billed, checked before anyone pays.</p>
        </div>
        <button
          className="ghost"
          onClick={() => api.reset().then(load).catch((e) => setError(e.message))}
          title="Dev only: restore the seeded demo order"
        >
          Reset demo data
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {!orders && !error && <p className="muted">Loading…</p>}

      {orders && (
        <>
          <div className="tiles">
            <div className="tile info">
              <div className="tile-label">Orders</div>
              <div className="tile-value">{orders.length}</div>
            </div>
            <div className="tile warn">
              <div className="tile-label">Need attention</div>
              <div className="tile-value">{count((o) => NEEDS_ATTENTION.includes(o.status))}</div>
            </div>
            <div className="tile">
              <div className="tile-label">Ready for review</div>
              <div className="tile-value">{count((o) => o.status === "ready_for_review")}</div>
            </div>
            <div className="tile ok">
              <div className="tile-label">Paid on devnet</div>
              <div className="tile-value">{count((o) => o.status === "payment_confirmed")}</div>
            </div>
          </div>

          <div className="card table-card table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Supplier</th>
                  <th className="num">Billed</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link to={`/orders/${o.id}`} className="mono">
                        {o.reference}
                      </Link>
                    </td>
                    <td>{o.supplierName}</td>
                    <td className="num">{money(o.comparison?.billedTotalMinor)}</td>
                    <td>
                      <StatusBadge status={o.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
