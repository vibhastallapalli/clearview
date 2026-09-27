import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { api, type OrderRow } from "../api";
import { PARTY, type Role } from "../escrow/demo";
import { useDemo } from "../escrow/DemoProvider";
import { mountFilings } from "../design/filings";
import { filings, headerStyle } from "../design/flags";

const LOGO_PATH =
  "M8 1H16A7 7 0 0 1 23 8V16A7 7 0 0 1 16 23H8A7 7 0 0 1 1 16V8A7 7 0 0 1 8 1ZM8.2 3.4A4.8 4.8 0 0 0 3.4 8.2V15.8A4.8 4.8 0 0 0 8.2 20.6H15.8A4.8 4.8 0 0 0 20.6 15.8V8.2A4.8 4.8 0 0 0 15.8 3.4ZM9.9 7.5H14.1A2.4 2.4 0 0 1 16.5 9.9V14.1A2.4 2.4 0 0 1 14.1 16.5H9.9A2.4 2.4 0 0 1 7.5 14.1V9.9A2.4 2.4 0 0 1 9.9 7.5ZM12 9.3A1.7 1.7 0 1 1 12.85 12.47L13.2 14.6H10.8L11.15 12.47A1.7 1.7 0 0 1 12 9.3Z";

export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#1f5f69" fillRule="evenodd" d={LOGO_PATH} />
    </svg>
  );
}

function Wordmark() {
  switch (headerStyle) {
    case "Split weight":
      return (
        <span className="wm wm-split">
          Securo<span>Serv</span>
        </span>
      );
    case "With tag":
      return (
        <span className="wm wm-tag">
          SecuroServ
          <span className="wm-divider" />
          <span className="wm-mono">ESCROW</span>
        </span>
      );
    case "Stacked":
      return (
        <span className="wm wm-stacked">
          <span>SecuroServ</span>
          <span className="wm-mono">B2B ESCROW</span>
        </span>
      );
    case "Spaced caps":
      return <span className="wm wm-caps">SECUROSERV</span>;
    default:
      return <span className="wm">SecuroServ</span>;
  }
}

/** Drifting colour blobs plus the experimental magnetic filings, behind all content. */
function Backdrop() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!filings || !canvas.current) return;
    const fl = mountFilings(canvas.current);
    return () => fl.destroy();
  }, []);
  return (
    <div className="blobs" aria-hidden="true">
      <span className="blob b1" />
      <span className="blob b2" />
      <span className="blob b3" />
      {filings && <canvas ref={canvas} className="filings" />}
    </div>
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
      <Backdrop />
      <header className="topbar">
        <Link to="/" className="brand" aria-label="SecuroServ orders">
          <BrandMark />
          <Wordmark />
        </Link>
        <span className="net">
          <span className="net-dot" aria-hidden="true" />
          Solana devnet · CDT test dollars
        </span>
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
