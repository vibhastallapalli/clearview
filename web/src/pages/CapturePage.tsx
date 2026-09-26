import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { BrandMark } from "../components/Layout";

/**
 * Opened on a phone by scanning the QR code on the order screen.
 * Live camera needs HTTPS (or localhost). If it's unavailable we fall back to
 * the phone's native camera through a file input, which works everywhere.
 */
export function CapturePage() {
  const { code } = useParams<{ code: string }>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ref, setRef] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [mock, setMock] = useState(false);
  const [scenario, setScenario] = useState("match");

  useEffect(() => {
    api.captureSession(code!).then((s) => setRef(s.orderReference)).catch((e) => setError(e.message));
    api.health().then((h) => setMock(h.ai === "mock")).catch(() => {});
  }, [code]);

  useEffect(() => {
    if (!ref) return;
    let stream: MediaStream | null = null;
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamError("Live camera needs HTTPS. Use the button below instead.");
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 } }, audio: false })
      .then((s) => {
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch((e) => setCamError(`Camera unavailable (${e.name}). Use the button below instead.`));
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, [ref]);

  const send = async (blob: Blob) => {
    setState("sending");
    setError(null);
    try {
      await api.submitCapture(code!, blob, mock ? scenario : undefined);
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
    canvas.toBlob((b) => b && send(b), "image/jpeg", 0.9);
  };

  if (error && !ref) return <div className="capture"><p className="error">{error}</p></div>;

  return (
    <div className="capture">
      <div className="capture-head">
        <BrandMark />
        <span className="eyebrow">ClearDock · receiving</span>
      </div>
      <h1>Capture delivery</h1>
      <p className="muted">
        Order <span className="mono">{ref ?? "…"}</span> · lay packages out with labels facing up
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

      {mock && (
        <label className="small">
          MOCK result to return:{" "}
          <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
            <option value="match">All 3 bags correct</option>
            <option value="core">2 × A + 1 × B (core example)</option>
            <option value="unreadable">Label obscured</option>
          </select>
        </label>
      )}

      <div className="capture-actions">
        {!camError && (
          <button className="primary big" onClick={snap} disabled={state === "sending"}>
            {state === "sending" ? "Sending…" : "Capture"}
          </button>
        )}
        <label className="button big">
          Use phone camera
          <input
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) send(f);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {state === "sent" && <p className="ok-text">✓ Sent. Check the laptop for the result. You can capture again.</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
