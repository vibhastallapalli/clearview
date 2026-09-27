import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, money, type OrderRow } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import { PARTY, orderStatus, totalOf, usd } from "../escrow/demo";
import { useDemo } from "../escrow/DemoProvider";

// Closed orders shown for context in the demo; they don't exist on the server.
const PAST_ORDERS = [
  { ref: "PO-0998", items: "4 × Product A 500 g", amt: "$40.00", status: "Released" },
  { ref: "PO-0987", items: "3 × Product B 500 g", amt: "$36.00", status: "Settled · split" },
];

function itemsFor(o: OrderRow) {
  const ordered = o.comparison?.lines.filter((l) => l.ordered);
  return ordered?.length ? ordered.map((l) => `${l.ordered} × ${l.description}`).join(", ") : "3 × Product A 500 g";
}

export function OrdersPage() {
  const navigate = useNavigate();
  const { role, peek, ensure, resetAll } = useDemo();
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.orders().then(setOrders).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  useEffect(() => orders?.forEach((o) => ensure(o.id, { order: o })), [orders, ensure]);

  const reset = () =>
    api
      .reset()
      .then(() => {
        resetAll();
        return load();
      })
      .catch((e) => setError(e.message));

  const demo = (orders ?? []).map((o) => peek(o.id));
  const settledCount = demo.filter((s) => s?.step === "settled").length;
  const disputes = demo.filter((s) => s && ["claimed", "offer", "physical"].includes(s.step)).length;
  const counts = [
    { n: (orders?.length ?? 0) - settledCount, label: "Open" },
    { n: disputes, label: "In dispute" },
    { n: PAST_ORDERS.length + settledCount, label: "Closed" },
  ];
  const counterparty = (o: OrderRow) => (role === "buyer" ? o.supplierName ?? "Supplier" : PARTY.buyer.name);

  return (
    <section className="page">
      <div className="page-head">
        <div className="page-title">
          <h1>Orders</h1>
          <p className="lead">{role === "buyer" ? "From your suppliers" : "From your buyers"}</p>
        </div>
        <button className="secondary sm" onClick={reset} title="Dev only: restore the seeded demo order">
          Reset demo data
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {!orders && !error && <p className="muted">Loading…</p>}

      {orders && (
        <>
          <div className="chips">
            {counts.map((c) => (
              <div key={c.label} className="chip">
                <span className="chip-n">{c.n}</span>
                <span className="chip-label">{c.label}</span>
              </div>
            ))}
          </div>

          <div className="stack-10">
            {orders.map((o) => {
              const st = peek(o.id);
              const [label, tone] = st ? orderStatus(st) : [null, null];
              return (
                <div
                  key={o.id}
                  className="order-row clickable"
                  role="link"
                  tabIndex={0}
                  onClick={() => navigate(`/orders/${o.id}`)}
                  onKeyDown={(e) => e.key === "Enter" && navigate(`/orders/${o.id}`)}
                >
                  <div className="order-row-main">
                    <span className="order-ref">{o.reference}</span>
                    <span className="order-who">
                      {counterparty(o)} · {itemsFor(o)}
                    </span>
                  </div>
                  <span className="order-amt">{st ? usd(totalOf(st.lines)) : money(o.comparison?.billedTotalMinor ?? 3000)}</span>
                  {label ? <span className={`pill ${tone}`}>{label}</span> : <StatusBadge status={o.status} />}
                  <span className="order-cta">Open →</span>
                </div>
              );
            })}
            {PAST_ORDERS.map((o) => (
              <div key={o.ref} className="order-row">
                <div className="order-row-main">
                  <span className="order-ref">{o.ref}</span>
                  <span className="order-who">
                    {role === "buyer" ? PARTY.supplier.name : PARTY.buyer.name} · {o.items} · <span className="sim">SIMULATED</span>
                  </span>
                </div>
                <span className="order-amt">{o.amt}</span>
                <span className="pill ok">{o.status}</span>
                <span className="order-cta" />
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
