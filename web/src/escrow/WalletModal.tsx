import { short } from "../format";
import { shortSig, txUrl, type Tx } from "./demo";

export interface ModalState {
  title: string;
  rows: [string, string][];
  /** true = real devnet transaction signed in Phantom; false = simulated off-chain step. */
  real: boolean;
  phase: "ask" | "sending" | "switch" | "done" | "error" | "unknown";
  status?: string;
  supplier?: string;
  note?: string;
  error?: string;
  tx?: Tx;
}

export function WalletModal({
  state,
  onConfirm,
  onSupplierReady,
  onClose,
}: {
  state: ModalState;
  onConfirm: () => void;
  onSupplierReady: () => void;
  onClose: () => void;
}) {
  const { title, rows, real, phase, tx } = state;
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="wallet-title">
      <div className="sheet">
        <div className="row between">
          <span className="sheet-kicker">{real ? "Phantom request" : "Wallet request"}</span>
          <span className="row gap-6">
            {!real && <span className="sim">SIMULATED</span>}
            <span className="pill info">devnet</span>
          </span>
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
              {real ? "Sign in Phantom" : "Sign & send"}
            </button>
          </div>
        )}
        {phase === "sending" && (
          <div className="busy" aria-live="polite">
            <span className="spinner" aria-hidden="true" /> {state.status ?? "Confirming on devnet…"}
          </div>
        )}
        {phase === "switch" && state.supplier && (
          <div className="stack-8" aria-live="polite">
            <p className="notice">
              ✓ Buyer signed. Switch Phantom to the Supplier account ({short(state.supplier)}), then press the button. Nothing
              is sent until both have signed. The transaction expires about a minute after the buyer signs.
            </p>
            {state.note && <p className="warn-text">{state.note}</p>}
            <div className="sheet-actions">
              <button className="secondary" onClick={onClose}>
                Cancel (nothing sent)
              </button>
              <button className="primary" onClick={onSupplierReady} autoFocus>
                Supplier: sign in Phantom
              </button>
            </div>
          </div>
        )}
        {phase === "error" && (
          <div className="stack-8">
            <p className="error">{state.error}</p>
            <div className="sheet-actions">
              <button className="secondary" onClick={onClose}>
                Close
              </button>
              <button className="primary" onClick={onConfirm}>
                Try again
              </button>
            </div>
          </div>
        )}
        {phase === "unknown" && tx && (
          <div className="stack-8" aria-live="polite">
            <p className="notice warn">
              Sent, but the outcome isn't known yet. Don't sign again: re-check it from the order page. Funds may or may not have
              moved until it is confirmed.
            </p>
            <p className="warn-text">{state.error}</p>
            <a className="mono small" href={txUrl(tx.sig)} target="_blank" rel="noreferrer">
              tx {shortSig(tx.sig)} ↗
            </a>
            <div className="sheet-actions">
              <button className="primary" onClick={onClose} autoFocus>
                Close
              </button>
            </div>
          </div>
        )}
        {phase === "done" && tx && (
          <div className="sheet-done">
            <div className="confirmed">
              <span className="confirmed-title">
                ✓ {tx.simulated ? "Done" : "Confirmed on devnet and verified by ClearDock"}
                {tx.simulated && <span className="sim"> · SIMULATED</span>}
              </span>
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
        <span className="sheet-note">
          {real
            ? "Real devnet transaction to the ClearDock escrow program. CDT is a devnet test token, not real money."
            : "Off-chain step: simulated. Nothing is sent to devnet and no money moves."}
        </span>
      </div>
    </div>
  );
}
