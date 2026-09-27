import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ComparisonLine, EscrowRecord, LineVerdict, OrderDetail } from "@cleardock/shared";
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
import { StationSimulator } from "./StationSimulator";

const VERDICT: Record<LineVerdict, (l: ComparisonLine) => [string, Tone]> = {
  match: () => ["Match", "ok"],
  missing: (l) => [`Missing ${(l.billed ?? 0) - (l.observed ?? 0)}`, "bad"],
  over: () => ["Extra", "warn"],
  unexpected: () => ["Not ordered", "warn"],
  billed_mismatch: () => ["Billing differs", "bad"],
  price_mismatch: () => ["Price differs", "bad"],
  unknown: () => ["Unknown", "warn"],
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
    ? `${detail.supplier.name} · ${short(detail.supplier.walletAddress)} · ${items}`
    : `${PARTY.buyer.name} (synthetic) · ${onChain ? short(onChain.buyer) : PARTY.buyer.wallet} · ${items}`;
  const wait = onChain
    ? waitCard(st, role, cp.name, curOffer?.label, stationReport ? detail.order.comparison!.summary : null)
    : isBuyer
      ? null
      : (["Awaiting buyer", `${cp.name} hasn't funded escrow yet`, "Accepted items pay out immediately."] as [string, string, string]);
  const outcome =
    onChain && settled
      ? {
          title: onChain.status === "released" ? "Accepted in full" : "Settlement complete",
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
            Delivered 10:42 · <b className="sim-inline">Simulated</b>
          </span>
          <span className="pill-plain">{settled ? "Inspection closed" : "Inspection · 2d 23h left"}</span>
        </div>
      </div>

      <div className="cols">
        <div className="col-main">
          {!onChain && isBuyer && (
            <section className="card">
              <span className="eyebrow">Step 0 · Escrow</span>
              <h2>Fund escrow</h2>
              <p className="body">Lock {usd(total)} CDT on Solana devnet. It pays only the verified supplier wallet.</p>
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
                  <h2>Delivery scanned</h2>
                  <p className="body">The station matched it against the order and invoice. The scan can't move money.</p>
                  <button className="primary" onClick={() => update(orderId, (s) => scanned(s, detail))}>
                    Review items
                  </button>
                </>
              ) : (
                <>
                  <h2>Scan your delivery</h2>
                  <p className="body">Lay items out, labels up. We match them against the order and invoice.</p>
                  <div className="row wrap">
                    <button className="primary" onClick={() => scan(orderId)}>
                      Scan delivery
                    </button>
                    <span className="note">
                      Demo scan · <b className="sim-inline">Simulated</b>. A station scan replaces it.
                    </span>
                  </div>
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

          {st.step === "scanning" && isBuyer && <ScanningCard reference={detail.order.reference} />}

          {st.step === "report" && isBuyer && linesStale(st, detail) && (
            <section className="card">
              <span className="eyebrow">Step 2 · Review</span>
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
              <span className="eyebrow">Step 2 · Review</span>
              <h2>Review items</h2>
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
                        className={l.claim ? "accept-btn" : "accept-btn on accept"}
                        aria-pressed={!l.claim}
                        onClick={() => update(orderId, (s) => ({ lines: s.lines.map((x) => (x.id === l.id ? { ...x, claim: false } : x)) }))}
                      >
                        Accept
                      </button>
                      <button
                        className={l.claim ? "claim-btn on claim" : "claim-btn"}
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
                <div className="tint ok soft">
                  <span className="tint-label">Released now</span>
                  <span className="tint-value">{usd(total - claimed)}</span>
                </div>
                <div className="tint warn">
                  <span className="tint-label">Held for claim</span>
                  <span className="tint-value">{usd(claimed)}</span>
                </div>
              </div>
              <p className="note">Claimed funds are held until both parties agree.</p>
              <button
                className="primary"
                onClick={() => sign(orderId, reviewedClaim(st, detail, total), detail)}
              >
                {claimed ? `Release ${usd(total - claimed)} · Claim ${usd(claimed)}` : `Accept all · Release ${usd(total)}`}
              </button>
            </section>
          )}

          {(st.step === "claimed" || (st.step === "offer" && !isProposer && st.countering)) && (
            <section className="card">
              <span className="eyebrow">Step 3 · Settle</span>
              <h2>{st.countering ? "Counter offer" : `${usd(L)} held for claim`}</h2>
              <p className="body">Funds move only when both parties sign.</p>
              {st.rejected && st.step === "claimed" && <p className="notice warn">Offer rejected. Funds remain held.</p>}
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
                  {st.countering ? "Send counter" : "Send offer"}
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
              <span className="eyebrow">Offer · Expires in 24h</span>
              <h2>
                {curOffer.label} from {PARTY[st.offer!.by].name}
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
                  Accept
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
              <span className="eyebrow">Agreed · {st.pending.label}</span>
              <h2>{st.pending.wait}</h2>
              <p className="body">{st.pending.text}</p>
              <button className="primary" onClick={() => sign(orderId, { ...physicalRequest(st), chain: settleChain(st.pending!.id) }, detail)}>
                {st.pending.act}
              </button>
            </section>
          )}

          {settled && outcome && (
            <section className="card card-strong">
              <span className="eyebrow ok-eyebrow">Settled · {outcome.simulated ? <Sim /> : "Solana devnet"}</span>
              <h2>{outcome.title}</h2>
              <div className="totals three">
                <div className="tint ok">
                  <span className="tint-label">Paid to supplier</span>
                  <span className="tint-value">{usd(outcome.sup)}</span>
                </div>
                <div className="tint info">
                  <span className="tint-label">Refunded</span>
                  <span className="tint-value">{usd(outcome.buy)}</span>
                </div>
                <div className="tint plain">
                  <span className="tint-label muted">Still locked</span>
                  <span className="tint-value">$0.00</span>
                </div>
              </div>
              <p className="note">
                {outcome.label ? `Recorded as shortage · ${outcome.label.toLowerCase()}. No fault assigned.` : "No dispute recorded."}
              </p>
              {outcome.simulated ? (
                <span className="note">Simulated tx {shortSig(outcome.sig)} · not on devnet</span>
              ) : (
                <a className="strong-link" href={txUrl(outcome.sig)} target="_blank" rel="noreferrer">
                  View on Explorer ↗
                </a>
              )}
            </section>
          )}

          {(stationReport || !["delivered", "scanning"].includes(st.step)) && <ReceivingReport detail={detail} />}
          {(stationReport || detail.proofs.length > 0) && <ProofPanel detail={detail} role={role} />}
          {isBuyer && <StationSimulator orderId={orderId} />}
        </div>

        <div className="col-side">
          <section className="card card-side">
            <div className="row between">
              <span className="eyebrow">Escrow</span>
              <span className={`pill ${onChain ? escTone : "muted"} pill-sm`}>{onChain ? escLabel : "Not funded"}</span>
            </div>
            <div className="escrow-total">
              <span className="escrow-amount">{usd(total)}</span>
              <span className="muted">{onChain ? "CDT funded" : "CDT to fund"}</span>
            </div>
            <div className="bar" aria-hidden="true">
              <div className="bar-rel" style={{ width: pct(st.esc.released) }} />
              <div className="bar-ref" style={{ width: pct(st.esc.refunded) }} />
              <div className="bar-lock" style={{ width: pct(L) }} />
            </div>
            <div className="figs">
              <Fig swatch="rel" label="Released" value={usd(st.esc.released)} />
              <Fig swatch="ref" label="Refunded" value={usd(st.esc.refunded)} />
              <Fig swatch="lock" label="Held for claim" value={usd(L)} />
              <Fig swatch="held" label="In inspection" value={usd(held)} />
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
            <p className="note">History only. No fault assigned.</p>
            <Link to="/history" className="text-link">
              View history →
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

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** The design's illustrated tray, used when there is no real photo (the SIMULATED demo scan). */
function Tray() {
  const bags: [string, string, boolean][] = [
    ["11%", "A · 500g", false],
    ["40%", "A · 500g", false],
    ["69%", "B · 500g", true],
  ];
  return (
    <div className="tray" aria-hidden="true">
      {bags.map(([left, label, odd]) => (
        <div key={left} className={odd ? "tray-bag odd" : "tray-bag"} style={{ left }}>
          <div className="tray-seal" />
          <div className="tray-label">{label}</div>
        </div>
      ))}
    </div>
  );
}

const SCAN_BOXES = [
  { l: "8%", t: "22%", w: "26%", h: "56%", ok: true, tag: "Product A" },
  { l: "37%", t: "20%", w: "26%", h: "58%", ok: true, tag: "Product A" },
  { l: "66%", t: "24%", w: "26%", h: "54%", ok: false, tag: "Not ordered" },
];

/**
 * The SIMULATED demo scan (2.4 s, timed by DemoProvider.scan). No photo is analysed, so the
 * detection boxes carry no confidence figures and the card is labelled SIMULATED.
 */
function ScanningCard({ reference }: { reference: string }) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const t = [700, 1400, 1900].map((ms, i) => window.setTimeout(() => setPhase(i + 1), ms));
    return () => t.forEach(clearTimeout);
  }, []);
  const status = ["Finding bags…", "Reading labels…", "Reading labels…", `Matching to ${reference}…`][phase];
  const steps: [string, number, number][] = [
    ["Find bags", 1, 0],
    ["Read labels", 3, 1],
    [`Match to ${reference}`, 9, 3],
  ];
  return (
    <section className="card card-tight">
      <div className="scan-frame">
        <Tray />
        <div className="scan-fx" aria-hidden="true">
          <div className="scan-wash" />
          <div className="scan-sweep" />
          <div className="scan-corner tl" />
          <div className="scan-corner tr" />
          <div className="scan-corner bl" />
          <div className="scan-corner br" />
          <div className="scan-tag">
            <span className="scan-tag-dot" />
            SCANNING · <span className="sim">SIMULATED</span>
          </div>
          {SCAN_BOXES.map((b, i) =>
            phase > i ? (
              <div key={i} className={b.ok ? "scan-box" : "scan-box odd"} style={{ left: b.l, top: b.t, width: b.w, height: b.h }}>
                <span className="scan-box-label">{b.tag}</span>
              </div>
            ) : null,
          )}
        </div>
      </div>
      <div className="scan-status" aria-live="polite">
        <div className="row between">
          <div className="busy">
            <span className="spinner" aria-hidden="true" /> {status}
          </div>
          <span className="scan-count">{Math.min(phase, 3)} / 3 bags</span>
        </div>
        <div className="scan-prog" aria-hidden="true">
          <div>
            <div />
          </div>
        </div>
        <div className="scan-steps">
          {steps.map(([label, doneAt, startAt]) => {
            const done = phase >= doneAt;
            const active = !done && phase >= startAt;
            return (
              <div key={label} className={done ? "scan-step done" : active ? "scan-step active" : "scan-step"}>
                {done ? (
                  <span className="scan-step-done">✓</span>
                ) : active ? (
                  <span className="spinner spinner-sm" aria-hidden="true" />
                ) : (
                  <span className="scan-step-idle" />
                )}
                <span>{label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ReceivingReport({ detail }: { detail: OrderDetail }) {
  const { latestCapture, latestScan, order } = detail;
  const c = order.comparison;
  const real = !!(latestScan && c);
  const mock = real && latestScan!.analyzedBy === "mock";
  const source = latestCapture ? latestCapture.source[0].toUpperCase() + latestCapture.source.slice(1) : "";
  return (
    <section className="card card-report">
      <div className="row between wrap">
        <h3>Receiving report</h3>
        <span className="row gap-6">
          {!real && <Sim />}
          <span className="pill info pill-sm">{real ? (mock ? "AI · Mock" : "AI · Gemini") : "Demo scan"}</span>
        </span>
      </div>
      <div className="report-photo">
        {latestCapture ? <img src={latestCapture.imageUrl} alt="Delivery capture used for this report" /> : <Tray />}
      </div>
      <p className="caption">
        {latestCapture
          ? `Captured ${hhmm(latestCapture.capturedAt)} · ${source} · scan ${latestScan?.id ?? "—"} · rev ${order.evidenceRevision} · sha256 ${latestCapture.imageSha256.slice(0, 10)}…`
          : "Captured 10:51 · Café Luma · sha256 3f9a1c07e2…"}
      </p>
      <p className="seen">
        <b>Detected</b> ·{" "}
        {real ? latestScan!.observed.map((o) => `${o.count} × ${o.labelText}`).join(", ") || "nothing" : "2 × Product A, 1 × Product B"}
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
              const [text, tone] = VERDICT[l.verdict](l);
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
              ["Product A · 500 g", "3", "3", "2", "Missing 1", "bad"],
              ["Product B · 500 g", "—", "—", "1", "Not ordered", "warn"],
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
        {real ? c!.summary : "Invoice FACTURA-1001 · 3 × 500 g at $10.00"}
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
  if (st.step === "delivered" && !isBuyer && stationSummary) return ["Report ready", `${cpName} hasn't reviewed yet`, stationSummary];
  if (st.step === "delivered" && !isBuyer) return ["Awaiting buyer", `${cpName} hasn't inspected yet`, "Accepted items pay out immediately."];
  if (st.step === "scanning" && !isBuyer) return ["Receiving", `${cpName} is scanning…`, "You'll see the same report."];
  if (st.step === "report" && !isBuyer)
    return [
      "Report ready",
      `${cpName} is reviewing`,
      `${stationSummary ?? "1 × Product A missing, 1 × Product B not ordered."} Refunds need your signature.`,
    ];
  if (st.step === "offer" && st.offer?.by === role && offerLabel)
    return ["Offer sent · Expires in 24h", `Awaiting ${cpName}`, "No funds move if it expires."];
  if (st.step === "physical" && st.pending && st.pending.who !== role) return [`Both signed · ${st.pending.label}`, st.pending.wait, st.pending.text];
  return null;
}
