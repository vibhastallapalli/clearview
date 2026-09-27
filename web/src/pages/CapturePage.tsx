import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import type { ProofKind } from "@cleardock/shared";
import { api } from "../api";
import { BrandMark } from "../components/Layout";

/**
 * Opened on a phone by scanning the QR code on the order screen. The photo goes to the supplier as
 * raw proof for the order's station scan; no AI reads it and it never replaces the station report.
 * Live photos come only from the in-app camera (needs HTTPS or localhost). Picking a file is a
 * separate "additional evidence" upload and is labelled that way for the supplier.
 */
export function CapturePage() {
  const { code } = useParams<{ code: string }>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ref, setRef] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [lastKind, setLastKind] = useState<ProofKind | null>(null);

  useEffect(() => {
    api.captureSession(code!).then((s) => setRef(s.orderReference)).catch((e) => setError(e.message));
  }, [code]);

  useEffect(() => {
    if (!ref) return;
    let stream: MediaStream | null = null;
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamError("The live camera needs HTTPS, so live photos aren't available on this link. You can still upload a file as additional evidence.");
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 } }, audio: false })
      .then((s) => {
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch((e) => setCamError(`Camera unavailable (${e.name}), so live photos aren't available. You can still upload a file as additional evidence.`));
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, [ref]);

  const send = async (blob: Blob, kind: ProofKind) => {
    setState("sending");
    setError(null);
    try {
      await api.submitCapture(code!, blob, kind);
      setLastKind(kind);
      setState("sent");
    } catch (e) {
      setError((e as Error).message);
      setState("idle");
    }
  };

  const snap = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")!.drawImage(v, 0, 0);
    canvas.toBlob((b) => b && send(b, "live"), "image/jpeg", 0.9);
  };

  if (error && !ref) return <div className="capture"><p className="error">{error}</p></div>;

  return (
    <div className="capture">
      <div className="capture-head">
        <BrandMark />
        <span className="eyebrow">SecuroServ · photo proof</span>
      </div>
      <h1>Add photo proof</h1>
      <p className="muted">
        Order <span className="mono">{ref ?? "…"}</span> · labels facing up. The supplier sees this photo as proof. It
        doesn't change the station report.
      </p>

      {!camError && (
        <div className="viewfinder-frame">
          <video ref={videoRef} autoPlay playsInline muted className="viewfinder" />
          <span className="corner tl" aria-hidden="true" />
          <span className="corner tr" aria-hidden="true" />
          <span className="corner bl" aria-hidden="true" />
          <span className="corner br" aria-hidden="true" />
        </div>
      )}
      {camError && <p className="warn-text">{camError}</p>}

      {!camError && (
        <div className="capture-actions">
          <button className="primary big" onClick={snap} disabled={state === "sending"}>
            {state === "sending" ? "Sending…" : "Take live photo"}
          </button>
        </div>
      )}

      <section className="stack-8">
        <span className="eyebrow">Additional evidence</span>
        <p className="small muted">
          A file from your phone (a screenshot, an earlier photo, a document). The supplier sees it marked "Uploaded file",
          not as a live photo.
        </p>
        <label className="button">
          Upload a file
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) send(f, "upload");
              e.target.value = "";
            }}
          />
        </label>
      </section>

      {state === "sent" && lastKind && (
        <p className="ok-text">
          ✓ {lastKind === "live" ? "Live photo" : "Uploaded file"} saved as proof. The buyer and supplier both see it on the order.
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
