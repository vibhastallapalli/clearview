import { useState } from "react";
import QRCode from "qrcode";
import type { OrderDetail, PhoneProofView, ProofFinding } from "@cleardock/shared";
import { api } from "../api";
import { proofDisplay } from "./proofState";

const PHOTO: Record<ProofFinding["photo"], string> = {
  supports: "photo supports",
  contradicts: "photo contradicts",
  not_visible: "not visible in photo",
};

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * Buyer phone photos attached as proof to the station result. Same data for buyer and supplier
 * (GET /orders/:id). Proof never changes the station report, the amounts or any escrow step.
 */
export function ProofPanel({ detail, role }: { detail: OrderDetail; role: "buyer" | "supplier" }) {
  const [qr, setQr] = useState<{ img: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [sample, setSample] = useState("one_missing");
  const [sending, setSending] = useState(false);
  const sendSample = async () => {
    setSending(true);
    setError(null);
    try {
      await api.sampleProof(order.id, sample);
    } catch (err) {
      setError(`Sample photo failed: ${(err as Error).message}`);
    } finally {
      setSending(false);
    }
  };
  const { order, proofs, latestCapture } = detail;
  const hasStationScan = latestCapture?.source === "station" && !!order.comparison;
  const isBuyer = role === "buyer";

  const openQr = async () => {
    setOpening(true);
    setError(null);
    try {
      const { url } = await api.createCaptureSession(order.id);
      setQr({ img: await QRCode.toDataURL(url, { margin: 1, width: 220 }), url });
    } catch (err) {
      setError(`Couldn't create a capture link: ${(err as Error).message}`);
    } finally {
      setOpening(false);
    }
  };

  return (
    <section className="card">
      <div className="row between wrap">
        <span className="eyebrow">Photo proof · {proofs.length ? `${proofs.length} saved` : "none yet"}</span>
        {isBuyer && hasStationScan && (
          <button className="secondary sm" onClick={openQr} disabled={opening}>
            {qr ? "New QR code" : "Add photo proof"}
          </button>
        )}
      </div>
      <p className="note">
        {isBuyer
          ? "Photos from your phone back up the station report for you and the supplier. They don't change the station report, the amounts or the escrow."
          : "Photos the buyer took to back up the station report. They don't change the station report, the amounts or the escrow."}
      </p>
      {isBuyer && hasStationScan && (
        <div className="row wrap gap-6">
          <select value={sample} onChange={(e) => setSample(e.target.value)} disabled={sending} aria-label="Sample photo">
            <option value="one_missing">Sample: one bag missing</option>
            <option value="swapped">Sample: bag swapped</option>
            <option value="label_covered">Sample: label covered</option>
            <option value="all_correct">Sample: all correct</option>
          </select>
          <button className="secondary sm" onClick={sendSample} disabled={sending}>
            {sending ? "Assessing sample…" : "Use a sample photo"} <span className="sim">SIMULATED</span>
          </button>
        </div>
      )}
      {isBuyer && !hasStationScan && (
        <p className="notice warn">Photo proof attaches to a station scan. Scan the delivery at the receiving station first.</p>
      )}
      {error && <p className="error">{error}</p>}
      {isBuyer && qr && (
        <div className="qr">
          <img src={qr.img} alt="QR code to open the photo proof page on a phone" />
          <p className="body">
            Scan with your phone and photograph the delivery. Link expires in 15 min.
            <br />
            <a href={qr.url} target="_blank" rel="noreferrer">
              {qr.url}
            </a>
            {!qr.url.startsWith("https://") && (
              <>
                <br />
                This link isn't HTTPS, so phone browsers will block the live camera. The phone's own camera button still
                works; for the live view set PUBLIC_WEB_URL to an HTTPS tunnel.
              </>
            )}
          </p>
        </div>
      )}
      {proofs.map((p) => (
        <ProofItem key={p.id} proof={p} latestScanId={order.latestScanId} isBuyer={isBuyer} onRetry={openQr} />
      ))}
    </section>
  );
}

function ProofItem({ proof, latestScanId, isBuyer, onRetry }: { proof: PhoneProofView; latestScanId: string | null; isBuyer: boolean; onRetry: () => void }) {
  const d = proofDisplay(proof, latestScanId, Date.now());
  const a = proof.assessment;
  return (
    <article className={d.historical ? "proof historical" : "proof"}>
      <a className="proof-photo" href={proof.capture.imageUrl} target="_blank" rel="noreferrer">
        <img src={proof.capture.imageUrl} alt={`Phone photo proof taken ${time(proof.createdAt)}`} />
      </a>
      <div className="proof-body">
        <div className="row wrap gap-6">
          <span className={`pill ${d.tone} pill-xs`}>
            {d.state === "pending" && <span className="spinner spinner-xs" aria-hidden="true" />}
            {d.label}
          </span>
          {d.mock && <span className="sim">MOCK AI</span>}
          {proof.capture.fixture && <span className="sim">SAMPLE PHOTO · SIMULATED</span>}
          {d.historical && <span className="pill muted pill-xs">Historical · earlier station scan</span>}
          <span className="pill muted pill-xs">AI assessment · evidence only</span>
        </div>
        {d.state === "pending" && <p className="small">Photo saved. The server is assessing it against the station scan.</p>}
        {d.state === "stalled" && (
          <p className="small">Photo saved, but the assessment never finished (the server may have restarted). Take another photo to try again.</p>
        )}
        {d.state === "failed" && (
          <p className="small">
            Photo saved; not assessed{a.error ? `: ${a.error}` : "."}
          </p>
        )}
        {a.status === "complete" && <p className="small">{a.summary}</p>}
        {d.coverage && <p className="small muted">{d.coverage}</p>}
        {a.findings.length > 0 && (
          <ul className="small proof-findings">
            {a.findings.map((f, i) => (
              <li key={i}>
                <b>{f.description}</b> · station: {f.stationVerdict.replace("_", " ")} · {PHOTO[f.photo]}
                {f.note && <> · {f.note}</>}
              </li>
            ))}
          </ul>
        )}
        {a.observed.length > 0 && (
          <p className="small">
            <b>In this photo:</b> {a.observed.map((o) => `${o.count} × ${o.labelText}`).join(", ")}
          </p>
        )}
        {a.untrustedText.length > 0 && (
          <p className="small warn-text">
            Text in the photo that reads like an instruction (recorded, ignored): {a.untrustedText.map((t) => `“${t}”`).join(", ")}
          </p>
        )}
        {isBuyer && d.canRetry && (
          <button className="secondary sm" onClick={onRetry}>
            Take another photo
          </button>
        )}
        <p className="caption">
          phone · {time(proof.createdAt)} · sha256 {proof.imageSha256.slice(0, 10)}… · vs station scan {proof.stationScanId} (rev{" "}
          {proof.evidenceRevision})
          {a.assessedAt && ` · assessed ${time(a.assessedAt)}`}
          {a.analyzedBy && ` · ${a.analyzedBy}${a.model ? ` ${a.model}` : ""}`}
        </p>
      </div>
    </article>
  );
}
