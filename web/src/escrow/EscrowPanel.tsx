import type { Order, OrderDetail } from "@cleardock/shared";
import { money } from "../api";
import { short } from "../format";

// Mirrors Contracts v2 `EscrowRecord`; switch to the @cleardock/shared import once it merges.
interface EscrowRecord {
  programId: string;
  escrowAddress: string;
  buyer: string;
  supplier: string;
  mint: string;
  totalMinor: number;
  releasedMinor: number;
  claimedMinor: number;
  refundedMinor: number;
  status: "funded" | "claimed" | "settlement_proposed" | "settled" | "released";
  events: { action: string; signature: string; at: string }[];
}

// Words and an icon for every status, never color alone.
const STATUS: Record<EscrowRecord["status"], { label: string; icon: string; tone: string }> = {
  funded: { label: "Funds held in escrow", icon: "◆", tone: "info" },
  claimed: { label: "Claim open: disputed amount held", icon: "!", tone: "warn" },
  settlement_proposed: { label: "Settlement awaiting both signatures", icon: "✎", tone: "info" },
  settled: { label: "Settled by buyer and supplier", icon: "✔", tone: "ok" },
  released: { label: "Released to supplier", icon: "✔", tone: "ok" },
};

const ACTION: Record<string, string> = {
  fund: "Buyer funded the escrow",
  accept_all: "Buyer accepted every line",
  claim: "Buyer claimed disputed lines",
  settle: "Settlement signed by buyer and supplier",
};

const explorer = (kind: "tx" | "address", id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

export function EscrowPanel({ detail }: { detail: OrderDetail }) {
  const escrow = (detail.order as Order & { escrow?: EscrowRecord | null }).escrow;
  if (!escrow) return null;

  const status = STATUS[escrow.status];
  const heldMinor = escrow.totalMinor - escrow.releasedMinor - escrow.refundedMinor;

  return (
    <div className="card">
      <div className="row between">
        <h2>Escrow (devnet)</h2>
        <span className={`pill ${status.tone}`}>
          <span aria-hidden>{status.icon}</span> {status.label}
        </span>
      </div>

      <table className="table">
        <tbody>
          <tr>
            <td>Order total locked</td>
            <td className="num">{money(escrow.totalMinor)}</td>
          </tr>
          <tr>
            <td>Paid to supplier {short(escrow.supplier)}</td>
            <td className="num">{money(escrow.releasedMinor)}</td>
          </tr>
          <tr>
            <td>Still held (disputed)</td>
            <td className="num">{money(heldMinor)}</td>
          </tr>
          <tr>
            <td>Refunded to buyer {short(escrow.buyer)}</td>
            <td className="num">{money(escrow.refundedMinor)}</td>
          </tr>
        </tbody>
      </table>

      {escrow.claimedMinor > 0 && (
        <p className="small">Buyer disputed {money(escrow.claimedMinor)}. Held money moves only when both parties sign the same settlement.</p>
      )}

      <ul className="small">
        {escrow.events.map((e) => (
          <li key={e.signature}>
            {ACTION[e.action] ?? e.action} · {new Date(e.at).toLocaleTimeString()} ·{" "}
            <a href={explorer("tx", e.signature)} target="_blank" rel="noreferrer">
              view on Explorer
            </a>
          </li>
        ))}
      </ul>

      <p className="small muted">
        Amounts read from the escrow account on-chain ·{" "}
        <a href={explorer("address", escrow.escrowAddress)} target="_blank" rel="noreferrer">
          {short(escrow.escrowAddress)}
        </a>{" "}
        · CDT devnet test token, no real funds
      </p>
    </div>
  );
}
