import { useEffect } from "react";
import { Link } from "react-router-dom";
import type { EscrowRecord, LineVerdict, OrderDetail } from "@cleardock/shared";
import { money } from "../api";
import { short } from "../format";
import {
  ESCROW_STATUS,
  OFFERS,
  PARTY,
  acceptRequest,
  linesStale,
  reviewedClaim,
  claimedOf,
  fundRequest,
  historyFor,
  orderStatus,
  physicalRequest,
  proposeRequest,
  rejected,
  scanned,
  shortSig,
  totalOf,
  txUrl,
  usd,
  type ChainAction,
  type DemoState,
  type EscrowEvent,
  type OfferId,
  type Tone,
} from "./demo";
import { useDemo } from "./DemoProvider";
import { ProofPanel } from "../proof/ProofPanel";

const VERDICT: Record<LineVerdict, (discrepancyMinor: number) => [string, Tone]> = {
  match: () => ["✓ Match", "ok"],
  missing: (d) => [`! Missing · ${money(d)}`, "bad"],
  over: () => ["! Extra", "warn"],
  unexpected: () => ["! Not ordered", "warn"],
  billed_mismatch: () => ["! Billing differs", "bad"],
  price_mismatch: () => ["! Price differs", "bad"],
  unknown: () => ["? Unknown", "warn"],
};

const Sim = () => <span className="sim">SIMULATED</span>;

const CHAIN_EVENT: Record<string, string> = {
  fund: "Buyer funded escrow",
  accept_all: "Buyer accepted every line",
  claim: "Buyer accepted lines and filed a claim",
  settle: "Settlement signed by buyer and supplier",
};

// Money figures come from the server's verified copy of the on-chain escrow account.
function escFrom(e: EscrowRecord): DemoState["esc"] {
  const held = e.totalMinor - e.releasedMinor - e.refundedMinor;
  return { released: e.releasedMinor, refunded: e.refundedMinor, locked: e.status === "claimed" ? held : 0, status: e.status };
}

