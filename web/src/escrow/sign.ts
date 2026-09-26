import type { SignRequest, Tx } from "./demo";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export const simulatedSignature = () => Array.from({ length: 88 }, () => B58[Math.floor(Math.random() * 58)]).join("");

/**
 * The single swap point for real signing. Today it simulates a wallet: no
 * wallet is connected and nothing reaches devnet, so every Tx it returns is
 * flagged `simulated` and the UI labels it. Replace the body with Phantom
 * (wallet adapter) + the escrow program (solana/escrow) once both are wired.
 */
export async function signAndSend(_request: SignRequest): Promise<Tx> {
  await new Promise((resolve) => setTimeout(resolve, 1100));
  return { sig: simulatedSignature(), simulated: true };
}
