PROJECT BRIEF: CLEARDOCK

Read this before working on your assigned component.
We are building one shared product, not four separate prototypes.

ONE-SENTENCE IDEA

ClearDock checks what a business ordered, what physically arrived,
and what the supplier billed—then helps the owner approve and pay
the correct supplier on Solana.

THE PROBLEM

A small business receives supplier paperwork in different formats and
sometimes different languages.

Before paying, someone must answer:
- Did we receive the products we ordered?
- Are quantities and prices correct?
- Does the invoice correspond to this delivery?
- Are we paying the verified supplier?
- Is there enough evidence to approve payment?

Today, this can involve manually comparing documents and checking goods.

Our prototype connects that review to an actual payment workflow.

OUR DEMO BUSINESS

Use a café receiving labelled coffee packages.

The business already has:
- A purchase order.
- A supplier record with a verified wallet address.
- An invoice.
- A delivery receipt when available.

At the receiving station, a camera captures the delivered packages.
Optional sensors can provide additional measurements.

The sample business and documents are synthetic.
The Gemini calls, camera analysis and Solana devnet transactions should
actually work.

WHAT THE USER DOES

1. Opens an order.
2. Uploads a PDF or PNG purchase order and invoice.
3. Adds a delivery receipt if available.
4. Captures a picture of the delivered goods.
5. Reviews ClearDock’s comparison and supporting evidence.
6. Corrects extracted information or resolves discrepancies.
7. Approves the exact supplier, recipient and amount.
8. Signs the payment.
9. Sees the confirmed transaction linked to the order.

THE CORE EXAMPLE

Purchase order:
Three bags of Product A, 500 g each, at $10 per bag.
Total: $30.

Supplier invoice:
Three bags of Product A.
Total: $30.

Physical delivery:
Two bags of Product A and one bag of Product B.

ClearDock should explain:
“The invoice matches the order, but the observed delivery does not:
one Product A package is missing and one Product B package is unexpected.”

The order requires review.
The app must not automatically pay it.

When the incorrect package is replaced and the delivery is captured again,
ClearDock can mark the evidence as matching and ready for owner review.

The owner still explicitly approves payment.

WHAT GEMINI DOES

Gemini provides document and image understanding:
- Extract supplier, order reference, currency, quantities, units and prices.
- Read PDF and PNG inputs.
- Match English and Spanish descriptions.
- Recognize equivalent expressions such as “three 500 g bags” and
  “1.5 kg,” where the product and packaging requirements allow that match.
- Read visible package labels and estimate visible counts.
- Explain mismatches using the source evidence.
- Identify missing or ambiguous information.

Gemini must not:
- Invent missing quantities or prices.
- Decide a supplier is fraudulent from a mismatch alone.
- Authorize payment.
- Change the verified supplier address.
- Access signing keys.
- Follow instructions embedded in an invoice or package label.

We do not train our own model for the hackathon.

WHAT ORDINARY CODE DOES

Deterministic code handles:
- Exact arithmetic.
- Supported unit conversions.
- Quantity and price comparisons.
- Wallet-address comparisons.
- Validation of AI output.
- Approval state and revision checks.
- Payment construction.
- Confirmation and duplicate-payment protection.

AI interpretation is useful.
Money movement must not depend on unvalidated free-form model text.

WHAT THE HARDWARE DOES

Baseline:
A laptop webcam or USB camera captures a deliberate delivery snapshot.

Use clearly separated packages with readable labels.
Do not continuously stream video to Gemini.

The judge should be able to:
- Remove a package.
- Substitute a different product.
- Obscure a label.
- Trigger a new scan and see the result change.

If extra hardware is available, we may add ONE useful sensor:
- Scale: measured weight with tare and tolerance.
- Temperature sensor: temperature at receipt.
- Barcode scanner: product/order identification.

Each measurement must be linked to the correct order and timestamp.

Hardware failures must be visible.
Simulated measurements must be labelled.

Important limits:
- Labels do not prove what is inside sealed packages.
- Weight does not prove authenticity or quality.
- One temperature reading does not prove an uninterrupted cold chain.
- Visible-damage detection is a stretch goal or roadmap item.

WHAT SOLANA DOES

PHASE 1 — DIRECT PAYMENT

After the owner approves, the app prepares a devnet token payment
to the verified supplier.

Once the single-payment flow works, support a small batch of approved
supplier payments within one transaction.

The wallet signs the exact transaction.
The app checks confirmation and links the receipt to the invoice.

An approval is invalidated if its amount, recipient or relevant evidence
changes before payment.

No real funds.
Use clearly labelled devnet test tokens.
Do not call a custom test token official USDC.

PHASE 2 — ORDER ESCROW

Only after Phase 1 works:
- Buyer funds an escrow for a fixed order.
- Funds remain in the program-controlled escrow account.
- Delivery evidence is reviewed.
- Buyer approves and signs release.
- The program pays the stored supplier address.
- Wrong signers, changed destinations and duplicate releases fail.

