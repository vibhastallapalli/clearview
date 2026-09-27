import { useState } from "react";
import QRCode from "qrcode";
import { api } from "../api";

/** Test aid until the station hardware exists: scan an uploaded photo as the station camera. Labelled SIMULATED. */
export function StationSimulator({ orderId }: { orderId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<{ img: string; url: string } | null>(null);
  const showQr = async () => {
    setError(null);
    try {
      const { url } = await api.createStationSession(orderId);
      setQr({ img: await QRCode.toDataURL(url, { margin: 1, width: 220 }), url });
    } catch (err) {
      setError(`Couldn't create the station link: ${(err as Error).message}`);
    }
  };
  const send = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      await api.simulateStationPhoto(orderId, file);
    } catch (err) {
      setError(`Station scan failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <div className="row between wrap">
        <span className="eyebrow">
          Station camera <span className="sim">SIMULATED</span>
        </span>
        <div className="row wrap gap-6">
        <button className="primary sm" onClick={showQr} disabled={busy}>
          {qr ? "New station QR code" : "Scan with your phone (QR)"}
        </button>
        <label className="button">
          {busy ? "Scanning with the AI…" : "Upload a photo as the station scan"}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) send(f);
              e.target.value = "";
            }}
          />
        </label>
        </div>
      </div>
      {qr && (
        <div className="qr">
          <img src={qr.img} alt="QR code for the simulated station camera" />
          <p className="body">
            Scan with your phone and photograph the delivery. The photo is the station scan. Link expires in 15 min.
            <br />
            <a href={qr.url} target="_blank" rel="noreferrer">
              {qr.url}
            </a>
          </p>
        </div>
      )}
      <p className="note">
        Stands in for the receiving station until the hardware is ready. The photo is counted by the AI and compared with the
        purchase order and invoice exactly like a station scan, and replaces the current station result.
      </p>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
