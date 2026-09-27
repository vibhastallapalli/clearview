import { useEffect, useState, type ReactNode } from "react";
import type { EscrowRecord, OrderDetail } from "@cleardock/shared";
import { api, money } from "../api";
import { short } from "../format";
import { useDemo } from "../escrow/DemoProvider";
import { PARTY, shortSig, txUrl, type Evidence, type Line } from "../escrow/demo";
import * as phantom from "../wallet/phantom";
import { claimWrite } from "./claim";
import { liveAgreementApi } from "./client";
import type { AgreementOffer, AgreementOfferKind, AgreementState, Party, SettlementAttempt, SettlementStatus } from "./contract";
import { KIND_LABEL, OTHER, heldMinor, offerError, parseAmountToMinor, reviewedFrom, settlePlan, splitFor, viewFor } from "./model";
import type { AgreementSession } from "./session";
import { partyOf, walletFor } from "./signer";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const who = (p: Party) => `${PARTY[p].name} (${p})`;

/**
 * Steps 3–5: the claim, the settlement offers and the settlement transaction, all from Account 1's
 * agreement API (CONTRACTS.md "Agreement"). Offers and answers are signed by the party's Phantom wallet;
 * money moves only when the settle transaction is confirmed on devnet with the accepted split.
 */
export function AgreementPanel({
  detail,
  session,
  lines,
  linesFrom,
}: {
  detail: OrderDetail;
  session: AgreementSession;
  /** The lines as reviewed in this browser (only used when the buyer re-saves a claim). */
  lines: Line[];
  linesFrom: Evidence | null | undefined;
}) {
  const { role } = useDemo();
  const escrow = detail.order.escrow;
  const held = heldMinor(escrow);

  if (session.status === "loading" && !session.state)
    return (
      <section className="card">
        <span className="eyebrow">Step 3 · Settle the claim</span>
        <div className="busy">
          <span className="spinner" aria-hidden="true" /> Loading the shared agreement…
        </div>
      </section>
    );

  if (session.status === "unavailable")
    return (
      <section className="card">
        <span className="eyebrow">Step 3 · Settle the claim</span>
        <h2 className="h2-sm">{held !== null ? `${money(held)} is held on devnet for the claim.` : "Settlement"}</h2>
        <p className="notice warn">
          This server doesn't serve the shared agreement, so offers can't be made, answered or signed here. Nothing is simulated in their
          place, and the held amount stays locked.
        </p>
      </section>
    );

  if (session.status === "error" && !session.state)
    return (
      <section className="card">
        <span className="eyebrow">Step 3 · Settle the claim</span>
        <p className="error">Couldn't load the shared agreement: {session.loadError}</p>
        <button className="secondary sm" onClick={() => session.refresh()}>
          Try again
        </button>
      </section>
    );

  const st = session.state!;
  const v = viewFor(st, role, escrow);

  return (
    <>
      <ClaimCard detail={detail} session={session} st={st} lines={lines} linesFrom={linesFrom} />
      {st.claim?.status === "filed" && v.phase !== "settled" && <Negotiation detail={detail} session={session} st={st} held={held} />}
      {st.settlement && st.settlement.attempts.length > 0 && <SettlementCard detail={detail} session={session} st={st} />}
      {v.phase === "settled" && v.current && (
        <p className="note">
          Settled on devnet as agreed in offer v{v.current.version} ({KIND_LABEL[v.current.kind].toLowerCase()}).
        </p>
      )}
    </>
  );
}

// ---------- wallet ----------

/** The connected Phantom account, kept current. */
function usePhantomKey(): string | null {
  const [key, setKey] = useState<string | null>(() => phantom.currentPublicKey());
  useEffect(() => phantom.onAccountChange(setKey), []);
  return key;
}

