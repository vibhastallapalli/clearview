# Escrow rulebook (Phase 2): DECIDED

Build from this; don't reopen it. Only after the direct-payment milestone works.

## Short version

- **Normal order:** buyer scans, everything matches, buyer accepts, supplier gets paid.
- **Something's off:** the scan flags it, the buyer claims just those lines. Everything else pays the supplier right away.
- **Both agree on a fix:** refund, replacement or return. Solana pays out exactly what both signed.
- **Wrong or damaged goods:** goods go back, money goes back.
- **They can't agree:** the disputed money stays held. They take the evidence elsewhere. The app never picks a winner.

**The rule behind all of it: the buyer's scan can open a claim but can never refund itself. Only signatures move money.**

**Demo:** $30 order, one bag missing. Buyer claims $10, supplier agrees, Solana pays $20 and refunds $10.

## Agreed upfront (both sign before funding)

Items, quantities, price · carrier/tracking (clock starts at "delivered", simulated in demo) · inspection window (e.g. 3 days).

## Rules

1. **Receiving report.** AI suggests which lines match. Suggestions only.
2. **Buyer confirms or claims** per line inside the window. A claim never refunds by itself.
3. **No claim, no hold.** Window passes with no claim → full release. *(Not in demo.)*
4. **Partial release.** Accepted lines pay immediately; only claimed amounts stay locked.
5. **Settlement by matching signatures.** Offer → accept/counter. Both sign the same offer → program executes it. Must account for all locked funds; each order pays out once.
6. **Offers expire; money doesn't move.** Silence never executes the other side's offer.
7. **Wrong/damaged goods unwind.** Return scanned by supplier; supplier's signed acceptance releases the refund. Replacements: buyer scans + signs to release.
8. **Unresolved stays unresolved.** No automatic split.
9. **Factual history** recorded for both sides (outcomes, not fault).

## Settlement offer format

Order + disputed line · `toSupplierMinor` + `toBuyerMinor` = locked amount · return/replace flag · expiry.
Kinds: `full_refund`, `full_release`, `split`, `replacement`, `cancel_with_return`.

## Say honestly

- Scans are buyer-submitted evidence; nothing stops hiding a box before scanning.
- Labels don't prove what's inside sealed packages.
- Deadlock is possible; parties take the evidence file to a lawyer / small claims / their contract.
- The program enforces money only, not law.

**Pitch:** ClearDock turns delivery discrepancies into evidence both parties can review, then executes their agreed settlement on Solana.

**"What if the buyer lies?"** The scan is evidence, not a verdict. The supplier is paid for every line the buyer accepts, the buyer's scan can open a claim but never refund itself, and no disputed money moves without the supplier's signature.
