import { shortSig, txUrl, type Tx } from "./demo";

export interface ModalState {
  title: string;
  rows: [string, string][];
  phase: "ask" | "sending" | "done";
  tx?: Tx;
}

export function WalletModal({ state, onConfirm, onClose }: { state: ModalState; onConfirm: () => void; onClose: () => void }) {
  const { title, rows, phase, tx } = state;
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="wallet-title">
      <div className="sheet">
        <div className="row between">
          <span className="sheet-kicker">Wallet request</span>
          <span className="pill info">devnet</span>
        </div>
        <h3 id="wallet-title">{title}</h3>
        <div className="kv">
          {rows.map(([k, v]) => (
            <div key={k} className="kv-row">
              <span>{k}</span>
              <span className="kv-value">{v}</span>
            </div>
          ))}
        </div>
        {phase === "ask" && (
          <div className="sheet-actions">
            <button className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" onClick={onConfirm} autoFocus>
              Sign &amp; send
            </button>
          </div>
        )}
        {phase === "sending" && (
          <div className="busy">
            <span className="spinner" aria-hidden="true" /> Confirming on devnet…
          </div>
        )}
        {phase === "done" && tx && (
          <div className="sheet-done">
            <div className="confirmed">
              <span className="confirmed-title">✓ Confirmed{tx.simulated && <span className="sim"> · SIMULATED</span>}</span>
              {tx.simulated ? (
                <span className="mono small">tx {shortSig(tx.sig)} · not on devnet</span>
              ) : (
                <a className="mono small" href={txUrl(tx.sig)} target="_blank" rel="noreferrer">
                  tx {shortSig(tx.sig)} ↗
                </a>
              )}
            </div>
            <button className="primary" onClick={onClose} autoFocus>
              Done
            </button>
          </div>
        )}
        <span className="sheet-note">Demo build: no wallet is connected, so signatures are simulated and nothing moves on devnet.</span>
      </div>
    </div>
  );
}
