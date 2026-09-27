import { useState } from "react";
import QRCode from "qrcode";
import type { OrderDetail, PhoneProofView } from "@cleardock/shared";
import { api } from "../api";
import { isHistorical, splitProofs } from "./proofState";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * Buyer photos attached as proof to the station result, for the supplier to judge. Same data for buyer
 * and supplier (GET /orders/:id). No AI reads them. Live in-app photos and uploaded files are shown
 * apart. Proof never changes the station report, the amounts or any escrow step.
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
  const { live, uploads } = splitProofs(proofs);

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
          ? "Photos go to the supplier as proof of what arrived. No AI checks or labels them. They don't change the station report, the amounts or the escrow."
          : "Photos the buyer sent as proof of what arrived. No AI checks or labels them: judge them yourself. They don't change the station report, the amounts or the escrow."}
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
            {sending ? "Attaching sample…" : "Use a sample photo"} <span className="sim">SIMULATED</span>
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
      <ProofGroup
        title="Live photos"
        note="Taken with the in-app camera at the time of upload, as reported by the capture page."
        proofs={live}
        latestScanId={order.latestScanId}
      />
      <ProofGroup
        title="Additional evidence · uploaded files"
        note="Picked from the buyer's device. Could be any image: not a live photo."
        proofs={uploads}
        latestScanId={order.latestScanId}
      />
    </section>
  );
}

function ProofGroup({ title, note, proofs, latestScanId }: { title: string; note: string; proofs: PhoneProofView[]; latestScanId: string | null }) {
  if (!proofs.length) return null;
  return (
    <div className="stack-8">
      <span className="eyebrow">
        {title} · {proofs.length}
      </span>
      <p className="note">{note}</p>
      {proofs.map((p) => (
        <ProofItem key={p.id} proof={p} historical={isHistorical(p, latestScanId)} />
      ))}
    </div>
  );
}

function ProofItem({ proof, historical }: { proof: PhoneProofView; historical: boolean }) {
  const live = proof.kind === "live";
  return (
    <article className={historical ? "proof historical" : "proof"}>
      <a className="proof-photo" href={proof.capture.imageUrl} target="_blank" rel="noreferrer">
        <img src={proof.capture.imageUrl} alt={`${live ? "Live photo" : "Uploaded file"} sent ${time(proof.createdAt)}`} />
      </a>
      <div className="proof-body">
        <div className="row wrap gap-6">
          <span className={`pill ${live ? "info" : "warn"} pill-xs`}>{live ? "Live photo" : "Uploaded file"}</span>
          {proof.capture.fixture && <span className="sim">SAMPLE PHOTO · SIMULATED</span>}
          {historical && <span className="pill muted pill-xs">Historical · earlier station scan</span>}
        </div>
        <p className="caption">
          {time(proof.createdAt)} · sha256 {proof.imageSha256.slice(0, 10)}… · for station scan {proof.stationScanId} (rev{" "}
          {proof.evidenceRevision})
        </p>
      </div>
    </article>
  );
}
