import { useEffect } from "react";
import { Link } from "react-router-dom";
import type { LineVerdict, OrderDetail } from "@cleardock/shared";
import { money } from "../api";
import { short } from "../format";
import {
  ESCROW_STATUS,
  OFFERS,
  PARTY,
  acceptRequest,
  claimRequest,
  claimedOf,
  historyFor,
  orderStatus,
  physicalRequest,
  proposeRequest,
  rejected,
  shortSig,
  totalOf,
  txUrl,
  usd,
  type DemoState,
  type EscrowEvent,
  type Tone,
} from "./demo";
import { useDemo } from "./DemoProvider";

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

export function EscrowWorkspace({ detail }: { detail: OrderDetail }) {
  const { role, ensure, peek, update, scan, sign } = useDemo();
  const orderId = detail.order.id;
  useEffect(() => ensure(orderId, detail), [ensure, orderId, detail]);
  const st = peek(orderId);
  if (!st) return null;

  const isBuyer = role === "buyer";
  const cpKey = isBuyer ? "supplier" : "buyer";
  const cp = PARTY[cpKey];
  const total = totalOf(st.lines);
  const L = st.esc.locked;
  const held = total - st.esc.released - st.esc.refunded - L;
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
    : `${PARTY.buyer.name} (synthetic) · buyer wallet ${PARTY.buyer.wallet} · ${items}`;
  const wait = waitCard(st, role, cp.name, curOffer?.label);
  const cpHistory = historyFor(cpKey, st);

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
          {st.step === "delivered" && isBuyer && (
            <section className="card">
              <span className="eyebrow">Step 1 · Receiving</span>
              <h2>Your delivery arrived. Scan it before you accept.</h2>
              <p className="body">
                Lay the bags out with labels facing up. SecuroServ compares what it sees with the purchase order and
                invoice. The scan is evidence only and can't move money.
              </p>
              <button className="primary" onClick={() => scan(orderId)}>
                Scan delivery
              </button>
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
                {detail.latestCapture && <img src={detail.latestCapture.imageUrl} alt="Delivery being scanned" />}
                <div className="scan-inset" />
                <div className="scan-line" />
              </div>
              <div className="busy">
                <span className="spinner" aria-hidden="true" /> Reading labels with Gemini… {!detail.latestScan && <Sim />}
              </div>
            </section>
          )}

          {st.step === "report" && isBuyer && (
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
              <button className="primary" onClick={() => sign(orderId, claimRequest(st))}>
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
                <button className="primary" onClick={() => sign(orderId, proposeRequest(st, role))}>
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
                <button className="primary" onClick={() => sign(orderId, acceptRequest(st))}>
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
              <button className="primary" onClick={() => sign(orderId, physicalRequest(st))}>
                {st.pending.act}
              </button>
            </section>
          )}

          {settled && st.outcome && (
            <section className="card card-strong">
              <span className="eyebrow ok-eyebrow">
                ✓ Executed {st.outcome.simulated ? <Sim /> : "on Solana devnet"}
              </span>
              <h2>{st.outcome.title}</h2>
              <div className="totals three">
                <div className="tint ok">
                  <span className="tint-label">Paid to supplier</span>
                  <span className="tint-value">{usd(st.outcome.sup)}</span>
                </div>
                <div className="tint info">
                  <span className="tint-label">Refunded to buyer</span>
                  <span className="tint-value">{usd(st.outcome.buy)}</span>
                </div>
                <div className="tint plain">
                  <span className="tint-label muted">Still locked</span>
                  <span className="tint-value">$0.00</span>
                </div>
              </div>
              <p className="note">
                {st.outcome.label
                  ? `Added to both parties' dispute record: shortage · 1 line · ${usd(st.outcome.claim)} · ${st.outcome.label.toLowerCase()} · resolved today. No fault is recorded.`
                  : "No dispute recorded for this order."}
              </p>
              {st.outcome.simulated ? (
                <span className="note">Simulated transaction {shortSig(st.outcome.sig)}: nothing was sent to devnet in this build.</span>
              ) : (
                <a className="strong-link" href={txUrl(st.outcome.sig)} target="_blank" rel="noreferrer">
                  View transaction on Solana Explorer ↗
                </a>
              )}
            </section>
          )}

          {!["delivered", "scanning"].includes(st.step) && <ReceivingReport detail={detail} />}
        </div>

        <div className="col-side">
          <section className="card card-side">
            <div className="row between">
              <span className="eyebrow">Escrow</span>
              <span className="row gap-6">
                <Sim />
                <span className={`pill ${escTone} pill-sm`}>{escLabel}</span>
              </span>
            </div>
            <div className="escrow-total">
              <span className="escrow-amount">{usd(total)}</span>
              <span className="muted">CDT funded by buyer</span>
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
              {st.events.map((e, i) => (
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
  return (
    <section className="card card-report">
      <div className="row between wrap">
        <h3>Receiving report</h3>
        <span className="row gap-6">
          {!real && <Sim />}
          <span className="pill info pill-sm">AI suggestion · Gemini</span>
        </span>
      </div>
      <div className="report-photo">
        {latestCapture ? <img src={latestCapture.imageUrl} alt="Delivery capture used for this report" /> : <span>Demo scan · no photo</span>}
      </div>
      <p className="caption">
        {latestCapture
          ? `${latestCapture.source} capture · ${new Date(latestCapture.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })} · sha256 ${latestCapture.imageSha256.slice(0, 10)}…`
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

function waitCard(st: DemoState, role: "buyer" | "supplier", cpName: string, offerLabel?: string): [string, string, string] | null {
  const isBuyer = role === "buyer";
  if (st.step === "delivered" && !isBuyer)
    return [
      "Waiting on buyer",
      `${cpName} hasn't inspected the delivery yet.`,
      "The inspection window is 3 days from the carrier's delivered event. Every line they accept pays you right away.",
    ];
  if (st.step === "scanning" && !isBuyer) return ["Receiving", `${cpName} is scanning the delivery…`, "You'll see the same receiving report they do."];
  if (st.step === "report" && !isBuyer)
    return [
      "Receiving report ready",
      `${cpName} is reviewing the report.`,
      "The scan found 1 bag of Product A missing and a Product B bag that wasn't ordered. The buyer can accept lines or claim them. A claim can't refund them without your signature.",
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
