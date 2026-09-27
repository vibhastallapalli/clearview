import { useEffect, useState, type ReactNode } from "react";
import type { ClaimLine, OrderDetail } from "@cleardock/shared";
import { api, money } from "../api";
import { useDemo } from "../escrow/DemoProvider";
import { PARTY, shortSig, txUrl, type Evidence, type Line } from "../escrow/demo";
import { recheckEvent } from "../escrow/sign";
import { liveAgreementApi } from "./client";
import type { AgreementOffer, AgreementOfferKind, AgreementState, Party } from "./contract";
import {
  KIND_LABEL,
  OTHER,
  heldMinor,
  loadPending,
  parseAmountToMinor,
  reviewedFrom,
  savePending,
  settlePlan,
  splitError,
  splitFor,
  viewFor,
  type PendingSettle,
} from "./model";
import type { AgreementSession } from "./session";
import { checkPendingSettle } from "./settleCheck";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const who = (p: Party) => `${PARTY[p].name} (${p})`;

/**
 * Step 3: the claim, the settlement offers and the settlement transaction, all from the server's shared
 * agreement (web/src/agreement/contract.ts). Nothing here is decided in the browser: offers, answers and
 * "who acts next" come back from the server, and money moves only when the settle transaction is confirmed.
 */
export function AgreementPanel({
  detail,
  session,
  lines,
  linesFrom,
}: {
  detail: OrderDetail;
  session: AgreementSession;
  /** The lines the buyer claimed on devnet, as reviewed in this browser (only used to share the claim). */
  lines: Line[];
  linesFrom: Evidence | null | undefined;
}) {
  const { role } = useDemo();
  const orderId = detail.order.id;
  const escrow = detail.order.escrow;
  const held = heldMinor(escrow);
  const [pending, setPending] = useState<PendingSettle | null>(() => loadPending(orderId));

  // The chain is the truth: once the escrow reads settled, the local "sent" hint is done.
  useEffect(() => {
    if (escrow?.status === "settled" && pending) {
      savePending(null, orderId);
      setPending(null);
    }
  }, [escrow?.status, pending, orderId]);

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
          Shared settlement offers aren't available on this server yet, so offers can't be made, answered or signed here.
          Nothing is simulated in their place, and the held amount stays locked.
        </p>
        {pending && <SettlementSent orderId={orderId} pending={pending} setPending={setPending} escrowAddress={escrow?.escrowAddress} />}
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
      {st.claim && v.phase !== "settled" && (
        <Negotiation detail={detail} session={session} st={st} held={held} pending={pending} setPending={setPending} />
      )}
      {(v.phase === "settling" || (pending && v.phase !== "settled")) && (
        <section className="card">
          <SettlementSent
            orderId={orderId}
            pending={pending}
            setPending={setPending}
            escrowAddress={escrow?.escrowAddress}
            serverStatus={st.settlement?.status}
            serverSignature={st.settlement?.signature ?? null}
          />
        </section>
      )}
      {v.phase === "settled" && v.current && (
        <p className="note">
          Settled on devnet as agreed in offer v{v.current.version} ({KIND_LABEL[v.current.kind].toLowerCase()}).
        </p>
      )}
    </>
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
  const claimed = lines.filter((l) => l.claim);
  const claimedMinor = escrow?.claimedMinor ?? 0;

  if (!st.claim) {
    if (!escrow || !claimTx) return null;
    if (role !== "buyer")
      return (
        <section className="card">
          <span className="eyebrow">Step 3 · Claim</span>
          <h2 className="h2-sm">{PARTY.buyer.name} locked {money(claimedMinor)} with a claim on devnet.</h2>
          <p className="body">Waiting for them to share which lines they claimed and their photo proof.</p>
        </section>
      );
    // The claimed lines are this browser's review of the station report; the server checks them against the chain.
    const canShare = !!linesFrom && claimed.length > 0 && claimed.reduce((s, l) => s + l.priceMinor, 0) === claimedMinor;
    const share = async () => {
      setBusy(true);
      setError(null);
      try {
        const claimLines: ClaimLine[] = claimed.map((l) => ({ sku: null, description: l.label, claimedMinor: l.priceMinor, reason: "missing" }));
        await liveAgreementApi.fileClaim(detail.order.id, {
          as: "buyer",
          scanId: linesFrom!.scanId,
          evidenceRevision: linesFrom!.revision,
          lines: claimLines,
          claimedMinor,
          proofIds: detail.proofs.filter((p) => p.stationScanId === linesFrom!.scanId).map((p) => p.id),
          claimSignature: claimTx,
        });
        await session.refresh();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    };
    return (
      <section className="card">
        <span className="eyebrow">Step 3 · Claim</span>
        <h2 className="h2-sm">Your claim locked {money(claimedMinor)} on devnet. Share it with the supplier.</h2>
        {canShare ? (
          <>
            <ul className="small">
              {claimed.map((l) => (
                <li key={l.id}>
                  {l.label} · {l.sub} · {money(l.priceMinor)}
                </li>
              ))}
            </ul>
            <button className="primary" onClick={share} disabled={busy}>
              {busy ? "Sharing…" : "Share claim with supplier"}
            </button>
          </>
        ) : (
          <p className="notice warn">
            This browser doesn't have the station review the claim was made from, so it can't list the claimed lines. Open the
            order on the device that filed the claim.
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </section>
    );
  }

  const c = st.claim;
  const proofs = detail.proofs.filter((p) => c.proofIds.includes(p.id));
  return (
    <section className="card">
      <span className="eyebrow">Step 3 · Claim · filed {time(c.filedAt)}</span>
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
        {c.scanId !== detail.order.latestScanId && " · the station has scanned again since"} ·{" "}
        <a href={txUrl(c.claimSignature)} target="_blank" rel="noreferrer">
          claim tx {shortSig(c.claimSignature)} ↗
        </a>
      </p>
      <p className="note">
        {proofs.length
          ? `${proofs.length} photo${proofs.length === 1 ? "" : "s"} attached as proof (raw photos, shown below; not checked by AI).`
          : "No photo proof attached to the claim."}
      </p>
    </section>
  );
}

// ---------- offers ----------

function Negotiation({
  detail,
  session,
  st,
  held,
  pending,
  setPending,
}: {
  detail: OrderDetail;
  session: AgreementSession;
  st: AgreementState;
  held: number | null;
  pending: PendingSettle | null;
  setPending: (p: PendingSettle | null) => void;
}) {
  const { role, sign } = useDemo();
  const [countering, setCountering] = useState(false);
  const v = viewFor(st, role, detail.order.escrow);
  const cur = v.current;
  const other = OTHER[role];
  // What this render shows is what the user reviews; answers carry it, and are refused if it changed.
  const reviewed = cur ? reviewedFrom(st, cur) : null;
  const heldMismatch = held !== null && held !== st.claim!.claimedMinor;

  useEffect(() => {
    if (!v.canRespond) setCountering(false);
  }, [v.canRespond]);

  const startSettle = () => {
    if (!cur || !reviewed) return;
    const orderId = detail.order.id;
    const plan = settlePlan(st, detail.order.escrow, reviewed);
    if (!plan.ok) {
      session.notice = { tone: "warn", text: plan.reason };
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
        ],
        chain: { action: "settle", toSupplier: plan.toSupplier, toBuyer: plan.toBuyer },
        // Re-read the agreement and the chain right before signing: never sign a split that changed.
        precheck: async () => {
          if (loadPending(orderId))
            throw new Error("A settlement transaction was already sent from this browser. Re-check it before signing again.");
          await session.refresh();
          const { order } = await api.order(orderId);
          const again = settlePlan(session.state!, order.escrow, reviewed);
          if (!again.ok) throw new Error(again.reason);
        },
        sent: async (signature, lastValidBlockHeight) => {
          const p: PendingSettle = { orderId, offerId: cur.id, signature, lastValidBlockHeight, sentAt: new Date().toISOString() };
          savePending(p, orderId);
          setPending(p);
          await liveAgreementApi.recordSettlement(orderId, { offerId: cur.id, signature });
        },
        sendFailed: (_sig, outcome) => {
          if (outcome === "failed") {
            savePending(null, orderId);
            setPending(null);
          }
        },
        // The outcome is read from the server's verified escrow record, not from this reply.
        apply: () => ({}),
      },
      detail,
    );
  };

  return (
    <section className="card">
      <div className="row between wrap">
        <span className="eyebrow">Step 4 · Settlement offer</span>
        {held !== null && <span className="pill-plain pill-sm">Held on devnet · {money(held)}</span>}
      </div>

      {heldMismatch && (
        <p className="notice warn">
          The claim says {money(st.claim!.claimedMinor)} but devnet holds {money(held)}. Offers must split what devnet holds.
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
            <div className="row wrap">
              <button className="primary" disabled={session.busy} onClick={() => session.respond(role, reviewed!, true)}>
                Accept offer v{cur.version}
              </button>
              <button className="secondary" disabled={session.busy} onClick={() => setCountering(true)}>
                Counter
              </button>
              <button className="danger-link" disabled={session.busy} onClick={() => session.respond(role, reviewed!, false)}>
                Reject
              </button>
            </div>
          )}
          {v.canRespond && !countering && (
            <p className="note">Accepting agrees the split. No money moves until both of you sign the settlement transaction and devnet confirms it.</p>
          )}
        </OfferView>
      )}

      {cur && cur.status === "accepted" && (v.phase === "agreed" || v.phase === "settling") && (
        <OfferView offer={cur} label="Agreement reached">
          <p className="notice warn">
            {v.phase === "agreed"
              ? `Agreed, not paid: no funds have moved. The escrow still holds ${money(held)} until the settlement transaction is signed by both parties and confirmed on devnet.`
              : "Agreed and sent for settlement. It is not paid or refunded until devnet confirms it (see below)."}
          </p>
          {v.phase === "agreed" && !pending && (
            <>
              <p className="note">
                Both signatures go on one transaction. In this build they are collected on one computer: the buyer signs in Phantom, then
                Phantom is switched to the supplier account to sign the same transaction. Signing from two separate devices isn't supported
                yet.
              </p>
              <button className="primary" disabled={session.busy || held === null} onClick={startSettle}>
                Sign settlement: {money(cur.toSupplierMinor)} to supplier · {money(cur.toBuyerMinor)} to buyer
              </button>
            </>
          )}
        </OfferView>
      )}

      {held !== null && (v.phase === "no_offer" ? v.canPropose : countering) && (
        <OfferForm
          held={held}
          counterOf={countering ? cur : null}
          busy={session.busy}
          onCancel={countering ? () => setCountering(false) : undefined}
          onSend={(kind, sup, buy) => session.propose(role, kind, sup, buy)}
        />
      )}
      {v.phase === "no_offer" && !v.canPropose && v.waitingOn && <p className="note">Waiting on {who(v.waitingOn)} to propose.</p>}

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
        "Viewing as" is a demo switch, not a sign-in: this server can't verify which party sends an offer or an answer. Signatures on
        devnet are the only proof of who agreed to move money.
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
  { id: "split", desc: "Choose how much the supplier gets; the rest goes back to the buyer." },
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
  const err = supMinor === null ? "Enter an amount like 5.00." : split ? splitError(held, split.toSupplierMinor, split.toBuyerMinor) : null;

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
          {counterOf ? `Send counter-offer (replaces v${counterOf.version})` : "Send offer"}
        </button>
        {onCancel && (
          <button className="secondary" onClick={onCancel} disabled={busy}>
            Back
          </button>
        )}
      </div>
      <p className="note">Sending an offer moves no money. It only takes effect if the other side accepts and you both sign.</p>
    </div>
  );
}

