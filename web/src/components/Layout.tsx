import { useEffect, useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { api, type OrderRow } from "../api";
import { PARTY, type Role } from "../escrow/demo";
import { useDemo } from "../escrow/DemoProvider";

export function BrandMark({ className = "brand-mark" }: { className?: string }) {
  return (
    <span className={className} aria-hidden="true">
      <span className="brand-mark-dot" />
    </span>
  );
}

export function Layout() {
  const { role, setRole } = useDemo();
  const [ai, setAi] = useState<"gemini" | "mock" | "offline" | null>(null);
  const [demoOrder, setDemoOrder] = useState<OrderRow | null>(null);

  useEffect(() => {
    api.health().then((h) => setAi(h.ai)).catch(() => setAi("offline"));
    api.orders().then((o) => setDemoOrder(o[0] ?? null)).catch(() => {});
  }, []);

  const me = PARTY[role];
  const tabClass = ({ isActive }: { isActive: boolean }) => (isActive ? "tab on" : "tab");

  return (
    <div className="app">
      <div className="blobs" aria-hidden="true">
        <span className="blob b1" />
        <span className="blob b2" />
        <span className="blob b3" />
      </div>
      <header className="topbar">
        <Link to="/" className="brand" aria-label="SecuroServ orders">
          <BrandMark />
          SecuroServ
        </Link>
        <span className="net">Solana devnet · CDT test dollars</span>
        {ai === "mock" && <span className="pill warn pill-sm">AI: MOCK (no Gemini key)</span>}
        {ai === "offline" && <span className="pill bad pill-sm">Server offline</span>}
        <nav className="tabs" aria-label="Main">
          <NavLink to="/" end className={tabClass}>
            Orders
          </NavLink>
          {demoOrder && (
            <NavLink to={`/orders/${demoOrder.id}`} className={tabClass}>
              {demoOrder.reference}
            </NavLink>
          )}
          <NavLink to="/history" className={tabClass}>
            Dispute history
          </NavLink>
        </nav>
        <div className="topbar-right">
          <span className="viewing">Viewing as</span>
          <div className="seg" role="group" aria-label="Viewing as">
            {(["buyer", "supplier"] as Role[]).map((r) => (
              <button key={r} className={role === r ? "on" : ""} aria-pressed={role === r} onClick={() => setRole(r)}>
                {PARTY[r].role}
              </button>
            ))}
          </div>
          <span className="wallet-pill">
            {me.name} · {me.wallet}
          </span>
        </div>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
