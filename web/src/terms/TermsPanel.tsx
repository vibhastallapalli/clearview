import { useCallback, useEffect, useState } from "react";
import { REMEDY_ISSUES, type OrderDetail, type OrderTermsState, type OrderTermsVersion, type Party, type TermsPreview } from "@cleardock/shared";
import { ApiRequestError } from "../api";
import { usd } from "../escrow/demo";
import { short } from "../format";
import * as phantom from "../wallet/phantom";
import { REMEDY_LABEL, initialDraft, parseDraft, termsApi, termsToSign, type DraftLine, type DraftRemedies } from "./terms";

/** What a proposal sends besides who and which revision. */
type TermsBody = { lines: TermsPreview["terms"]["lines"]; inspectionHours: number; remedies: TermsPreview["terms"]["remedies"] };

const POLL_MS = 2000;
const OTHER: Record<Party, Party> = { buyer: "supplier", supplier: "buyer" };
const at = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

export interface TermsSession {
  state: OrderTermsState | null;
  error: string | null;
  refresh: () => Promise<void>;
  set: (st: OrderTermsState) => void;
}

/** The server's order terms, polled so the other party's proposal or approval shows up without a reload. */
export function useTerms(orderId: string): TermsSession {
  const [state, setState] = useState<OrderTermsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(
    () =>
      termsApi.get(orderId).then(
        (st) => (setState(st), setError(null)),
        (err: Error) => setError(err.message),
      ),
    [orderId],
  );
  useEffect(() => {
    setState(null);
    refresh();
    const t = window.setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);
  return { state, error, refresh, set: setState };
}

const STEPS = ["Draft terms", "Awaiting other party", "Both agreed", "Funded · frozen"];
const stepOf = (st: OrderTermsState) => ({ none: 0, stale: 0, awaiting_approval: 1, agreed: 2, funded: 3, legacy: -1 })[st.status];
const STATUS: Record<OrderTermsState["status"], [string, string]> = {
  none: ["No terms yet", "warn"],
  awaiting_approval: ["Awaiting approval", "warn"],
  agreed: ["Agreed by both", "ok"],
  stale: ["Stale · re-propose", "bad"],
  funded: ["Funded · frozen", "ok"],
  legacy: ["Legacy · no signed terms", "info"],
};

export function TermsPanel({ detail, role, terms }: { detail: OrderDetail; role: Party; terms: TermsSession }) {
  const orderId = detail.order.id;
  const { state, error: loadError } = terms;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!state) return <section className="card">{loadError ? <p className="error">Can't read the order terms: {loadError}</p> : <p className="muted">Loading order terms…</p>}</section>;
  const [label, tone] = STATUS[state.status];
  const cur = state.current;
  const open = state.status !== "funded" && state.status !== "legacy";
  const other = OTHER[role];

  const run = async (fn: () => Promise<OrderTermsState>) => {
    setBusy(true);
    setError(null);
    try {
      terms.set(await fn());
      setEditing(false);
    } catch (err) {
      const conflict = err instanceof ApiRequestError && err.status === 409;
      setError(conflict ? `${err.message} The latest terms are shown below; nothing you signed was applied.` : (err as Error).message);
      await terms.refresh();
    } finally {
      setBusy(false);
    }
  };

  const approve = (v: OrderTermsVersion) =>
    run(async () => {
      const message = await termsToSign(orderId, role, v, phantom.currentPublicKey() ?? (await phantom.connect()));
      const walletSignature = await phantom.signMessage(message);
      return termsApi.approve(orderId, { as: role, version: v.version, termsHash: v.termsHash, walletSignature });
    });

  if (state.status === "legacy")
    return (
      <section className="card card-soft">
        <div className="row between wrap">
          <span className="eyebrow">Step 2 · Order terms</span>
          <span className={`pill ${tone} pill-sm`}>{label}</span>
        </div>
        <p className="body">
          This escrow was funded before ClearDock had signed order terms. Nobody approved terms for it, so none are shown. Its
          escrow events still work.
        </p>
      </section>
    );

  return (
    <section className="card">
      <div className="row between wrap">
        <span className="eyebrow">Step 2 · Order terms · agreed before funding</span>
        <span className={`pill ${tone} pill-sm`}>{label}</span>
      </div>
      <ol className="terms-steps" aria-label="Order terms progress">
        {STEPS.map((s, i) => (
          <li key={s} className={i < stepOf(state) ? "done" : i === stepOf(state) ? "on" : ""} aria-current={i === stepOf(state) ? "step" : undefined}>
            {s}
          </li>
        ))}
      </ol>

      {state.status === "stale" && <p className="error">These terms are stale and can't be funded: {state.staleReason}</p>}
      {error && <p className="error">{error}</p>}

      {cur && <TermsVersionView v={cur} funded={state.funded} />}

      {open && cur && !editing && (
        <div className="row wrap gap-6">
          {state.status === "awaiting_approval" && state.outstanding.includes(role) && (
            <button className="primary" disabled={busy} onClick={() => approve(cur)}>
              {busy ? "Waiting for Phantom…" : `Approve terms v${cur.version} with Phantom`}
            </button>
          )}
          {state.status === "awaiting_approval" && !state.outstanding.includes(role) && (
            <p className="notice suggest">You approved v{cur.version}. Waiting on the {state.outstanding.join(" and ")} to approve the same version.</p>
          )}
          {state.status === "agreed" && <p className="notice suggest">Both parties approved v{cur.version}. The buyer can fund exactly {usd(cur.terms.totalMinor)} CDT.</p>}
          <button className="secondary sm" disabled={busy} onClick={() => setEditing(true)}>
            {state.status === "stale" ? `Propose new terms v${cur.version + 1}` : `Change terms (new version v${cur.version + 1})`}
          </button>
        </div>
      )}

      {open && (editing || !cur) && (
        <TermsEditor
          key={`${state.revision}`}
          detail={detail}
          state={state}
          role={role}
          busy={busy}
          onCancel={cur ? () => setEditing(false) : undefined}
          onPropose={(p, body) =>
            run(async () => {
              const message = await termsToSign(orderId, role, p, phantom.currentPublicKey() ?? (await phantom.connect()));
              const walletSignature = await phantom.signMessage(message);
              return termsApi.propose(orderId, { as: role, expectedRevision: state.revision, ...body, walletSignature });
            })
          }
        />
      )}

      {open && !cur && <p className="note">The {other} approves the same version after you propose it.</p>}

      {state.history.length > 0 && (
        <details className="terms-history">
          <summary>Earlier versions ({state.history.length}) · their approvals don't count</summary>
          <ul>
            {state.history.map((v) => (
              <li key={v.version}>
                v{v.version} · proposed by {v.proposedBy} {at(v.proposedAt)} · {usd(v.terms.totalMinor)} · approved by{" "}
                {v.approvals.map((a) => a.party).join(" and ")} · replaced
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function TermsVersionView({ v, funded, preview }: { v: OrderTermsVersion; funded: OrderTermsState["funded"]; preview?: boolean }) {
  const t = v.terms;
  const approval = (p: Party) => v.approvals.find((a) => a.party === p);
  return (
    <div className="stack-8">
      <p className="caption-plain">
        Version {v.version} · {preview ? "not proposed yet" : `proposed by ${v.proposedBy} ${at(v.proposedAt)}`} · terms sha256 <code>{v.termsHash.slice(0, 16)}…</code>
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Product</th>
              <th className="r">Qty</th>
              <th className="r">Unit price</th>
              <th className="r">Line total</th>
            </tr>
          </thead>
          <tbody>
            {t.lines.map((l, i) => (
              <tr key={i}>
                <td>
                  {l.description}
                  {l.sku && <span className="muted"> · {l.sku}</span>}
                </td>
                <td className="r">{l.quantity}</td>
                <td className="r">{usd(l.unitPriceMinor)}</td>
                <td className="r">{usd(l.quantity * l.unitPriceMinor)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={3}>
                <b>Total to fund (server-computed)</b>
              </td>
              <td className="r">
                <b>{usd(t.totalMinor)} CDT</b>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="kv">
        {(["buyer", "supplier"] as Party[]).map((p) => {
          const a = approval(p);
          return (
            <div key={p} className="kv-row">
              <span>
                {p === "buyer" ? "Buyer" : "Supplier"} · <code title={p === "buyer" ? t.buyerWallet : t.supplierWallet}>{short(p === "buyer" ? t.buyerWallet : t.supplierWallet)}</code>
              </span>
              <span className={`kv-value ${a ? "ok-text" : "warn-text"}`}>{a ? `✓ Approved v${v.version} · ${at(a.at)}` : preview ? "Signs if proposed" : `Not approved v${v.version}`}</span>
            </div>
          );
        })}
        <div className="kv-row">
          <span>Token · network</span>
          <span className="kv-value">CDT test token · Solana devnet</span>
        </div>
        <div className="kv-row">
          <span>If something is wrong (refund of the claimed item's price)</span>
          <span className="kv-value">
            {t.remedies
              ? REMEDY_ISSUES.map((i) => `${REMEDY_LABEL[i]} ${t.remedies[i]}%`).join(" · ")
              : "No remedy schedule (signed before schedules existed)"}
          </span>
        </div>
        <div className="kv-row">
          <span>Inspection window</span>
          <span className="kv-value">{t.inspection.hours} h from the first station scan after funding · informational, not enforced</span>
        </div>
        {funded && (
          <div className="kv-row">
            <span>Funded</span>
            <span className="kv-value">
              {at(funded.at)} · escrow <code title={funded.escrowAddress}>{short(funded.escrowAddress)}</code> · frozen
            </span>
          </div>
        )}
      </div>
      <details>
        <summary className="note">Rules both parties sign (v{t.rulesVersion})</summary>
        <ul className="note">
          {t.rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function TermsEditor(props: {
  detail: OrderDetail;
  state: OrderTermsState;
  role: Party;
  busy: boolean;
  onCancel?: () => void;
  onPropose: (preview: TermsPreview, body: TermsBody) => void;
}) {
  const { detail, state, role, busy } = props;
  const [init] = useState(() => initialDraft(state, detail));
  const [lines, setLines] = useState<DraftLine[]>(init.lines);
  const [hours, setHours] = useState(String(init.hours));
  const [remedies, setRemedies] = useState<DraftRemedies>(init.remedies);
  const [preview, setPreview] = useState<{ p: TermsPreview; body: TermsBody } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // Any edit voids the preview: only terms the server computed can be signed.
  const edit = (i: number, patch: Partial<DraftLine>) => {
    setPreview(null);
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  };

  const doPreview = async () => {
    const parsed = parseDraft(lines, hours, remedies);
    if ("error" in parsed) return setError(parsed.error);
    setError(null);
    setPreviewing(true);
    try {
      setPreview({ p: await termsApi.preview(detail.order.id, parsed), body: parsed });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div className="stack-8">
      <h3>{state.current ? `Change terms · becomes v${state.current.version + 1}` : "Draft the order terms"}</h3>
      <p className="note">
        {init.from ? `Prefilled from the ${init.from}. ` : "No purchase order is on file, so enter the lines. "}
        Proposing signs the new version as the {role}; every earlier approval stops counting and the other party must approve the new version.
      </p>
      <div className="table-wrap">
        <table className="table terms-edit">
          <thead>
            <tr>
              <th>Product</th>
              <th className="r">Qty</th>
              <th className="r">Unit price ($)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <input value={l.description} maxLength={200} aria-label={`Line ${i + 1} product`} onChange={(e) => edit(i, { description: e.target.value })} />
                </td>
                <td className="r">
                  <input inputMode="numeric" value={l.quantity} aria-label={`Line ${i + 1} quantity`} onChange={(e) => edit(i, { quantity: e.target.value })} />
                </td>
                <td className="r">
                  <input inputMode="decimal" value={l.unitPrice} aria-label={`Line ${i + 1} unit price in dollars`} onChange={(e) => edit(i, { unitPrice: e.target.value })} />
                </td>
                <td>
                  {lines.length > 1 && (
                    <button className="secondary sm" aria-label={`Remove line ${i + 1}`} onClick={() => (setPreview(null), setLines((ls) => ls.filter((_, j) => j !== i)))}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row wrap gap-6">
        <button className="secondary sm" onClick={() => (setPreview(null), setLines((ls) => [...ls, { sku: null, description: "", quantity: "1", unitPrice: "" }]))}>
          Add line
        </button>
        <label className="row gap-6">
          Inspection window (hours, informational)
          <input inputMode="numeric" value={hours} className="terms-hours" onChange={(e) => (setPreview(null), setHours(e.target.value))} />
        </label>
      </div>
      <fieldset className="remedies">
        <legend className="note">
          <b>If something is wrong:</b> refund to the buyer, as a percent of each claimed item's price. This is the default settlement
          offer; held money still moves only when both of you sign.
        </legend>
        <div className="row wrap gap-6">
          {REMEDY_ISSUES.map((i) => (
            <label key={i} className="row gap-6">
              {REMEDY_LABEL[i]}
              <input
                inputMode="numeric"
                className="terms-hours"
                value={remedies[i]}
                aria-label={`${REMEDY_LABEL[i]} refund percent`}
                onChange={(e) => (setPreview(null), setRemedies((r) => ({ ...r, [i]: e.target.value })))}
              />
              %
            </label>
          ))}
        </div>
      </fieldset>
      {error && <p className="error">{error}</p>}
      {preview && (
        <div className="notice suggest">
          <b>Server preview · v{preview.p.version}</b>
          <TermsVersionView v={{ ...preview.p, proposedBy: role, proposedAt: "", approvals: [] }} funded={null} preview />
        </div>
      )}
      <div className="row wrap gap-6">
        {!preview ? (
          <button className="primary" disabled={previewing || busy} onClick={doPreview}>
            {previewing ? "Computing…" : "Preview total and terms"}
          </button>
        ) : (
          <button className="primary" disabled={busy} onClick={() => props.onPropose(preview.p, preview.body)}>
            {busy ? "Waiting for Phantom…" : `Sign and propose v${preview.p.version} as ${role} (${usd(preview.p.terms.totalMinor)})`}
          </button>
        )}
        {props.onCancel && (
          <button className="secondary sm" disabled={busy} onClick={props.onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

