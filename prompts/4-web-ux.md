# Agent 4: Web UX and presentation mode

**Branch:** `web/ux` · **Owns:** `web/src/**` except `web/src/payment/**`

Paste this into Claude after cloning `https://github.com/vibhastallapalli/clearview`:

---

You are working on ClearDock, a hackathon project. Read CLAUDE.md, README.md, PROJECT.md (section "UI/UX" and "THE THREE-MINUTE DEMO") and CONTRACTS.md first and follow CLAUDE.md strictly.

Create branch `web/ux` from `main`. Your job: make the app look like a polished business tool and demo well. Don't touch `web/src/payment/` (another agent owns it) or the server.

1. **Presentation mode** at `/present/:orderId`: full-screen, same live data (poll like OrderPage does), large type readable from across a room. Shows the evidence photo, the ordered/billed/delivered table, the one-line result, and the payment status. Add a button on the order page to open it.
2. **Order workspace polish:** clearer layout of evidence vs comparison, show the uploaded document itself (PDF/image preview) next to its extracted lines, highlight discrepancy lines, make "Matched", "Approved" and "Paid" look clearly different.
3. **Queue:** counts per status, and an "Approve all matched" button that calls the existing approve endpoint once per ready order (sequentially, stop on first error).
4. **States:** every loading, empty and error state from the brief, including camera permission denied on the capture page. No fake success.
5. **Mobile capture page:** make it great on a phone: big buttons, clear "sent" confirmation, recapture flow.

Keep it restrained: no crypto-dashboard charts. Keep MOCK and SIMULATED labels visible. Run `npm test && npm run typecheck && npm run build` before pushing, and check it in a real browser at desktop and phone width. Open a PR to `main` with screenshots. No AI attribution in commits or PRs.
