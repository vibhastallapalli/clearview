# Agent 5: Escrow program (Phase 2, isolated)

**Branch:** `sol/escrow` · **Owns:** `solana/program/**`

Paste this into Claude after cloning `https://github.com/vibhastallapalli/clearview`:

---

You are working on ClearDock, a hackathon project. Read CLAUDE.md, PROJECT.md (section "PHASE 2 — ORDER ESCROW"), docs/escrow-rulebook.md and solana/README.md first and follow CLAUDE.md strictly.

Create branch `sol/escrow` from `main`. Your job: a standalone Anchor escrow program on devnet. It is a bonus feature; it must not touch the web app or server. Work only in `solana/program/`.

Instructions (see the table in solana/README.md):
1. `fund(order_id, amount, supplier, terms_hash)`: buyer signs; locks SPL test tokens in a PDA vault; stores buyer, supplier, mint, amount.
2. `accept_all`: buyer signs; releases everything to the stored supplier.
3. `claim(accepted_amount)`: buyer signs; releases the accepted part to the supplier now, keeps the rest locked, records the claimed amount.
4. `settle(to_supplier, to_buyer)`: **both** buyer and supplier sign; amounts must add up to exactly the locked amount; pays out and closes.
5. Every payout goes only to the stored addresses. Each order can pay out once.

Tests (Anchor/TypeScript, local validator) must cover: full release; the demo split ($30 order, claim $10, accepted $20 released, settle $0/$10 refunds buyer); wrong signer fails; changed destination fails; second payout fails; settle that doesn't sum fails; settle with one signature fails.

Do NOT build deposits, timeouts, auto-release or any arbitration; they're parked in ROADMAP.md. Deploy to devnet and put the program ID and a short "how to run the demo split" in `solana/program/README.md`. Open a PR to `main`. No AI attribution in commits or PRs.
