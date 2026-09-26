import { useEffect, useState } from "react";
import { Link, Outlet } from "react-router-dom";
import { api } from "../api";

export function Layout() {
  const [ai, setAi] = useState<"gemini" | "mock" | "offline" | null>(null);
  useEffect(() => {
    api.health().then((h) => setAi(h.ai)).catch(() => setAi("offline"));
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          ClearDock
        </Link>
        <span className="net">Solana devnet · test tokens only</span>
        {ai === "mock" && <span className="pill warn">AI: MOCK (no Gemini key)</span>}
        {ai === "gemini" && <span className="pill ok">AI: Gemini</span>}
        {ai === "offline" && <span className="pill bad">Server offline</span>}
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
