import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import QRCode from "qrcode";
import type { DocumentKind, OrderDetail } from "@cleardock/shared";
import { api, money } from "../api";
import { StatusBadge, VerdictBadge } from "../components/StatusBadge";
import { PaymentPanel } from "../payment/PaymentPanel";
import { short } from "../format";

const DOC_LABEL: Record<DocumentKind, string> = {
  purchase_order: "Purchase order",
  invoice: "Invoice",
  delivery_receipt: "Delivery receipt (optional)",
};

export function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [qr, setQr] = useState<{ img: string; url: string } | null>(null);

  const load = useCallback(() => api.order(id!).then(setData).catch((e) => setError(e.message)), [id]);

  useEffect(() => {
    load();
    // Poll so a phone capture shows up here without refreshing.
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      const res = await fn();
      if (res && typeof res === "object" && "order" in res) setData(res as OrderDetail);
      else await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!data) return <p className="muted">{error ?? "Loading…"}</p>;
  const { order, supplier, documents, latestCapture, latestScan } = data;
  const c = order.comparison;

  const showQr = () =>
    run("qr", async () => {
      const { url } = await api.createCaptureSession(order.id);
      setQr({ img: await QRCode.toDataURL(url, { margin: 1, width: 220 }), url });
    });

  return (
    <section className="order">
      <div className="row between">
        <div>
          <h1>{order.reference}</h1>
          <p className="muted">
            {supplier.name} · wallet {short(supplier.walletAddress)} {supplier.verified ? "(verified)" : "(NOT verified)"}
          </p>
        </div>
        <StatusBadge status={order.status} />
      </div>

      {error && <p className="error">{error}</p>}

      <div className="grid">
        {/* ---------- Documents ---------- */}
        <div className="card">
          <h2>Documents</h2>
          {(["purchase_order", "invoice", "delivery_receipt"] as DocumentKind[]).map((kind) => {
            const doc = documents.filter((d) => d.kind === kind).at(-1);
            return (
              <div key={kind} className="doc">
                <div className="row between">
                  <strong>{DOC_LABEL[kind]}</strong>
                  <label className="button small">
                    {doc ? "Replace" : "Upload"}
                    <input
                      type="file"
                      accept="application/pdf,image/png,image/jpeg"
                      hidden
                      disabled={!!busy}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) run(`upload-${kind}`, () => api.uploadDocument(order.id, kind, f));
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>
                {busy === `upload-${kind}` && <p className="muted">Extracting…</p>}
                {doc && (
                  <div className="small">
                    {doc.source.filename} · {doc.language?.toUpperCase() ?? "?"} ·{" "}
                    {doc.extractedBy === "mock" ? <span className="pill warn">MOCK</span> : "Gemini"}
                    <ul>
                      {doc.lines.map((l, i) => (
                        <li key={i}>
                          {l.quantity} {l.unit} · {l.description} · {money(l.unitPriceMinor)}
                          <div className="source">“{l.sourceText}”</div>
                        </li>
                      ))}
                    </ul>
                    {doc.warnings.map((w, i) => (
                      <p key={i} className="warn-text">
                        ⚠ {w}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* ---------- Delivery evidence ---------- */}
        <div className="card">
          <div className="row between">
            <h2>Delivery evidence</h2>
            <button onClick={showQr} disabled={!!busy}>
              Capture with phone
            </button>
          </div>
          {qr && (
            <div className="qr">
              <img src={qr.img} alt="QR code to open the capture page" />
              <p className="small">
                Scan to capture this order. Link expires in 15 min.
                <br />
                <a href={qr.url} target="_blank" rel="noreferrer">
                  {qr.url}
                </a>
              </p>
            </div>
          )}
          {latestCapture ? (
            <>
              <img className="evidence" src={latestCapture.imageUrl} alt="Latest delivery capture" />
              <p className="small muted">
                {latestCapture.source} · {new Date(latestCapture.capturedAt).toLocaleTimeString()} · sha256{" "}
                {latestCapture.imageSha256.slice(0, 10)}…
              </p>
              {latestCapture.sensors.map((s, i) => (
                <p key={i} className="small">
                  Weight: {s.grams} g {s.simulated && <span className="pill warn">SIMULATED</span>}
                </p>
              ))}
            </>
          ) : (
            <p className="muted">No capture yet. Use the receiving station or a phone.</p>
          )}
          {latestScan && (
            <div className="small">
              <strong>Seen:</strong>{" "}
              {latestScan.observed.map((o) => `${o.count} × ${o.labelText}`).join(", ") || "nothing"}
              {latestScan.unreadable.map((u, i) => (
                <p key={i} className="warn-text">
                  ? Unreadable: {u}
                </p>
              ))}
              {latestScan.analyzedBy === "mock" && <p className="warn-text">⚠ {latestScan.notes}</p>}
            </div>
          )}
        </div>
      </div>

      {/* ---------- Comparison ---------- */}
      <div className="card">
        <h2>Ordered vs billed vs delivered</h2>
        {c ? (
          <>
            <p className={c.outcome === "match" ? "ok-text" : "warn-text"}>{c.summary}</p>
            <table className="table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">Ordered</th>
                  <th className="num">Billed</th>
                  <th className="num">Delivered</th>
                  <th className="num">Unit price</th>
                  <th>Result</th>
                  <th className="num">At stake</th>
                </tr>
              </thead>
              <tbody>
                {c.lines.map((l, i) => (
                  <tr key={i} title={l.explanation}>
                    <td>{l.description}</td>
                    <td className="num">{l.ordered ?? "—"}</td>
                    <td className="num">{l.billed ?? "—"}</td>
                    <td className="num">{l.observed ?? "—"}</td>
                    <td className="num">{money(l.unitPriceMinor)}</td>
                    <td>
                      <VerdictBadge verdict={l.verdict} />
                    </td>
                    <td className="num">{l.discrepancyMinor ? money(l.discrepancyMinor) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">
              Ordered {money(c.orderedTotalMinor)} · Billed {money(c.billedTotalMinor)} · Undisputed{" "}
              {money(c.undisputedMinor)} · evidence rev {c.evidenceRevision}
            </p>
          </>
        ) : (
          <p className="muted">Upload documents and capture the delivery to compare.</p>
        )}
      </div>

      {/* Owned by the Solana/payments workstream: web/src/payment/ */}
      <PaymentPanel detail={data} busy={!!busy} run={run} />
    </section>
  );
}

