# Rules for every coding agent on this repo

Read README.md, PROJECT.md, CONTRACTS.md and TASKS.md before changing anything. Then read your prompt in `prompts/`.

## Branches
- Work only on your own branch (named in your prompt). Never commit to `main`.
- Before you start and before you push: `git fetch origin && git rebase origin/main`.
- Push often. Open a PR into `main` when a piece works. Small PRs merge easier.

## Ownership (don't edit files you don't own)
| Workstream | Branch prefix | Owns |
|---|---|---|
| 1 Payments (web) | `sol/wallet` | `web/src/payment/**` |
| 2 Payments (server + devnet) | `sol/confirm` | `server/src/solana/**`, `solana/scripts/**`, the `/payments/confirm` route |
| 3 AI / Gemini | `ai/gemini` | `server/src/ai/**`, `samples/**` |
| 4 Web UX | `web/ux` | `web/**` except `web/src/payment/**` (Agent 1 may also add wallet deps to `web/package.json`) |
| 5 Escrow program | `sol/escrow` | `solana/program/**` |
| Hardware (human) | `hw/*` | `hardware/**` |

Shared files (`shared/src/contracts.ts`, `shared/fixtures/**`, `server/src/index.ts` routes you don't own, root `package.json`) change only through the integrator. If you need a contract change, write it in your PR description under **Contract change requested**; don't make it yourself.

## Commits and PRs
- No AI attribution anywhere: no `Co-Authored-By`, no "Generated with", no session links, no mention of Claude/Codex in commits, PR titles or PR bodies.
- Short imperative commit messages ("Add wallet connect button").

## Code rules (from the brief)
- Money is integer cents. Never floats.
- AI output never moves money. Only signatures do.
- Matched ≠ approved ≠ paid. Submitted ≠ confirmed.
- Mocked or simulated data is labelled in the data and the UI. Never fake success; return an honest error instead.
- Devnet test token only. Never call it USDC.
- Don't add big dependencies without saying why in the PR.

## Before you push
```bash
npm test && npm run typecheck && npm run build
```
All three must pass.

## Handoff (end of every session, post in the team chat)
Branch · last commit · what changed · how to run it · tests · blockers.
