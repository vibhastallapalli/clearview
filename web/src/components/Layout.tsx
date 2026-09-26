import { useEffect, useState } from "react";
import { Link, Outlet } from "react-router-dom";
import { api } from "../api";

export function BrandMark({ className = "brand-mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="cd-mark" x1="4" y1="3" x2="28" y2="29" gradientUnits="userSpaceOnUse">
          <stop stopColor="#67e8f9" />
          <stop offset="1" stopColor="#3b82f6" />
        </linearGradient>
      </defs>
      <path d="M16 2.5 28 8v8.5c0 6.6-5 11.6-12 13-7-1.4-12-6.4-12-13V8l12-5.5Z" stroke="url(#cd-mark)" strokeWidth="2" />
      <path d="m10.5 16 4 4 7-8" stroke="url(#cd-mark)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Layout() {
  const [ai, setAi] = useState<"gemini" | "mock" | "offline" | null>(null);
  useEffect(() => {
    api.health().then((h) => setAi(h.ai)).catch(() => setAi("offline"));
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="ClearDock order queue">
          <BrandMark />
          <span className="brand-word">ClearDock</span>
        </Link>
        <span className="net">
          <span className="live-dot" aria-hidden="true" />
          Solana devnet · test tokens only
        </span>
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
