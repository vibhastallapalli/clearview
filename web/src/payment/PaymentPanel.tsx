import { useEffect, useState } from "react";
import type { OrderDetail } from "@cleardock/shared";
import { api, money } from "../api";
import { short } from "../format";
import * as phantom from "../wallet/phantom";

const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 3000;
const POLL_TRIES = 40; // ~2 min; the blockhash expires sooner, and then the server reports failed.

type Step = "connecting" | "preparing" | "signing" | "submitting" | "confirming";
const STEP_TEXT: Record<Step, string> = {
  connecting: "Waiting for Phantom to connect…",
  preparing: "Preparing the transfer…",
  signing: "Approve the transfer in Phantom…",
  submitting: "Sending the signed transfer to devnet…",
  confirming: "Submitted. Waiting for devnet to confirm…",
};

/**
 * Approval + devnet payment card on the order screen.
 * Flow: approve → POST /payments → POST /payments/transaction {payer} → Phantom signs only →
 * POST /payments/submit {transaction} → POST /payments/confirm {signature} until confirmed or failed.
 * Owned by the Solana/payments workstream; keep wallet code inside web/src/payment/ and web/src/wallet/.
 */
export function PaymentPanel({
  detail,
  busy,
  run,
}: {
  detail: OrderDetail;
  busy: boolean;
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const { order, supplier } = detail;
  const c = order.comparison;
  const payment = order.payment;

  const [wallet, setWallet] = useState<string | null>(phantom.currentPublicKey());
  const [step, setStep] = useState<Step | null>(null);
  const [walletError, setWalletError] = useState<{ code: phantom.WalletErrorCode | "server"; message: string } | null>(null);
  const hasPhantom = !!phantom.getPhantom();

  useEffect(() => {
    phantom.connect({ onlyIfTrusted: true }).then(setWallet, () => {}); // silent reconnect if already trusted
    return phantom.onAccountChange(setWallet);
  }, []);

  const working = busy || step !== null;
  const canPay = order.status === "approved" || payment?.status === "awaiting_signature" || payment?.status === "failed";
  const pending = !!payment?.signature && (payment.status === "submitted" || payment.status === "unknown");

  async function connectWallet() {
    setWalletError(null);
    setStep("connecting");
    try {
      setWallet(await phantom.connect());
    } catch (e) {
      setWalletError({ code: e instanceof phantom.WalletError ? e.code : "failed", message: (e as Error).message });
    } finally {
      setStep(null);
    }
  }

  async function pollConfirm(signature: string, latest: OrderDetail) {
    setStep("confirming");
    for (let i = 0; i < POLL_TRIES; i++) {
      const s = latest.order.payment?.status;
      if (s !== "submitted" && s !== "unknown") break;
      await sleep(POLL_MS);
      latest = await api.confirmPayment(order.id, signature);
    }
    return latest;
  }

  async function pay() {
    setWalletError(null);
    let latest: OrderDetail | undefined;
    try {
      setStep("connecting");
      const payer = wallet ?? (await phantom.connect());
      setWallet(payer);

      setStep("preparing");
      latest = await api.preparePayment(order.id); // idempotent: returns the existing payment for this approval
      const { transaction } = await api.paymentTransaction(order.id, payer);

      setStep("signing");
      const signed = await phantom.signSerialized(transaction);

      setStep("submitting");
      latest = await api.submitPayment(order.id, signed);
      const signature = latest.order.payment?.signature;
      if (signature) latest = await pollConfirm(signature, latest);
    } catch (e) {
      setWalletError({ code: e instanceof phantom.WalletError ? e.code : "server", message: (e as Error).message });
    } finally {
      setStep(null);
    }
    return latest;
  }

  async function recheck() {
    setWalletError(null);
    try {
      return await pollConfirm(payment!.signature!, await api.confirmPayment(order.id, payment!.signature!));
    } catch (e) {
      setWalletError({ code: "server", message: (e as Error).message });
    } finally {
      setStep(null);
    }
  }

  return (
    <div className="card">
      <h2>Approval and payment</h2>
      {order.status === "ready_for_review" && c && (
        <button
          className="primary"
          disabled={working}
          onClick={() => run("approve", () => api.approve(order.id, order.evidenceRevision))}
        >
          Approve {money(c.billedTotalMinor)} to {short(supplier.walletAddress)}
        </button>
      )}
      {order.status === "discrepancy" && (
        <p className="muted">Resolve the discrepancy first: fix the delivery and recapture, or (Phase 2) file a claim.</p>
      )}
      {order.approval && (
        <p className="small">
          Approved {money(order.approval.amountMinor)} → {short(order.approval.recipient)} at rev{" "}
          {order.approval.evidenceRevision}
        </p>
      )}

      {(canPay || pending) && (
        <div className="small">
          {!hasPhantom ? (
            <p className="warn-text">
              No wallet: Phantom isn't installed in this browser.{" "}
              <a href={phantom.INSTALL_URL} target="_blank" rel="noreferrer">
                Install Phantom
              </a>
              , then reload.
            </p>
          ) : wallet ? (
            <p>
              Paying from <span className="mono">{short(wallet)}</span> (Phantom, devnet)
            </p>
          ) : (
            <button disabled={working} onClick={connectWallet}>
              Connect Phantom
            </button>
          )}
          <p className="muted">{phantom.DEVNET_HINT}</p>
        </div>
      )}

      {canPay && hasPhantom && (
        <button className="primary" disabled={working} onClick={() => run("pay", pay)}>
          {step
            ? STEP_TEXT[step]
            : payment?.status === "failed"
              ? "Try the payment again"
              : `Pay ${money(order.approval?.amountMinor)} with Phantom`}
        </button>
      )}

      {walletError && (
        <p className="error">
          {walletError.code === "rejected" ? "Wallet rejected: " : walletError.code === "missing" ? "No wallet: " : ""}
          {walletError.message}
        </p>
      )}

      {payment && (
        <div className="small">
          <p>
            Payment <strong>{payment.status.replace("_", " ")}</strong> · {money(payment.amountMinor)} · CDT devnet test token
          </p>
          {payment.status === "submitted" && <p>Submitted to devnet. Waiting for confirmation…</p>}
          {payment.status === "confirmed" && <p className="ok-text">Confirmed on Solana devnet. The supplier has been paid.</p>}
          {(payment.status === "failed" || payment.status === "unknown") && payment.error && (
            <p className={payment.status === "failed" ? "error" : "warn-text"}>{payment.error}</p>
          )}
          {payment.signature && (
            <p>
              <a href={explorerTx(payment.signature)} target="_blank" rel="noreferrer">
                View transaction on Solana Explorer (devnet) ↗
              </a>
            </p>
          )}
          {pending && (
            <button disabled={working} onClick={() => run("recheck", recheck)}>
              {step === "confirming" ? STEP_TEXT.confirming : "Re-check on devnet"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
