import { useState } from "react";
import { api } from "../api";

/** Test aid until the station hardware exists: scan an uploaded photo as the station camera. Labelled SIMULATED. */
export function StationSimulator({ orderId }: { orderId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        <label className="button">
          {busy ? "Scanning with the AI…" : "Upload a photo as the station scan"}
          <input
            type="file"
            accept="image/*"
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
      <p className="note">
        Stands in for the receiving station until the hardware is ready. The photo is counted by the AI and compared with the
        purchase order and invoice exactly like a station scan, and replaces the current station result.
      </p>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
