import { useEffect } from "react";
import { Link } from "react-router-dom";
import type { EscrowRecord, LineVerdict, OrderDetail } from "@cleardock/shared";
import { money } from "../api";
import { short } from "../format";
import {
  AI_SOURCE,
  ESCROW_STATUS,
  PARTY,
  linesStale,
  reviewedClaim,
  claimedOf,
  fundRequest,
  historyFor,
  orderStatus,
  scanned,
  shortSig,
  totalOf,
  txUrl,
  usd,
  type DemoState,
  type EscrowEvent,
  type Tone,
} from "./demo";
import { useDemo } from "./DemoProvider";
import { ProofPanel } from "../proof/ProofPanel";
import { StationSimulator } from "./StationSimulator";
import { AgreementPanel } from "../agreement/AgreementPanel";
import { useAgreement } from "../agreement/useAgreement";
import { KIND_LABEL, currentOffer } from "../agreement/model";
import { withSavedClaim } from "../agreement/claim";
import { liveAgreementApi } from "../agreement/client";

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
  // The shared agreement (server state, the same on every device) exists once there is a verified escrow:
  // the claim is saved to it before the on-chain claim, and settlement offers live in it.
  const agreement = useAgreement(orderId, !!onChain, onChain);
  const hasClaim = (!!onChain && onChain.claimedMinor > 0) || !!agreement.state?.claim;
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
  const held = onChain ? total - st.esc.released - st.esc.refunded - L : 0;
  const [stLabel, stTone] = orderStatus(st);
  const [escLabel, escTone] = ESCROW_STATUS[st.esc.status];
  const agreed = agreement.state ? currentOffer(agreement.state) : null;
  const claimed = claimedOf(st.lines);
  const settled = st.step === "settled";
  const pct = (v: number) => `${total ? (v / total) * 100 : 0}%`;
  const items = itemsLine(detail);
  const cpLine = isBuyer
    ? `${detail.supplier.name} · verified wallet ${short(detail.supplier.walletAddress)} · ${items}`
    : `${PARTY.buyer.name} (synthetic) · buyer wallet ${onChain ? short(onChain.buyer) : PARTY.buyer.wallet} · ${items}`;
  const wait = onChain
    ? waitCard(st, role, cp.name, stationReport ? detail.order.comparison!.summary : null)
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
          label: agreed?.status === "accepted" ? KIND_LABEL[agreed.kind] : onChain.claimedMinor ? "Settlement" : undefined,
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
                onClick={() =>
                  sign(
                    orderId,
                    withSavedClaim(reviewedClaim(st, detail, total), {
                      session: agreement,
                      api: liveAgreementApi,
                      detail,
                      lines: st.lines,
                      from: st.linesFrom,
                    }),
                    detail,
                  )
                }
              >
                {claimed ? `Sign: release ${usd(total - claimed)}, claim ${usd(claimed)}` : `Sign: accept all · release ${usd(total)}`}
              </button>
            </section>
          )}

          {hasClaim && <AgreementPanel detail={detail} session={agreement} lines={st.lines} linesFrom={st.linesFrom} />}

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
          {isBuyer && <StationSimulator orderId={orderId} />}
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
          {real && latestScan!.analyzedBy === "cache" && <span className="sim">CACHED RESULT</span>}
          {latestCapture?.fixture && <span className="sim">SAMPLE PHOTO · SIMULATED</span>}
          <span className="pill info pill-sm">
            {source} · AI suggestion{real && latestScan!.analyzedBy !== "mock" ? ` · ${AI_SOURCE[latestScan!.analyzedBy]}` : ""}
          </span>
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
          ? latestScan!.observed.map((o) => `${o.count} × ${o.labelText}`).join(", ") || "no packages read"
          : "2 × PRODUCT A · 500 g, 1 × PRODUCT B · 500 g"}
      </p>
      {real && !latestScan!.observed.length && (
        <p className="warn-text">The station read no packages. This isn't a successful scan: check the tray and scan again.</p>
      )}
      {real &&
        latestScan!.unreadable.map((u, i) => (
          <p key={i} className="warn-text">
            ? Unreadable: {u}
          </p>
        ))}
      {latestCapture?.sensors.map((w, i) => (
        <p key={i} className="caption-plain">
          Weight {w.grams} g{w.simulated ? " · SIMULATED" : ""} · recorded, not used in the comparison
        </p>
      ))}
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

function waitCard(st: DemoState, role: "buyer" | "supplier", cpName: string, stationSummary?: string | null): [string, string, string] | null {
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
  return null;
}