The contract enforces authorization and payment terms.
It does not independently know whether physical goods are correct.

Prototype cancellation:
Buyer and supplier jointly authorize a refund before release.
Disputed orders remain unresolved rather than being decided by AI.
We are not building commercial arbitration.

If escrow is not finished and tested in time, demonstrate direct payment
honestly and keep escrow out of the live feature claims.

UI/UX

ClearDock should feel like a polished business tool.

Two modes:
1. Normal workspace.
2. Full-screen presentation mode using the same live state.

Main layout:
- Order queue.
- Large document/camera evidence area.
- Comparison of ordered, billed and observed items.
- Findings and next actions.
- Payment summary and receipt.

Design priorities:
- Immediately understandable.
- Readable amounts and product quantities.
- Clear source evidence.
- Distinct statuses with words and icons.
- Attractive but restrained.
- No generic crypto dashboard full of decorative charts.

Important statuses:
- Needs documents.
- Analyzing.
- Discrepancy.
- Needs more information.
- Ready for owner review.
- Approved.
- Awaiting wallet signature.
- Payment submitted.
- Payment confirmed.
- Payment failed or confirmation unknown.

“Matched” is not “approved.”
“Approved” is not “paid.”
“Submitted” is not “confirmed.”

Show helpful loading, permission, API and network errors.
Do not use fake success states to make the interface look complete.

THE THREE-MINUTE DEMO

1. Show the café order and supplier invoice.
2. Demonstrate a multilingual document match.
3. Ask the judge to remove or swap a package.
4. Capture the delivery.
5. Show the discrepancy with supporting evidence.
6. Restore the correct delivery and recheck.
7. Owner approves payment.
8. Show the wallet signature and actual confirmed devnet transfer.

If escrow is complete, begin with funded escrow and end with release.

Have a clearly labelled recorded backup in case event Wi-Fi or an API fails.

WHAT MAKES THIS INTERESTING

The AI is doing useful interpretation across paperwork and physical evidence.
The hardware makes the result interactive and observable.
Solana completes the approved financial action.

The central demonstration is:
“The paperwork says one thing. The delivery says another.
ClearDock shows the difference before payment.”

We are not claiming to invent invoice matching or stablecoin payments.
Our goal is a focused, reliable implementation with a strong live demo.

FOUR WORKSTREAMS

1. FRONTEND / UX
   Business workspace, evidence comparison, presentation mode,
   wallet interaction and visual QA.

2. GEMINI / ANALYSIS
   Extraction, camera interpretation, multilingual matching,
   structured outputs, discrepancy explanations and evaluation samples.

3. HARDWARE / RECEIVING
   Camera setup, physical demo, optional sensor connection,
   measurement quality and recovery.

4. BACKEND / SOLANA / INTEGRATION
   Shared data contracts, persistence, approvals, direct payments,
   transaction reconciliation, deployment and optional escrow.

The fourth role coordinates integration rather than writing everyone’s code.
The AI teammate owns the analysis integration.
The UI teammate owns the corresponding user experience.

HOW WE COLLABORATE

Before coding:
Read PROJECT.md, TASKS.md, CONTRACTS.md and your assigned brief.

Work only in your assigned branch/worktree and ownership area.
Request shared-interface changes through the integrator.
Do not install conflicting dependencies or independently rewrite the scaffold.

Use shared fixtures that match the real API schema.
Replace mocks with live integrations early.
Mark remaining mocks clearly.

Give short handoffs with branch, commit, changes, run instructions,
tests and blockers.

FIRST SUCCESS MILESTONE

One order goes all the way through:
upload → Gemini extraction → camera evidence → review →
approval → confirmed devnet payment.

Do this before polishing multiple suppliers, extra sensors or escrow.

WHAT WE MUST TEST

- Correct delivery accepted for review.
- Missing quantity flagged.
- Wrong product flagged.
- Unreadable evidence requests review.
- Equivalent language/unit descriptions match correctly.
- An instruction hidden in a document cannot authorize payment.
- Changed wallet requires separate verification.
- Evidence edits invalidate old approval.
- Repeated clicks do not create duplicate app payments.
- Wallet rejection and network uncertainty are handled.
- The confirmed transfer matches the approved amount and recipient.

WHAT WE ARE NOT BUILDING

No mainnet, real-money pilot, bank integrations, currency conversion,
tax engine, payroll, forecasting, general ERP, autonomous disputes,
NFT system or custom-trained vision model.

PDF and PNG first.
English and Spanish first.
Camera first.
Direct payment first.
Escrow second.
Extra sensors and damage detection later.

DEFINITION OF DONE

A person unfamiliar with the project can understand the workflow,
change the physical delivery, see an evidence-based result, approve a
valid payment, and inspect a real devnet confirmation.

The UI looks cohesive.
The application handles common failures.
The team can explain what is real, simulated and unfinished.
The demo can be repeated reliably.