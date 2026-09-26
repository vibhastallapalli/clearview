import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, money, type OrderRow } from "../api";
import { StatusBadge } from "../components/StatusBadge";

export function OrdersPage() {
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.orders().then(setOrders).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  return (
    <section>
      <div className="row between">
        <h1>Order queue</h1>
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
        <table className="table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Supplier</th>
              <th>Billed</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>
                  <Link to={`/orders/${o.id}`}>{o.reference}</Link>
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
      )}
    </section>
  );
}