export function EscrowWorkspace({ detail }: { detail: OrderDetail }) {
  const { role, ensure, peek, update, scan, sign } = useDemo();
  const orderId = detail.order.id;
  const onChain = detail.order.escrow;
  const chainStatus = onChain?.status;
  useEffect(() => ensure(orderId, detail), [ensure, orderId, detail]);
  // Follow the chain if it moved on without this browser (reload, other device).
  useEffect(() => {
    if (!chainStatus) return;
    update(orderId, (s) => {
      if (chainStatus === "claimed" && ["delivered", "scanning", "report"].includes(s.step)) return { step: "claimed" };
      if ((chainStatus === "released" || chainStatus === "settled") && s.step !== "settled") return { step: "settled" };
      return {};
    });
  }, [chainStatus, orderId, update]);
  const local = peek(orderId);
  if (!local) return null;
  const st: DemoState = onChain ? { ...local, esc: escFrom(onChain) } : local;

  const isBuyer = role === "buyer";
  // The station scan is the authoritative delivery evidence; phone photos are only proof for it.
  const stationReport = detail.latestCapture?.source === "station" && !!detail.latestScan && !!detail.order.comparison;
  const cpKey = isBuyer ? "supplier" : "buyer";
  const cp = PARTY[cpKey];
  const total = onChain?.totalMinor ?? totalOf(st.lines);
  const L = st.esc.locked;
  const settleChain = (id: OfferId): ChainAction => {
    const sup = Math.round(L * OFFERS.find((o) => o.id === id)!.sup);
    return { action: "settle", toSupplier: sup, toBuyer: L - sup };
  };
  const held = onChain ? total - st.esc.released - st.esc.refunded - L : 0;
  const [stLabel, stTone] = orderStatus(st);
  const [escLabel, escTone] = ESCROW_STATUS[st.esc.status];
  const isProposer = st.offer?.by === role;
  const curOffer = st.offer ? OFFERS.find((o) => o.id === st.offer!.id)! : null;
  const claimed = claimedOf(st.lines);
  const settled = st.step === "settled";
  const pct = (v: number) => `${total ? (v / total) * 100 : 0}%`;
  const items = itemsLine(detail);
  const cpLine = isBuyer
    ? `${detail.supplier.name} · verified wallet ${short(detail.supplier.walletAddress)} · ${items}`
    : `${PARTY.buyer.name} (synthetic) · buyer wallet ${onChain ? short(onChain.buyer) : PARTY.buyer.wallet} · ${items}`;
  const wait = onChain
    ? waitCard(st, role, cp.name, curOffer?.label, stationReport ? detail.order.comparison!.summary : null)
    : isBuyer
      ? null
      : (["Waiting on buyer", `${cp.name} hasn't funded the escrow yet.`, "Once they lock the order total on devnet, you're guaranteed payment for every line they accept."] as [string, string, string]);
  const outcome =
    onChain && settled
      ? {
          title:
            onChain.status === "released"
              ? `Accepted in full. Supplier paid ${usd(onChain.releasedMinor)}.`
              : `Both signed. Supplier paid ${usd(onChain.releasedMinor)}, buyer refunded ${usd(onChain.refundedMinor)}.`,
          label: local.outcome?.label ?? (onChain.claimedMinor ? "Settlement" : undefined),
          sup: onChain.releasedMinor,
          buy: onChain.refundedMinor,
          sig: onChain.events.at(-1)?.signature ?? "",
          simulated: false,
          claim: onChain.claimedMinor,
        }
      : st.outcome;
  const cpHistory = historyFor(cpKey, st);
  // Verified on-chain events this browser didn't sign itself (reload, other device).
  const seen = new Set(st.events.map((e) => e.sig));
  const timeline: EscrowEvent[] = [
    ...st.events,
    ...(onChain?.events ?? [])
      .filter((e) => !seen.has(e.signature))
      .map((e) => ({
        label: CHAIN_EVENT[e.action] ?? e.action,
        detail: "Verified on devnet by ClearDock",
        at: new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
        sig: e.signature,
        sim: false,
      })),
  ];

  return (
    <>
      <div className="order-head">
        <div className="order-title">
          <div className="row wrap">
            <h1>{detail.order.reference}</h1>
            <span className={`pill ${stTone}`}>{stLabel}</span>
          </div>
          <p className="lead">{cpLine}</p>
        </div>
        <div className="row wrap">
          <span className="pill-plain">
            Carrier delivered 10:42 · <b className="sim-inline">SIMULATED</b>
          </span>
          <span className="pill-plain">{settled ? "Inspection closed" : "Inspection window · 2 d 23 h left"}</span>
        </div>
      </div>

      <div className="cols">
        <div className="col-main">
          {!onChain && isBuyer && (
            <section className="card">
              <span className="eyebrow">Step 0 · Escrow</span>
              <h2>Lock {usd(total)} CDT in escrow before the delivery.</h2>
              <p className="body">
                The escrow program on Solana devnet holds the money. It can only pay the verified supplier wallet, and the
                amount you dispute moves only when you both sign.
              </p>
              <button className="primary" onClick={() => sign(orderId, fundRequest(st, detail.order.reference), detail)}>
                Fund escrow with Phantom
              </button>
            </section>
          )}

          {onChain && st.step === "delivered" && isBuyer && (
            <section className="card">
              <span className="eyebrow">Step 1 · Receiving</span>
              {stationReport ? (
                <>
                  <h2>The receiving station scanned your delivery.</h2>
                  <p className="body">
                    The station compared what it saw with the purchase order and invoice. Review its report, then accept
                    or claim each line. The scan is evidence only and can't move money.
                  </p>
                  <button className="primary" onClick={() => update(orderId, (s) => scanned(s, detail))}>
                    Review station report
                  </button>
                </>
              ) : (
                <>
                  <h2>Your delivery arrived. Scan it at the receiving station.</h2>
                  <p className="body">
                    Put the bags on the station tray with labels facing up. The report appears here when the station has
                    scanned them. You can add phone photos as proof after that.
                  </p>
                  <div className="busy">
                    <span className="spinner" aria-hidden="true" /> Waiting for a station scan…
                  </div>
                  <button className="secondary sm" onClick={() => scan(orderId)}>
                    Use the demo scan instead <Sim />
                  </button>
                </>
              )}
            </section>
          )}

          {wait && (
            <section className="card">
              <span className="eyebrow">{wait[0]}</span>
              <h2 className="h2-sm">{wait[1]}</h2>
              <p className="body">{wait[2]}</p>
            </section>
          )}

          {st.step === "scanning" && isBuyer && (
            <section className="card card-tight">
              <div className="scan-frame">
                <div className="scan-inset" />
                <div className="scan-line" />
              </div>
              <div className="busy">
                <span className="spinner" aria-hidden="true" /> Demo scan, no photo is being analysed <Sim />
              </div>
            </section>
          )}

          {st.step === "report" && isBuyer && linesStale(st, detail) && (
            <section className="card">
              <span className="eyebrow">Step 2 · Accept or claim</span>
              <p className="error">
                The station scanned this delivery again (scan {detail.order.latestScanId}, revision{" "}
                {detail.order.evidenceRevision}). Your earlier accept/claim choices were based on the previous scan and
                have been set aside. Review the new report before signing anything.
              </p>
              <button className="primary" onClick={() => update(orderId, (s) => scanned(s, detail))}>
                Review the new station report
              </button>
            </section>
          )}

          {st.step === "report" && isBuyer && !linesStale(st, detail) && (
            <section className="card">
              <span className="eyebrow">Step 2 · Accept or claim</span>
              <h2>Accept what arrived. Claim what didn't.</h2>
              <div className="stack-8">
                {st.lines.map((l) => (
                  <div key={l.id} className="line-row">
                    <div className="line-text">
                      <span className="line-label">{l.label}</span>
                      <span className={l.miss ? "line-sub miss" : "line-sub"}>{l.sub}</span>
                    </div>
                    <span className="line-price">{usd(l.priceMinor)}</span>
                    <div className="seg seg-sm" role="group" aria-label={`${l.label}: accept or claim`}>
                      <button
                        className={l.claim ? "" : "on accept"}
                        aria-pressed={!l.claim}
                        onClick={() => update(orderId, (s) => ({ lines: s.lines.map((x) => (x.id === l.id ? { ...x, claim: false } : x)) }))}
                      >
                        Accept
                      </button>
                      <button
                        className={l.claim ? "on claim" : ""}
                        aria-pressed={l.claim}
                        onClick={() => update(orderId, (s) => ({ lines: s.lines.map((x) => (x.id === l.id ? { ...x, claim: true } : x)) }))}
                      >
                        Claim
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="totals">
                <div className="tint ok">
                  <span className="tint-label">Pays supplier now</span>
                  <span className="tint-value">{usd(total - claimed)}</span>
                </div>
                <div className="tint warn">
                  <span className="tint-label">Stays locked for your claim</span>
                  <span className="tint-value">{usd(claimed)}</span>
                </div>
              </div>
              <p className="note">Filing a claim locks money. It never refunds you by itself: the supplier has to sign too.</p>
              <button
                className="primary"
                onClick={() => sign(orderId, reviewedClaim(st, detail, total), detail)}
              >
                {claimed ? `Sign: release ${usd(total - claimed)}, claim ${usd(claimed)}` : `Sign: accept all · release ${usd(total)}`}
              </button>
            </section>
          )}

          {(st.step === "claimed" || (st.step === "offer" && !isProposer && st.countering)) && (
            <section className="card">
              <span className="eyebrow">Step 3 · Settle the claim</span>
              <h2>
                {st.countering
                  ? `Counter ${cp.name}'s offer`
                  : `${usd(L)} is locked for ${Math.round(L / 1000)} claimed bag${Math.round(L / 1000) === 1 ? "" : "s"} of Product A.`}
              </h2>
              <p className="body">Pick an offer. No money moves until you both sign the same one.</p>
              {st.rejected && st.step === "claimed" && (
                <p className="notice warn">The last offer was rejected. The locked amount stays locked until you both agree.</p>
              )}
              <div className="stack-8" role="radiogroup" aria-label="Settlement offer">
                {OFFERS.map((o) => {
                  const sel = st.pick === o.id;
                  const sup = Math.round(L * o.sup);
                  return (
                    <div
                      key={o.id}
                      className={sel ? "radio-card on" : "radio-card"}
                      role="radio"
                      aria-checked={sel}
                      tabIndex={0}
                      onClick={() => update(orderId, { pick: o.id })}
                      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), update(orderId, { pick: o.id }))}
                    >
                      <span className="radio-dot" aria-hidden="true">
                        <span />
                      </span>
                      <div className="radio-text">
                        <span className="radio-label">{o.label}</span>
                        <span className="radio-desc">{o.desc}</span>
                        <span className="radio-split">
                          {usd(sup)} to supplier · {usd(L - sup)} to buyer
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="row wrap">
                <button className="primary" onClick={() => sign(orderId, proposeRequest(st, role), detail)}>
                  {st.countering ? "Sign & send counter-offer" : "Sign & send offer"}
                </button>
                {st.countering && (
                  <button className="secondary" onClick={() => update(orderId, { countering: false })}>
                    Back
                  </button>
                )}
              </div>
            </section>
          )}

          {st.step === "offer" && !isProposer && !st.countering && curOffer && (
            <section className="card">
              <span className="eyebrow">Settlement offer · expires in 24 h</span>
              <h2>
                {PARTY[st.offer!.by].name} offers: {curOffer.label}
              </h2>
              <p className="body">{curOffer.desc}</p>
              <div className="totals">
                <div className="tint plain">
                  <span className="tint-label muted">To supplier</span>
                  <span className="tint-value">{usd(Math.round(L * curOffer.sup))}</span>
                </div>
                <div className="tint plain">
                  <span className="tint-label muted">Back to buyer</span>
                  <span className="tint-value">{usd(L - Math.round(L * curOffer.sup))}</span>
                </div>
              </div>
              <div className="row wrap">
                <button
                  className="primary"
                  onClick={() =>
                    sign(orderId, curOffer.phys ? acceptRequest(st) : { ...acceptRequest(st), chain: settleChain(curOffer.id) }, detail)
                  }
                >
                  Accept &amp; sign
                </button>
                <button
                  className="secondary"
                  onClick={() => update(orderId, { countering: true, pick: curOffer.id === "refund" ? "replacement" : "refund" })}
                >
                  Counter
                </button>
                <button className="danger-link" onClick={() => update(orderId, (s) => rejected(s, role))}>
                  Reject
                </button>
              </div>
            </section>
          )}

          {st.step === "physical" && st.pending && st.pending.who === role && (
            <section className="card">
              <span className="eyebrow">Both signed · {st.pending.label}</span>
              <h2>{st.pending.wait}</h2>
              <p className="body">{st.pending.text}</p>
              <button className="primary" onClick={() => sign(orderId, { ...physicalRequest(st), chain: settleChain(st.pending!.id) }, detail)}>
                {st.pending.act}
              </button>
            </section>
          )}

          {settled && outcome && (
            <section className="card card-strong">
              <span className="eyebrow ok-eyebrow">
                ✓ Executed {outcome.simulated ? <Sim /> : "on Solana devnet"}
              </span>
              <h2>{outcome.title}</h2>
              <div className="totals three">
                <div className="tint ok">
                  <span className="tint-label">Paid to supplier</span>
                  <span className="tint-value">{usd(outcome.sup)}</span>
                </div>
                <div className="tint info">
                  <span className="tint-label">Refunded to buyer</span>
                  <span className="tint-value">{usd(outcome.buy)}</span>
                </div>
                <div className="tint plain">
                  <span className="tint-label muted">Still locked</span>
                  <span className="tint-value">$0.00</span>
                </div>
              </div>
              <p className="note">
                {outcome.label
                  ? `Added to both parties' dispute record: shortage · 1 line · ${usd(outcome.claim)} · ${outcome.label.toLowerCase()} · resolved today. No fault is recorded.`
                  : "No dispute recorded for this order."}
              </p>
              {outcome.simulated ? (
                <span className="note">Simulated transaction {shortSig(outcome.sig)}: nothing was sent to devnet in this build.</span>
              ) : (
                <a className="strong-link" href={txUrl(outcome.sig)} target="_blank" rel="noreferrer">
                  View transaction on Solana Explorer ↗
                </a>
              )}
            </section>
          )}

          {(stationReport || !["delivered", "scanning"].includes(st.step)) && <ReceivingReport detail={detail} />}
          {(stationReport || detail.proofs.length > 0) && <ProofPanel detail={detail} role={role} />}
        </div>

        <div className="col-side">
          <section className="card card-side">
            <div className="row between">
              <span className="eyebrow">Escrow</span>
              <span className="row gap-6">
                {onChain && <span className="pill-plain pill-sm">devnet · verified</span>}
                <span className={`pill ${escTone} pill-sm`}>{onChain ? escLabel : "Not funded"}</span>
              </span>
            </div>
            <div className="escrow-total">
              <span className="escrow-amount">{usd(total)}</span>
              <span className="muted">{onChain ? "CDT funded by buyer" : "CDT to fund"}</span>
            </div>
            <div className="bar" aria-hidden="true">
              <div className="bar-rel" style={{ width: pct(st.esc.released) }} />
              <div className="bar-ref" style={{ width: pct(st.esc.refunded) }} />
              <div className="bar-lock" style={{ width: pct(L) }} />
            </div>
            <div className="figs">
              <Fig swatch="rel" label="Released to supplier" value={usd(st.esc.released)} />
              <Fig swatch="ref" label="Refunded to buyer" value={usd(st.esc.refunded)} />
              <Fig swatch="lock" label="Locked by claim" value={usd(L)} />
              <Fig swatch="held" label="Held for inspection" value={usd(held)} />
            </div>
            <div className="divider" />
            <ol className="timeline">
              {timeline.map((e, i) => (
                <TimelineItem key={i} e={e} />
              ))}
            </ol>
          </section>

          <section className="card card-soft">
            <span className="eyebrow">{cp.name} · dispute record</span>
            <span className="record-summary">{cpHistory.summary}</span>
            <p className="note">A record of what happened, not a verdict. SecuroServ never decides who was at fault.</p>
            <Link to="/history" className="text-link">
              See full history →
            </Link>
          </section>
        </div>
      </div>
    </>
  );
}

function Fig({ swatch, label, value }: { swatch: string; label: string; value: string }) {
  return (
    <div className="fig">
      <span className="fig-label">
        <span className={`swatch ${swatch}`} aria-hidden="true" />
        {label}
      </span>
      <span className="fig-value">{value}</span>
    </div>
  );
}

function TimelineItem({ e }: { e: EscrowEvent }) {
  const kind = e.sim ? "sim" : e.sig ? "chain" : "plain";
  return (
    <li className="tl-item">
      <div className="tl-rail">
        <span className={`tl-dot ${kind}`} />
        <span className="tl-line" />
      </div>
      <div className="tl-body">
        <div className="row wrap gap-6">
          <span className="tl-label">{e.label}</span>
          {e.sim && <Sim />}
        </div>
        <span className="tl-detail">{e.detail}</span>
        <div className="tl-meta">
          <span>{e.at}</span>
          {e.sig &&
            (e.sim ? (
              <span>tx {shortSig(e.sig)}</span>
            ) : (
              <a href={txUrl(e.sig)} target="_blank" rel="noreferrer">
                tx {shortSig(e.sig)} ↗
              </a>
            ))}
        </div>
      </div>
    </li>
  );
}

function ReceivingReport({ detail }: { detail: OrderDetail }) {
  const { latestCapture, latestScan, order } = detail;
  const c = order.comparison;
  const real = !!(latestScan && c);
  const source = latestCapture?.source === "station" ? "Station scan" : latestCapture ? `${latestCapture.source} capture` : "Demo scan";
  return (
    <section className="card card-report">
      <div className="row between wrap">
        <h3>Receiving report</h3>
        <span className="row gap-6">
          {!real && <Sim />}
          {real && latestScan!.analyzedBy === "mock" && <span className="sim">MOCK AI</span>}
          <span className="pill info pill-sm">{source} · AI suggestion{real && latestScan!.analyzedBy !== "mock" ? " · Gemini" : ""}</span>
        </span>
      </div>
      <div className="report-photo">
        {latestCapture ? <img src={latestCapture.imageUrl} alt="Delivery capture used for this report" /> : <span>Demo scan · no photo</span>}
      </div>
      <p className="caption">
        {latestCapture
          ? `${latestCapture.source} capture · scan ${latestScan?.id ?? "—"} · rev ${order.evidenceRevision} · ${new Date(latestCapture.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })} · sha256 ${latestCapture.imageSha256.slice(0, 10)}…`
          : "Phone capture · 10:51 · signed in as Café Luma · sha256 3f9a1c07e2…"}
      </p>
      <p className="seen">
        <b>Seen:</b>{" "}
        {real
          ? latestScan!.observed.map((o) => `${o.count} × ${o.labelText}`).join(", ") || "nothing"
          : "2 × PRODUCT A · 500 g, 1 × PRODUCT B · 500 g"}
      </p>
      <div className="report-table" role="table" aria-label="Ordered, billed and seen">
        <div className="report-row head" role="row">
          <span role="columnheader">Product</span>
          <span role="columnheader" className="r">Ord.</span>
          <span role="columnheader" className="r">Billed</span>
          <span role="columnheader" className="r">Seen</span>
          <span role="columnheader">Result</span>
        </div>
        {real
          ? c!.lines.map((l, i) => {
              const [text, tone] = VERDICT[l.verdict](l.discrepancyMinor);
              return (
                <div key={i} className="report-row" role="row" title={l.explanation}>
                  <span role="cell">{l.description}</span>
                  <span role="cell" className="r">{l.ordered ?? "—"}</span>
                  <span role="cell" className="r">{l.billed ?? "—"}</span>
                  <span role="cell" className="r">{l.observed ?? "—"}</span>
                  <span role="cell">
                    <span className={`pill ${tone} pill-xs`}>{text}</span>
                  </span>
                </div>
              );
            })
          : [
              ["Product A · 500 g", "3", "3", "2", "! Missing 1 · $10.00", "bad"],
              ["Product B · 500 g", "—", "—", "1", "! Not ordered", "warn"],
            ].map(([p, o, b, s, text, tone]) => (
              <div key={p} className="report-row" role="row">
                <span role="cell">{p}</span>
                <span role="cell" className="r">{o}</span>
                <span role="cell" className="r">{b}</span>
                <span role="cell" className="r">{s}</span>
                <span role="cell">
                  <span className={`pill ${tone} pill-xs`}>{text}</span>
                </span>
              </div>
            ))}
      </div>
      <p className="caption-plain">
        {real ? c!.summary : "Invoice FACTURA-1001 billed 1,5 kg (3 bags of 500 g) at $10.00 per bag."}
      </p>
    </section>
  );
}

function itemsLine(detail: OrderDetail) {
  const c = detail.order.comparison;
  const ordered = c?.lines.filter((l) => l.ordered);
  if (ordered?.length) return ordered.map((l) => `${l.ordered} × ${l.description} at ${money(l.unitPriceMinor)}`).join(", ");
  return "3 × Product A 500 g at $10.00";
}

function waitCard(
  st: DemoState,
  role: "buyer" | "supplier",
  cpName: string,
  offerLabel?: string,
  stationSummary?: string | null,
): [string, string, string] | null {
  const isBuyer = role === "buyer";
  if (st.step === "delivered" && !isBuyer && stationSummary)
    return ["Station report ready", `${cpName}'s receiving station scanned the delivery.`, `${stationSummary} They haven't accepted or claimed any line yet.`];
  if (st.step === "delivered" && !isBuyer)
    return [
      "Waiting on buyer",
      `${cpName} hasn't inspected the delivery yet.`,
      "The inspection window is 3 days from the carrier's delivered event. Every line they accept pays you right away.",
    ];
  if (st.step === "scanning" && !isBuyer)
    return ["Receiving · demo scan", `${cpName} is running the simulated demo scan.`, "You'll see the same receiving report they do."];
  if (st.step === "report" && !isBuyer)
    return [
      "Receiving report ready",
      `${cpName} is reviewing the report.`,
      `${stationSummary ?? "The demo scan found 1 bag of Product A missing and a Product B bag that wasn't ordered."} The buyer can accept lines or claim them. A claim can't refund them without your signature.`,
    ];
  if (st.step === "offer" && st.offer?.by === role && offerLabel)
    return [
      "Offer sent · expires in 24 h",
      `Waiting for ${cpName} to answer your ${offerLabel.toLowerCase()} offer.`,
      "If they don't answer, the offer expires and no money moves.",
    ];
  if (st.step === "physical" && st.pending && st.pending.who !== role) return [`Both signed · ${st.pending.label}`, st.pending.wait, st.pending.text];
  return null;
}
