import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { OrderDetail } from "@cleardock/shared";
import { api, type OrderRow } from "../api";
import { AI_SOURCE } from "../escrow/demo";

const POLL_MS = 3000;
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/**
 * The receiving station's view. The station (Pi + camera + detector) posts each capture to
 * POST /api/station/captures; this page only shows what arrived for the chosen order. Buyer and supplier
 * see the result on the order page.
 */
export function StationPage() {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [orderId, setOrderId] = useState<string>("");
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.orders().then((os) => {
      setOrders(os);
      setOrderId((cur) => cur || os[0]?.id || "");
    }, (e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!orderId) return;
    let stop = false;
    const tick = () => api.order(orderId).then((d) => !stop && (setDetail(d), setError(null)), (e: Error) => !stop && setError(e.message));
    tick();
    const t = window.setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [orderId]);

  const scan = detail?.latestScan ?? null;
  const cap = detail?.latestCapture ?? null;
  const c = detail?.order.comparison ?? null;

  return (
    <section className="page">
      <section className="card">
        <span className="eyebrow">Receiving station</span>
        <h2 className="h2-sm">What the station camera sent</h2>
        <p className="note">
          The Pi sends each tray photo with the detector's counts to <code>POST /api/station/captures</code> (header{" "}
          <code>x-station-token</code>; fields <code>orderId</code>, <code>image</code>, <code>totalCount</code>, <code>normalCount</code>,{" "}
          <code>damagedCount</code>, optional <code>model</code> and <code>sku</code>). No AI looks at a photo that comes with counts. The buyer
          and supplier see the result on the order page.
        </p>
        <label className="row gap-6">
          Order
          <select value={orderId} onChange={(e) => setOrderId(e.target.value)}>
            {orders.map((o) => (
              <option key={o.id} value={o.id}>
                {o.reference} · {o.id}
              </option>
            ))}
          </select>
          {orderId && <Link to={`/orders/${orderId}`}>Open the order page →</Link>}
        </label>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="card">
        <div className="row between wrap">
          <span className="eyebrow">Latest capture</span>
          {scan && <span className={`pill ${scan.analyzedBy === "yolo" ? "ok" : "warn"} pill-sm`}>{AI_SOURCE[scan.analyzedBy]}</span>}
        </div>
        {!cap || !scan ? (
          <p className="body">Nothing from the station for this order yet. Waiting for the first capture…</p>
        ) : (
          <div className="stack-8">
            <img className="evidence" src={cap.imageUrl} alt="Latest station capture" />
            <p className="caption-plain">
              {time(cap.capturedAt)} · {cap.source} · sha256 {cap.imageSha256.slice(0, 12)}…{cap.fixture && <b className="sim-inline"> · SIMULATED ({cap.fixture})</b>}
            </p>
            {scan.detector ? (
              <div className="totals three">
                <div className="tint plain">
                  <span className="tint-label">Cans counted</span>
                  <span className="tint-value">{scan.detector.totalCount}</span>
                </div>
                <div className="tint ok">
                  <span className="tint-label">Intact</span>
                  <span className="tint-value">{scan.detector.normalCount}</span>
                </div>
                <div className="tint warn">
                  <span className="tint-label">Damaged</span>
                  <span className="tint-value">{scan.detector.damagedCount}</span>
                </div>
              </div>
            ) : (
              <p className="notice warn">This capture came without detector counts, so it was analysed by {AI_SOURCE[scan.analyzedBy]}.</p>
            )}
            <p className="note">{scan.notes}</p>
            {scan.unreadable.map((u, i) => (
              <p key={i} className="warn-text">
                ⚠ {u}
              </p>
            ))}
            {c && (
              <p className={c.outcome === "match" ? "ok-text" : "warn-text"}>
                Comparison: {c.outcome.replace("_", " ")} · {c.summary}
              </p>
            )}
          </div>
        )}
      </section>

      {orderId && <SimulatedDetector orderId={orderId} />}
    </section>
  );
}

/** Test aid while the Pi isn't connected: send a photo with typed counts, labelled SIMULATED. Local only. */
function SimulatedDetector({ orderId }: { orderId: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [normal, setNormal] = useState("2");
  const [damaged, setDamaged] = useState("1");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    if (!file) return setMsg("Pick a photo first.");
    setBusy(true);
    setMsg(null);
    try {
      const n = Number(normal);
      const d = Number(damaged);
      await api.simulateStationPhoto(orderId, file, { totalCount: String(n + d), normalCount: normal, damagedCount: damaged });
      setMsg("Sent. The capture above updates in a few seconds.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="card card-soft">
      <summary>
        <span className="eyebrow">Test without the Pi</span> <span className="sim">SIMULATED</span>
      </summary>
      <div className="stack-8">
        <p className="note">Sends a photo with counts you type, as if the detector had produced them. It is labelled SIMULATED everywhere. Only works on this computer (not through a tunnel).</p>
        <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <div className="row wrap gap-6">
          <label className="row gap-6">
            Intact <input className="terms-hours" inputMode="numeric" value={normal} onChange={(e) => setNormal(e.target.value)} />
          </label>
          <label className="row gap-6">
            Damaged <input className="terms-hours" inputMode="numeric" value={damaged} onChange={(e) => setDamaged(e.target.value)} />
          </label>
          <button className="secondary sm" disabled={busy} onClick={send}>
            {busy ? "Sending…" : "Send as station capture"}
          </button>
        </div>
        {msg && <p className="note">{msg}</p>}
      </div>
    </details>
  );
}
