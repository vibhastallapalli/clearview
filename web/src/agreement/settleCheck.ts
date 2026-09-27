import { Connection } from "@solana/web3.js";
import { api } from "../api";
import type { PendingSettle } from "./model";

/**
 * landed: devnet has the transaction (it may still have failed; the server's escrow check decides).
 * expired: not found and devnet is past its last valid block height, so it can never land. Safe to rebuild.
 * pending: not found yet and it could still land. Don't sign another one.
 */
export type PendingOutcome = "landed" | "expired" | "pending";

export async function checkPendingSettle(p: PendingSettle): Promise<PendingOutcome> {
  const config = await api.config();
  const connection = new Connection(config.rpcUrl, "confirmed");
  const status = await connection.getSignatureStatus(p.signature, { searchTransactionHistory: true });
  if (status.value) return "landed";
  const height = await connection.getBlockHeight("confirmed");
  if (height <= p.lastValidBlockHeight) return "pending";
  // Past expiry: look once more, in case it landed between the two calls.
  const again = await connection.getSignatureStatus(p.signature, { searchTransactionHistory: true });
  return again.value ? "landed" : "expired";
}
