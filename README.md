# ClearDock

Checks what a business **ordered**, what physically **arrived**, and what the supplier **billed**, then helps the owner approve and pay the verified supplier on **Solana devnet**.

> "The paperwork says one thing. The delivery says another. ClearDock shows the difference before payment."

Read these first, in order:

1. **[PROJECT.md](PROJECT.md)**: the full brief (what we build, what we don't)
2. **[CONTRACTS.md](CONTRACTS.md)**: the shared data shapes; everyone codes against these
3. **[TASKS.md](TASKS.md)**: who owns what, in build order
4. [docs/escrow-rulebook.md](docs/escrow-rulebook.md): Phase 2 dispute rules (decided; don't reopen)
5. [ROADMAP.md](ROADMAP.md): everything parked for later (use this for the pitch)
6. **[CLAUDE.md](CLAUDE.md)** / AGENTS.md: rules for coding agents; **[prompts/](prompts/)**: one prompt per agent

## Quick start

```bash
git clone https://github.com/vibhastallapalli/clearview.git
cd clearview
cp .env.example .env        # add GEMINI_API_KEY when you have it; works without (MOCK mode)
npm install
npm test                    # comparison logic tests
npm run dev                 # server :3001 + web :5173
```

Open http://localhost:5173 → **PO-1001**.

Without a Gemini key everything runs in **MOCK** mode and the UI says so everywhere. Uploads return fixture data, and the phone capture page lets you pick which mock result to return (match / core example / unreadable).

## What already works

| Piece | Status |
|---|---|
| Order queue + order screen | ✅ |
| Upload PO / invoice / receipt (PDF, PNG, JPEG) | ✅ Gemini if key set, else labelled mock |
| Deterministic 3-way comparison (units, prices, missing, unexpected) | ✅ tested |
| Phone capture via QR code (short-lived session link) | ✅ live camera on HTTPS, native camera fallback otherwise |
| Station capture endpoint for hardware (image + weight) | ✅ |
| Evidence revision → old approvals auto-voided | ✅ |
| Approve (matched orders only, verified wallet only) | ✅ |
| Prepare payment (idempotent, repeated clicks = same payment) | ✅ |
| Wallet signing + devnet transfer + confirmation | ❌ TODO (solana/README.md) |
| Presentation mode | ❌ TODO |
| Escrow, claims, settlement offers (Phase 2) | ❌ types only |

Nothing fakes success: unbuilt steps return `501 not_implemented`.

## Repo layout

```
shared/     contracts.ts (types), compare.ts (deterministic matching), fixtures/, tests
server/     Express API, JSON-file store, ai/ (the ONLY place that calls Gemini)
web/        Vite + React workspace UI, /capture/:code phone page
hardware/   receiving-station script and wiring notes
solana/     devnet payment + (later) escrow program notes
docs/       escrow rulebook
```

## Phone camera needs HTTPS

Browsers only open the camera on `https://` or `localhost`. For the phone:

```bash
ngrok http 5173                       # copy the https URL
# set PUBLIC_WEB_URL=https://xxxx.ngrok-free.app in .env, restart `npm run dev`
```

Without HTTPS the capture page falls back to the phone's native camera button, which still works. Bring a hotspot; don't trust event Wi-Fi.

## Rules we don't break

- **Money is integer cents.** Never floats.
- **AI never moves money.** Gemini output is validated in `server/src/ai/analyze.ts`; comparison is plain code in `shared/src/compare.ts`.
- **Matched ≠ approved ≠ paid. Submitted ≠ confirmed.**
- **Any evidence change voids the approval.**
- **Mocks and simulated readings are labelled** in data and UI.
- **Devnet test tokens only.** Never call them USDC.

## Working together

- One branch per workstream: `web/...`, `ai/...`, `hw/...`, `sol/...`. PR into `main`.
- Change `shared/src/contracts.ts` only through the integrator, and update CONTRACTS.md + fixtures in the same PR.
- Handoff message: branch, commit, what changed, how to run, tests, blockers.