/** Which wallet will sign for this viewer, and whether Phantom is on it. */
function WalletLine({ escrow, role }: { escrow: EscrowRecord | null | undefined; role: Party }) {
  const key = usePhantomKey();
  const expected = walletFor(escrow, role);
  const on = partyOf(escrow, key);
  if (!expected) return null;
  const installed = !!phantom.getPhantom();
  return (
    <p className={key === expected ? "caption-plain" : "notice warn"}>
      {!installed
        ? `Phantom isn't installed in this browser, so the ${role} wallet ${short(expected)} can't sign here.`
        : !key
          ? `Your offers and answers are signed with the ${role} wallet ${short(expected)} in Phantom. `
          : key === expected
            ? `Signing as the ${role} wallet ${short(expected)} (Phantom). Signing an offer or answer moves no funds.`
            : `Phantom is on ${short(key)}${on ? ` (the ${on} wallet)` : ""}. Switch it to the ${role} wallet ${short(expected)} to act as the ${role}.`}
      {installed && !key && (
        <button className="secondary sm" onClick={() => phantom.connect().catch(() => {})}>
          Connect Phantom
        </button>
      )}
    </p>
  );
}

// ---------- claim ----------

function ClaimCard({
  detail,
  session,
  st,
  lines,
  linesFrom,
}: {
  detail: OrderDetail;
  session: AgreementSession;
  st: AgreementState;
  lines: Line[];
  linesFrom: Evidence | null | undefined;
}) {
  const { role } = useDemo();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const escrow = detail.order.escrow;
  const claimTx = escrow?.events.find((e) => e.action === "claim")?.signature ?? null;
  const c = st.claim;

  const confirm = async () => {
    if (!claimTx) return;
    setBusy(true);
    setError(null);
    try {
      session.accept(await liveAgreementApi.confirmClaim(detail.order.id, claimTx));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!c) {
    if (!escrow || !claimTx) return null;
    if (role !== "buyer")
      return (
        <section className="card">
          <span className="eyebrow">Step 3 · Claim</span>
          <h2 className="h2-sm">
            {PARTY.buyer.name} locked {money(escrow.claimedMinor)} with a claim on devnet.
          </h2>
          <p className="body">Waiting for them to save which lines they claimed, and their photo proof, with ClearDock.</p>
        </section>
      );
    // The claim is on devnet but its lines were never saved (e.g. a claim from an older build). Save them now.
    const claimed = lines.filter((l) => l.claim);
    const canSave = !!linesFrom && claimed.reduce((s, l) => s + l.priceMinor, 0) === escrow.claimedMinor;
    const save = async () => {
      setError(null);
      const saved = await session.write(claimWrite(st, detail, lines, linesFrom!));
      if (saved) await confirm();
    };
    return (
      <section className="card">
        <span className="eyebrow">Step 3 · Claim</span>
        <h2 className="h2-sm">Your claim locked {money(escrow.claimedMinor)} on devnet. Save its lines so the supplier can see them.</h2>
        {canSave ? (
          <>
            <ul className="small">
              {claimed.map((l) => (
                <li key={l.id}>
                  {l.label} · {l.sub} · {money(l.priceMinor)}
                </li>
              ))}
            </ul>
            <WalletLine escrow={escrow} role="buyer" />
            <button className="primary" onClick={save} disabled={busy || session.busy}>
              {session.busy ? "Waiting for Phantom…" : "Sign and save the claim"}
            </button>
          </>
        ) : (
          <p className="notice warn">
            This browser doesn't have the station review the claim was made from, so it can't list the claimed lines. Open the order on the
            device that filed the claim.
          </p>
        )}
        {(error || session.notice) && <p className="error">{error ?? session.notice!.text}</p>}
      </section>
    );
  }

  const proofs = detail.proofs.filter((p) => c.proofIds.includes(p.id));
  const filed = c.status === "filed";
  return (
    <section className="card">
      <div className="row between wrap">
        <span className="eyebrow">Step 3 · Claim · {filed ? `filed ${time(c.filedAt!)}` : `saved ${time(c.preparedAt)}`}</span>
        <span className={`pill ${filed ? "ok" : "warn"} pill-xs`}>{filed ? "Verified on devnet" : "Saved · not confirmed on devnet"}</span>
      </div>
      <h2 className="h2-sm">
        {PARTY.buyer.name} claimed {money(c.claimedMinor)}.
      </h2>
      <div className="kv">
        {c.lines.map((l, i) => (
          <div key={i} className="kv-row">
            <span>
              {l.description} · {l.reason.replace("_", " ")}
            </span>
            <span className="kv-value">{money(l.claimedMinor)}</span>
          </div>
        ))}
      </div>
      <p className="caption">
        From station scan {c.scanId} · revision {c.evidenceRevision}
        {c.scanId !== detail.order.latestScanId && " · the station has scanned again since; the claim keeps its original scan"}
        {c.claimSignature && (
          <>
            {" · "}
            <a href={txUrl(c.claimSignature)} target="_blank" rel="noreferrer">
              claim tx {shortSig(c.claimSignature)} ↗
            </a>
          </>
        )}
        {c.chain && ` · ${money(c.chain.heldMinor)} held after the claim`}
      </p>
      <p className="note">
        {proofs.length
          ? `${proofs.length} photo${proofs.length === 1 ? "" : "s"} attached as proof (raw photos, shown below; not checked by AI).`
          : "No photo proof attached to the claim."}
      </p>
      {!filed && (
        <>
          <p className="notice warn">
            {claimTx
              ? "The claim transaction is on devnet but isn't linked yet. Confirming checks it on devnet; no wallet signature is needed."
              : "Saved before the on-chain claim. Waiting for the buyer's claim transaction on devnet."}
          </p>
          {claimTx && (
            <button className="secondary sm" onClick={confirm} disabled={busy}>
              {busy ? "Checking devnet…" : "Confirm the on-chain claim"}
            </button>
          )}
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

// ---------- offers ----------

function Negotiation({ detail, session, st, held }: { detail: OrderDetail; session: AgreementSession; st: AgreementState; held: number | null }) {
  const { role, sign } = useDemo();
  const [countering, setCountering] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);
  const escrow = detail.order.escrow;
  const v = viewFor(st, role, escrow);
  const cur = v.current;
  const other = OTHER[role];
  // What this render shows is what the user reviews; answers carry it and are refused if it changed.
  const reviewed = cur ? reviewedFrom(st, cur) : null;
  const claimHeld = st.claim?.chain?.heldMinor ?? null;
  const heldMismatch = held !== null && claimHeld !== null && held !== claimHeld;

  useEffect(() => {
    if (!v.canRespond) setCountering(false);
  }, [v.canRespond]);

  const startSettle = () => {
    if (!cur || !reviewed) return;
    setSettleError(null);
    const orderId = detail.order.id;
    const plan = settlePlan(st, escrow, reviewed);
    if (!plan.ok) {
      setSettleError(plan.reason);
      session.refresh();
      return;
    }
    sign(
      orderId,
      {
        title: "Sign the agreed settlement",
        rows: [
          ["Agreed offer", `v${cur.version} · ${KIND_LABEL[cur.kind]} · proposed by ${PARTY[cur.proposedBy].name}`],
          ["To supplier", money(plan.toSupplier)],
          ["Back to buyer", money(plan.toBuyer)],
          ["Held on devnet", money(held)],
          ["Before sending", "The signature is recorded with ClearDock first (one more Phantom message, moves nothing)"],
        ],
        chain: { action: "settle", toSupplier: plan.toSupplier, toBuyer: plan.toBuyer },
        // Re-read the agreement and the chain right before signing: never sign a split that changed.
        precheck: async () => {
          if (!(await session.refresh())) throw new Error("Couldn't re-read the agreement from ClearDock, so nothing was signed. Try again.");
          const { order } = await api.order(orderId);
          const again = settlePlan(session.state!, order.escrow, reviewed);
          if (!again.ok) throw new Error(again.reason);
        },
        // Both signatures are on the transaction. Record it with the server before it can reach devnet, so a
        // lost page can never lead to a second, unrecorded settle transaction.
        beforeSend: async (signature, lastValidBlockHeight) => {
          const as = partyOf(escrow, phantom.currentPublicKey());
          if (!as) throw new Error("Phantom isn't on the buyer or supplier wallet, so the settlement can't be recorded.");
          const saved = await session.write({ action: "record_settlement", as, offerId: cur.id, signature, lastValidBlockHeight });
          if (!saved) throw new Error(session.notice?.text ?? "ClearDock didn't record the settlement.");
        },
        confirmed: async (tx) => {
          session.accept(await liveAgreementApi.recheckSettlement(orderId, tx.sig));
        },
        sendFailed: () => {
          session.refresh();
        },
        // The outcome is read from the server's verified settlement and escrow, not from this reply.
        apply: () => ({}),
      },
      detail,
    );
  };

  const settling = !!st.settlement && ["submitted", "unknown"].includes(st.settlement.status);

  return (
    <section className="card">
      <div className="row between wrap">
        <span className="eyebrow">Step 4 · Settlement offer</span>
        {held !== null && <span className="pill-plain pill-sm">Held on devnet · {money(held)}</span>}
      </div>

      {heldMismatch && (
        <p className="notice warn">
          The claim locked {money(claimHeld)} but devnet now holds {money(held)}. Offers can't be made until that is explained.
        </p>
      )}

      {v.phase === "no_offer" && (
        <p className="body">
          {st.offers.some((o) => o.status === "rejected")
            ? "The last offer was rejected. The held amount stays locked until you both agree on a split."
            : "No offer yet. Either side can propose how to split the held amount."}
        </p>
      )}

      {cur && v.phase === "open" && (
        <OfferView offer={cur} label="Current offer">
          <p className={v.youAct ? "notice warn" : "note"}>
            {v.youAct ? `Your turn: accept, counter or reject ${PARTY[cur.proposedBy].name}'s offer.` : `Waiting on ${who(v.waitingOn ?? other)} to answer.`}
          </p>
          {v.canRespond && !countering && (
            <>
              <div className="row wrap">
                <button className="primary" disabled={session.busy} onClick={() => session.respond(role, reviewed!, true)}>
                  {session.busy ? "Waiting for Phantom…" : `Accept offer v${cur.version}`}
                </button>
                <button className="secondary" disabled={session.busy} onClick={() => setCountering(true)}>
                  Counter
                </button>
                <button className="danger-link" disabled={session.busy} onClick={() => session.respond(role, reviewed!, false)}>
                  Reject
                </button>
              </div>
              <p className="note">
                Accepting agrees the split. No money moves until both of you sign the settlement transaction and devnet confirms it.
              </p>
            </>
          )}
        </OfferView>
      )}

      {cur && cur.status === "accepted" && (
        <OfferView offer={cur} label="Agreement reached">
          <p className="notice warn">
            {settling
              ? "Agreed and sent for settlement. Nothing is paid or refunded until devnet confirms it (see below)."
              : `Agreed, not paid: no funds have moved. The escrow still holds ${money(held)} until the settlement transaction is signed by both parties and confirmed on devnet.`}
          </p>
          {v.phase === "agreed" && (
            <>
              {st.settlement?.status === "failed" && (
                <p className="warn-text">The last settle transaction provably moved nothing. A fresh one needs both signatures again.</p>
              )}
              <p className="note">
                Both signatures go on one transaction. In this build they are collected on one computer: the buyer signs in Phantom, then
                Phantom is switched to the supplier account to sign the same transaction. Signing from two separate devices isn't supported.
              </p>
              <button className="primary" disabled={session.busy || held === null} onClick={startSettle}>
                Sign settlement: {money(cur.toSupplierMinor)} to supplier · {money(cur.toBuyerMinor)} to buyer
              </button>
              {settleError && <p className="error">{settleError}</p>}
            </>
          )}
        </OfferView>
      )}

      {held !== null && !heldMismatch && (v.phase === "no_offer" ? v.canPropose : countering) && (
        <OfferForm
          held={held}
          counterOf={countering ? cur : null}
          busy={session.busy}
          onCancel={countering ? () => setCountering(false) : undefined}
          onSend={(kind, sup, buy) => session.propose(role, kind, sup, buy)}
        />
      )}

      {(v.canPropose || v.canRespond) && <WalletLine escrow={escrow} role={role} />}

      {session.notice && (
        <div className="row wrap gap-6">
          <p className={session.notice.tone === "bad" ? "error" : session.notice.tone === "ok" ? "ok-text" : "notice warn"}>{session.notice.text}</p>
          {session.notice.retry && (
            <button className="secondary sm" disabled={session.busy} onClick={() => session.retry()}>
              Retry
            </button>
          )}
        </div>
      )}

      {v.past.length > 0 && (
        <div className="stack-8">
          <span className="eyebrow">Earlier offers</span>
          {v.past.map((o) => (
            <OfferView key={o.id} offer={o} past />
          ))}
        </div>
      )}

      <p className="caption-plain">
        "Viewing as" only picks which screens you see. The server checks each offer and answer against the buyer or supplier wallet on the
        escrow: it proves which wallet acted, not which person or device.
      </p>
    </section>
  );
}

const STATUS_PILL: Record<AgreementOffer["status"], [string, string]> = {
  open: ["Open", "info"],
  accepted: ["Accepted", "ok"],
  rejected: ["Rejected", "bad"],
  superseded: ["Superseded by a counter-offer", "muted"],
};

function OfferView({ offer, label, past, children }: { offer: AgreementOffer; label?: string; past?: boolean; children?: ReactNode }) {
  const [text, tone] = STATUS_PILL[offer.status];
  return (
    <div className={past ? "offer past" : "offer"}>
      <div className="row between wrap">
        <span className="offer-title">
          {label ? `${label} · ` : ""}v{offer.version} · {KIND_LABEL[offer.kind]}
        </span>
        <span className={`pill ${tone} pill-xs`}>{text}</span>
      </div>
      <span className="caption">
        Proposed by {who(offer.proposedBy)} · {time(offer.createdAt)}
        {offer.respondedBy && offer.respondedAt && ` · ${offer.status} by ${offer.respondedBy} ${time(offer.respondedAt)}`}
      </span>
      <div className="totals">
        <div className={past ? "tint plain" : "tint ok"}>
          <span className={past ? "tint-label muted" : "tint-label"}>To supplier</span>
          <span className="tint-value">{money(offer.toSupplierMinor)}</span>
        </div>
        <div className={past ? "tint plain" : "tint info"}>
          <span className={past ? "tint-label muted" : "tint-label"}>Back to buyer</span>
          <span className="tint-value">{money(offer.toBuyerMinor)}</span>
        </div>
      </div>
      {children}
    </div>
  );
}

const KINDS: { id: AgreementOfferKind; desc: string }[] = [
  { id: "full_refund", desc: "All held money goes back to the buyer." },
  { id: "full_release", desc: "All held money goes to the supplier." },
  { id: "split", desc: "Choose how much the supplier gets; the rest goes back to the buyer. Both must get something." },
];

function OfferForm({
  held,
  counterOf,
  busy,
  onSend,
  onCancel,
}: {
  held: number;
  counterOf: AgreementOffer | null;
  busy: boolean;
  onSend: (kind: AgreementOfferKind, toSupplierMinor: number, toBuyerMinor: number) => void;
  onCancel?: () => void;
}) {
  const [kind, setKind] = useState<AgreementOfferKind>("full_refund");
  const [supText, setSupText] = useState(() => (Math.floor(held / 2) / 100).toFixed(2));
  const supMinor = kind === "split" ? parseAmountToMinor(supText) : 0;
  const split = supMinor === null ? null : splitFor(kind, held, supMinor);
  const err = supMinor === null ? "Enter an amount like 5.00." : split ? offerError(kind, held, split.toSupplierMinor, split.toBuyerMinor) : null;

  return (
    <div className="stack-8">
      <span className="eyebrow">{counterOf ? `Counter-offer to v${counterOf.version}` : "Propose a split"}</span>
      <div className="stack-8" role="radiogroup" aria-label="Settlement offer">
        {KINDS.map((k) => {
          const on = kind === k.id;
          const s = splitFor(k.id, held, k.id === "split" ? supMinor ?? 0 : 0);
          return (
            <div
              key={k.id}
              className={on ? "radio-card on" : "radio-card"}
              role="radio"
              aria-checked={on}
              tabIndex={0}
              onClick={() => setKind(k.id)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setKind(k.id))}
            >
              <span className="radio-dot" aria-hidden="true">
                <span />
              </span>
              <div className="radio-text">
                <span className="radio-label">{KIND_LABEL[k.id]}</span>
                <span className="radio-desc">{k.desc}</span>
                {k.id === "split" && on ? (
                  <label className="amount-field" onClick={(e) => e.stopPropagation()}>
                    To supplier $
                    <input inputMode="decimal" value={supText} onChange={(e) => setSupText(e.target.value)} aria-label="Amount to supplier in dollars" />
                  </label>
                ) : null}
                <span className="radio-split">
                  {k.id === "split" && supMinor === null ? "—" : `${money(s.toSupplierMinor)} to supplier · ${money(s.toBuyerMinor)} to buyer`}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {err && <p className="warn-text">{err}</p>}
      <div className="row wrap">
        <button className="primary" disabled={busy || !!err || !split} onClick={() => split && onSend(kind, split.toSupplierMinor, split.toBuyerMinor)}>
          {busy ? "Waiting for Phantom…" : counterOf ? `Sign and send counter-offer (replaces v${counterOf.version})` : "Sign and send offer"}
        </button>
        {onCancel && (
          <button className="secondary" onClick={onCancel} disabled={busy}>
            Back
          </button>
        )}
      </div>
      <p className="note">Your wallet signs the offer so the other side knows it came from you. It moves no money.</p>
    </div>
  );
}

// ---------- settlement transaction ----------

const SETTLE_STATUS: Record<Exclude<SettlementStatus, "awaiting_signatures">, [string, string]> = {
  submitted: ["Sent · waiting for devnet", "info"],
  unknown: ["Outcome unknown", "warn"],
  failed: ["Moved nothing", "bad"],
  confirmed: ["Confirmed on devnet", "ok"],
};

function SettlementCard({ detail, session, st }: { detail: OrderDetail; session: AgreementSession; st: AgreementState }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = st.settlement!;
  const attempts = [...s.attempts].reverse();
  const inFlight = s.status === "submitted" || s.status === "unknown";

  const recheck = async (signature: string) => {
    setBusy(true);
    setError(null);
    try {
      session.accept(await liveAgreementApi.recheckSettlement(detail.order.id, signature));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <div className="row between wrap">
        <span className="eyebrow">Step 5 · Settlement transaction</span>
        {s.status !== "awaiting_signatures" && <span className={`pill ${SETTLE_STATUS[s.status][1]} pill-xs`}>{SETTLE_STATUS[s.status][0]}</span>}
      </div>
      <h2 className="h2-sm">
        {s.status === "confirmed"
          ? "Settled on devnet with the agreed split."
          : s.status === "failed"
            ? "The last settle transaction moved nothing."
            : s.status === "unknown"
              ? "Sent · outcome unknown"
              : "Sent · waiting for devnet confirmation"}
      </h2>
      {s.error && <p className={s.status === "failed" ? "warn-text" : "notice warn"}>{s.error}</p>}
      {inFlight && (
        <p className="body">
          Nothing is shown as paid or refunded until ClearDock verifies the transaction on devnet with the agreed amounts. Don't sign another
          settlement while this one could still move funds.
        </p>
      )}
      <div className="kv">
        {attempts.map((a: SettlementAttempt, i) => (
          <div key={a.signature} className="kv-row">
            <span>
              <a className="mono" href={txUrl(a.signature)} target="_blank" rel="noreferrer">
                tx {shortSig(a.signature)} ↗
              </a>{" "}
              · reported by {a.reportedBy} {time(a.at)} · valid until block {a.lastValidBlockHeight}
              {a.error && i > 0 && ` · ${a.error}`}
            </span>
            <span className="kv-value">{SETTLE_STATUS[a.status][0]}</span>
          </div>
        ))}
      </div>
      {inFlight && s.signature && (
        <button className="secondary sm" onClick={() => recheck(s.signature!)} disabled={busy}>
          {busy ? "Checking devnet…" : "Re-check on devnet"}
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
