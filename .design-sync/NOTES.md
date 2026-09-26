# design-sync notes (ClearDock web UI → Claude Design project "SecuroServ")

## How this repo syncs

- ClearDock's web app has no library build. `node .design-sync/build-pkg.mjs` (`cfg.buildCmd`) writes a throwaway package to `.ds-sync/pkg`: an entry re-exporting the synced components, `.d.ts` emitted by `tsc` from the real source, and a verbatim copy of `web/src/styles.css`. Run it before every converter/driver run.
- Never point the converter at `web/src` directly: a synthesized entry would include `main.tsx`, which mounts the whole app on import.
- The converter skips a `cssEntry` outside the package, which is why the stylesheet is copied into `.ds-sync/pkg`.
- `@cleardock/shared` imports with `.ts` extensions; the tsc step needs `allowImportingTsExtensions` (legal with `emitDeclarationOnly`).
- No Playwright browser cache on this machine. The render check uses installed Chrome: `DS_CHROMIUM_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe"`, with the `playwright` library installed in `.ds-sync/` (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`).
- `.gitignore` is owned by P1, so the local ignores for `.ds-sync/`, `ds-bundle/`, `.design-sync/.cache/`, `.design-sync/learnings/` and `.design-sync/node_modules` live in `.git/info/exclude`. Ask P1 to add them to `.gitignore`.

## Scope

- Synced: `BrandMark`, `StatusBadge`, `VerdictBadge`, `PaymentPanel` (list lives in `build-pkg.mjs`).
- Excluded on purpose: `Layout` (needs the router and pings `/api/health`, so designs would show "Server offline") and the three pages (they fetch order data from the server).
- `EscrowPanel` lives on branch `sol/escrow`; add it to `build-pkg.mjs` once that merges.

## Preview gotchas

- The preview harness forces `body{background:#fff}`. The glass theme needs its dark backdrop, so `.app` carries the same backdrop as `body` and every preview wraps its story in a `Surface` (`<div className="app">`). Without it, text is light-on-white and unreadable.
- `BrandMark` and `VerdictBadge` use `cardMode: "column"`: the top bar and comparison table are wider than a grid cell.

## Known render warns

- None on the final build.

## Re-sync risks

- `build-pkg.mjs` hardcodes the component list and file paths. Moving a component file breaks the build loudly (tsc error); adding one needs a line there.
- `styles.css` is copied, not linked: always run `build-pkg.mjs` after editing `web/src/styles.css` or the project ships the old theme.
- Fonts come from a Google Fonts `@import` at runtime (`[FONT_REMOTE]`); designs render in fallback fonts offline.
- Preview fixtures in `.design-sync/previews/PaymentPanel.tsx` mirror the contracts-v1 `Order`/`Payment` shapes. When Contracts v2 lands (`Payment.mint`, `payer`, `memo`, `Order.escrow`), update the fixtures.
- `PaymentPanel` will change when P2 wires wallet signing; re-author its states then.
