import type React from "react";
import { BrandMark } from "@cleardock/web-ui";

// Everything in ClearDock renders inside the .app root, which carries the glass backdrop.
const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="app" style={{ padding: 20, borderRadius: 14 }}>
    {children}
  </div>
);

export const Mark = () => (
  <Surface>
    <BrandMark />
  </Surface>
);

export const Lockup = () => (
  <Surface>
    <span className="brand">
      <BrandMark />
      <span className="brand-word">ClearDock</span>
    </span>
  </Surface>
);

export const TopBar = () => (
  <Surface>
    <header className="topbar" style={{ position: "static" }}>
      <span className="brand">
        <BrandMark />
        <span className="brand-word">ClearDock</span>
      </span>
      <span className="net">
        <span className="live-dot" aria-hidden="true" />
        Solana devnet · test tokens only
      </span>
      <span className="pill ok">AI: Gemini</span>
    </header>
  </Surface>
);