// ---------- settlement transaction ----------

function SettlementSent({
  orderId,
  pending,
  setPending,
  escrowAddress,
  serverStatus,
  serverSignature = null,
}: {
  orderId: string;
  pending: PendingSettle | null;
  setPending: (p: PendingSettle | null) => void;
  escrowAddress: string | undefined;
  serverStatus?: string;
  serverSignature?: string | null;
}) {
  const [msg, setMsg] = useState<{ tone: "warn" | "bad" | "ok"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const signature = serverSignature ?? pending?.signature ?? null;
  if (!signature) return null;

  const recheck = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (!escrowAddress) throw new Error("This order has no recorded escrow.");
      // The server verifies the settle transaction on devnet and updates the escrow record (same signature = re-check).
      const detail = await recheckEvent(orderId, "settle", signature, escrowAddress);
      if (detail.order.escrow?.status === "settled") {
        savePending(null, orderId);
        setPending(null);
        setMsg({ tone: "ok", text: "Confirmed on devnet and verified by ClearDock." });
      }
      if (pending) await liveAgreementApi.recordSettlement(orderId, { offerId: pending.offerId, signature }).catch(() => {});
    } catch (err) {
      const reason = (err as Error).message;
      if (!pending) {
        setMsg({ tone: "warn", text: `Not confirmed yet: ${reason}` });
      } else {
        try {
          const outcome = await checkPendingSettle(pending);
          if (outcome === "expired") {
            savePending(null, orderId);
            setPending(null);
            setMsg({ tone: "warn", text: "It expired without landing, so nothing moved. You can sign a fresh settlement (both signatures again)." });
          } else if (outcome === "pending") {
            setMsg({ tone: "warn", text: `Not on devnet yet, and it can still land until block ${pending.lastValidBlockHeight}. Check again shortly; don't sign another.` });
          } else {
            setMsg({ tone: "bad", text: `It is on devnet, but ClearDock couldn't verify it: ${reason}` });
          }
        } catch (e) {
          setMsg({ tone: "bad", text: `Couldn't reach devnet to check: ${(e as Error).message}` });
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-8">
      <span className="eyebrow">Settlement transaction</span>
      <h2 className="h2-sm">{serverStatus === "unknown" ? "Sent · confirmation unknown" : "Sent · waiting for devnet confirmation"}</h2>
      <p className="body">
        Nothing is shown as paid or refunded until devnet confirms it and ClearDock verifies the amounts. Don't sign another settlement
        while this one could still land.
      </p>
      <a className="mono small" href={txUrl(signature)} target="_blank" rel="noreferrer">
        tx {shortSig(signature)} ↗
      </a>
      <div className="row wrap gap-6">
        <button className="secondary sm" onClick={recheck} disabled={busy}>
          {busy ? "Checking…" : "Re-check on devnet"}
        </button>
      </div>
      {msg && <p className={msg.tone === "bad" ? "error" : msg.tone === "ok" ? "ok-text" : "notice warn"}>{msg.text}</p>}
    </div>
  );
}
