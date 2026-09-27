# ClearDock UI conventions

ClearDock is a dark glassmorphism UI for a receiving desk: check what was ordered, what arrived and what was billed, then pay a verified supplier on Solana devnet.

## Wrap every screen in `.app`

The glass surfaces are translucent; they need the dark aurora backdrop that `.app` paints. Outside `.app` (or a `<body>` styled by `styles.css`) cards render white-on-white and text becomes unreadable.

```jsx
<div className="app">
  <main>{/* screens go here; .app main gives the 1240px column and page padding */}</main>
</div>
```

Fonts (Space Grotesk headings, Inter body, JetBrains Mono numbers) load through the stylesheet's Google Fonts `@import`; nothing else to set up.

## Styling idiom: plain CSS classes + tokens (no Tailwind, no style props)

| Purpose | Classes |
|---|---|
| Surfaces | `card` (glass panel), `tile` + `tile-label` + `tile-value` (KPI; tone `ok`/`warn`/`bad`/`info` on `tile`), `topbar`, `stepper` > `step` (`done`/`current`/`attention`) + `step-dot` |
| Layout | `page-head`, `row`, `between`, `grid` (2 cols), `tiles` (auto-fit KPI grid), `workspace` (main + 360px `rail`) |
| Text | `eyebrow` (mono cyan kicker), `muted`, `small`, `mono`, `source`, `ok-text`, `warn-text`, `error` |
| Status | `pill` + one of `ok` `warn` `bad` `info` `muted`. Always words plus an icon glyph, never color alone |
| Controls | `button` / `<button>`, `primary` (cyan-to-blue gradient), `ghost`, `button small`, `big`; native `select` is themed |
| Tables | `table` inside `table-wrap`; `num` for right-aligned tabular numbers |
| Brand | `brand` > `BrandMark` + `brand-word`; `net` chip with `live-dot` |

Tokens for anything custom: `var(--text)`, `var(--muted)`, `var(--accent)`, `var(--accent-2)`, `var(--ok)`/`var(--ok-bg)`, `var(--warn)`/`var(--warn-bg)`, `var(--bad)`/`var(--bad-bg)`, `var(--info)`/`var(--info-bg)`, `var(--line)`, `var(--glass-border)`, `var(--radius)`, `var(--radius-sm)`, `var(--font-display)`, `var(--font-body)`, `var(--font-mono)`.

## Content rules

- Money: `$30.00`, in `num`/`mono`. Wallet addresses and signatures in `mono`, shortened `8vHc…hR7c`.
- Devnet test token only: label it "CDT devnet test token". Never call it USDC.
- Mocked or simulated data carries a `pill warn` badge (`MOCK`, `SIMULATED`).

## Where the truth lives

Read `_ds_bundle.css` (the full stylesheet, imported by `styles.css`) before styling, and each component's `.prompt.md` for its props. Components: `StatusBadge` (order status), `VerdictBadge` (line result), `PaymentPanel` (approval + payment card), `BrandMark`.

## Example

```jsx
<div className="app"><main>
  <div className="page-head">
    <div><span className="eyebrow">Receiving desk</span><h1 className="mono">PO-1001</h1></div>
    <StatusBadge status="ready_for_review" />
  </div>
  <div className="tiles">
    <div className="tile"><div className="tile-label">Billed</div><div className="tile-value">$30.00</div></div>
    <div className="tile ok"><div className="tile-label">Undisputed</div><div className="tile-value">$30.00</div></div>
  </div>
  <div className="card">
    <h2>Approval</h2>
    <button className="primary">Approve $30.00</button>
  </div>
</main></div>
```
