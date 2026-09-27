import type { EscrowRecord } from "@cleardock/shared";
import { short } from "../format";
import * as phantom from "../wallet/phantom";
import { agreementMessage, type AgreementWrite, type Party } from "./contract";

/** Signs one agreement write and returns the base64 wallet signature. Throws if it can't (nothing is sent then). */
export type Signer = (orderId: string, write: AgreementWrite) => Promise<string>;

/** The wallet the server will check a party's writes against: the one on the verified escrow. */
export const walletFor = (escrow: EscrowRecord | null | undefined, as: Party): string | null =>
  escrow ? (as === "buyer" ? escrow.buyer : escrow.supplier) : null;

/** Which party (if any) a connected wallet is on this escrow. */
export function partyOf(escrow: EscrowRecord | null | undefined, wallet: string | null): Party | null {
  if (!escrow || !wallet) return null;
  if (wallet === escrow.buyer) return "buyer";
  if (wallet === escrow.supplier) return "supplier";
  return null;
}

export class WrongWalletError extends Error {}

/**
 * Phantom signMessage over agreementMessage(orderId, write), after checking Phantom is on the wallet the
 * server expects for write.as. The message says it moves no funds; it proves which wallet acted.
 */
export function phantomSigner(getEscrow: () => EscrowRecord | null | undefined): Signer {
  return async (orderId, write) => {
    const expected = walletFor(getEscrow(), write.as);
    if (!expected) throw new WrongWalletError("This order has no verified escrow yet, so there's no wallet to sign with.");
    const connected = phantom.currentPublicKey() ?? (await phantom.connect());
    if (connected !== expected)
      throw new WrongWalletError(
        `Phantom is on ${short(connected)}. Switch Phantom to the ${write.as} wallet ${short(expected)}, then try again. Nothing was sent.`,
      );
    return phantom.signMessage(agreementMessage(orderId, write));
  };
}
