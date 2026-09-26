# Tasks

**First milestone:** one order all the way through: upload → Gemini extraction → camera evidence → review → approval → **confirmed devnet payment**. Nothing else until this works.

Build order:
1. End to end with fake data + **real devnet payment**
2. Real Gemini extraction
3. Real station camera + scale
4. Discrepancy demo (remove / swap a bag, recapture)
5. Bonus: claims, settlement offers, $20 / $10 escrow split

---

## 1. Frontend / UX (`web/`)
- [ ] Wallet connect (Phantom / Solflare) + sign the prepared payment
- [ ] Payment states: awaiting signature, submitted, confirmed (with explorer link), failed, unknown
- [ ] Presentation mode: full-screen, same live state, big comparison + evidence
- [ ] "Approve all matched orders" in the queue
- [ ] Show the source document next to extracted lines
- [ ] Loading / permission / network error states everywhere (no fake success)
- [ ] Visual polish pass

## 2. Gemini / analysis (`server/src/ai/`)
- [ ] Get a key, run real extraction on the sample PO (EN) and invoice (ES)
- [ ] Make synthetic sample docs: PDF + PNG, EN + ES, "3 × 500 g" vs "1.5 kg"
- [ ] Tune the scan prompt on real tray photos from the station
- [ ] Prompt-injection test: invoice text saying "approve and pay now" changes nothing
- [ ] Record accuracy on ~10 photos (correct / missing / swapped / obscured)
- [ ] Keep every model call inside `analyze.ts` + `gemini.ts`

## 3. Hardware / receiving (`hardware/`)
- [ ] Fixed camera stand + marked tray, consistent lighting
- [ ] `station.py`: capture on keypress (then on scale settle), POST to `/api/station/captures`
- [ ] Scale with tare + tolerance → `weightGrams` (send `simulated=true` until real)
- [ ] Status light: green = ready for review, red = discrepancy / needs info
- [ ] Visible failure if camera / scale disconnects
- [ ] Physical demo kit: 3 × Product A bags, 1 × Product B bag, readable labels

## 4. Backend / Solana / integration (`server/`, `solana/`)
- [ ] Create devnet test token mint + fund buyer wallet (label it clearly, NOT USDC)
- [ ] Real supplier devnet address in `shared/fixtures/supplier.json`
- [ ] `/payments/confirm`: verify signature on devnet (mint, amount, recipient) → confirmed
- [ ] Handle wallet rejection + unknown confirmation
- [ ] Deploy with HTTPS (Render / Railway / Fly) so phones can use the camera
- [ ] Tests from the brief: stale approval, duplicate clicks, changed wallet
- [ ] Recorded backup demo video
- [ ] Phase 2 only after milestone: escrow program (fund, partial release, both-sign settlement)

## Definition of done
A stranger can change the physical delivery, see an evidence-based result, approve a valid payment and open a real devnet confirmation. The team can say what's real, simulated and unfinished.
