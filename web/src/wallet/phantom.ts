import { PublicKey, Transaction } from "@solana/web3.js";

/**
 * Phantom, via the injected window.phantom.solana provider. No wallet-adapter:
 * ClearDock only needs connect, the current key, account changes,
 * signTransaction and signMessage (agreement actions).
 *
 * Devnet only. Phantom doesn't tell a dApp which network it is set to, so the
 * UI must tell the user to switch Phantom to devnet (DEVNET_HINT). Every
 * transaction ClearDock asks Phantom to sign carries a devnet blockhash.
 *
 * Sign only: never call signAndSendTransaction. The server broadcasts what the
 * wallet signed (POST /payments/submit) so it can prove when a transaction expires.
 */

export const INSTALL_URL = "https://phantom.app/download";
export const DEVNET_HINT = "In Phantom: Settings → Developer Settings → Testnet Mode on, network Solana Devnet.";

interface PhantomProvider {
  isPhantom?: boolean;
  isConnected: boolean;
  publicKey: PublicKey | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  signTransaction<T extends Transaction>(tx: T): Promise<T>;
  signMessage(message: Uint8Array, display?: "utf8"): Promise<{ signature: Uint8Array }>;
  on(event: "connect" | "disconnect" | "accountChanged", handler: (key?: PublicKey | null) => void): void;
  removeListener(event: "connect" | "disconnect" | "accountChanged", handler: (key?: PublicKey | null) => void): void;
}

declare global {
  interface Window {
    phantom?: { solana?: PhantomProvider };
  }
}

export type WalletErrorCode = "missing" | "rejected" | "failed";

export class WalletError extends Error {
  constructor(public code: WalletErrorCode, message: string) {
    super(message);
  }
}

export function getPhantom(): PhantomProvider | null {
  const provider = typeof window === "undefined" ? undefined : window.phantom?.solana;
  return provider?.isPhantom ? provider : null;
}

function requirePhantom(): PhantomProvider {
  const provider = getPhantom();
  if (!provider) throw new WalletError("missing", `Phantom wallet not found. Install it from ${INSTALL_URL}, then reload this page.`);
  return provider;
}

// Phantom rejects with { code: 4001 } when the user closes or declines the popup.
function walletError(err: unknown, action: string): WalletError {
  if (err instanceof WalletError) return err;
  const e = err as { code?: number; message?: string };
  if (e?.code === 4001) return new WalletError("rejected", `You declined the ${action} in Phantom.`);
  return new WalletError("failed", `Phantom couldn't ${action}: ${e?.message ?? String(err)}`);
}

/** Opens Phantom's connect prompt (or connects silently with onlyIfTrusted). Returns the base58 address. */
export async function connect(opts?: { onlyIfTrusted?: boolean }): Promise<string> {
  const provider = requirePhantom();
  try {
    return (await provider.connect(opts)).publicKey.toBase58();
  } catch (err) {
    throw walletError(err, "connection request");
  }
}

export async function disconnect(): Promise<void> {
  await getPhantom()?.disconnect();
}

export const currentPublicKey = (): string | null => getPhantom()?.publicKey?.toBase58() ?? null;

/**
 * Calls back with the new address when the user switches accounts in Phantom,
 * or null on disconnect (or a switch to an account this site isn't connected to).
 * Returns an unsubscribe function.
 */
export function onAccountChange(handler: (address: string | null) => void): () => void {
  const provider = getPhantom();
  if (!provider) return () => {};
  const changed = (key?: PublicKey | null) => handler(key ? key.toBase58() : null);
  const disconnected = () => handler(null);
  provider.on("accountChanged", changed);
  provider.on("disconnect", disconnected);
  return () => {
    provider.removeListener("accountChanged", changed);
    provider.removeListener("disconnect", disconnected);
  };
}

/** Phantom signs only; nothing is sent. The caller gets the signed Transaction back. */
export async function signTransaction(tx: Transaction): Promise<Transaction> {
  const provider = requirePhantom();
  if (!provider.publicKey) throw new WalletError("failed", "Connect Phantom first.");
  try {
    return await provider.signTransaction(tx);
  } catch (err) {
    throw walletError(err, "signature request");
  }
}

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));

/** For server-built transactions: base64 unsigned in, base64 signed out (for POST .../submit). */
export async function signSerialized(unsignedBase64: string): Promise<string> {
  const signed = await signTransaction(Transaction.from(fromBase64(unsignedBase64)));
  return toBase64(signed.serialize());
}

/** Signs text, e.g. agreementMessage() for an agreement action. Moves nothing. Returns the base64 ed25519 signature. */
export async function signMessage(text: string): Promise<string> {
  const provider = requirePhantom();
  if (!provider.publicKey) throw new WalletError("failed", "Connect Phantom first.");
  try {
    const { signature } = await provider.signMessage(new TextEncoder().encode(text), "utf8");
    return toBase64(signature);
  } catch (err) {
    throw walletError(err, "message signature");
  }
}
