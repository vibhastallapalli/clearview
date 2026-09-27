import { historyFor, type Role } from "../escrow/demo";
import { useDemo } from "../escrow/DemoProvider";

export function HistoryPage() {
  const { states } = useDemo();
  const resolved = Object.values(states).find((s) => s.outcome?.label) ?? Object.values(states)[0] ?? null;
  const parties = (["supplier", "buyer"] as Role[]).map((k) => historyFor(k, resolved));

  return (
    <section className="page">
      <div className="page-title">
        <h1>Dispute history</h1>
        <p className="lead narrow">
          Past disputes and outcomes, visible to both parties. <span className="sim">SIMULATED</span>
        </p>
      </div>
      <div className="cols">
        {parties.map((p) => (
          <section key={p.role} className="card party-card">
            <span className="eyebrow">{p.role}</span>
            <span className="party-name">{p.name}</span>
            <span className="party-summary">
              {p.summary} · {p.expired}
            </span>
            <div className="stack-8">
              {p.rows.map((r) => (
                <div key={r.ref + r.what} className="history-row">
                  <span className="history-ref">{r.ref}</span>
                  <span className="history-what">{r.what}</span>
                  <span className="history-outcome">{r.outcome}</span>
                  <span className="history-time">{r.time}</span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
