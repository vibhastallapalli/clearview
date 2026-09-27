import { CHAT_PATHS, chatSessionMessage, type ChatAssist, type ChatSession, type ChatState, type Party } from "@cleardock/shared";
import { json, request } from "../api";
import * as phantom from "../wallet/phantom";

// Dispute chat client (CONTRACTS.md "Dispute chat"). The session token lives in sessionStorage, per order and party.

const key = (orderId: string, as: Party) => `cleardock.chat.${orderId}.${as}`;

export function savedSession(orderId: string, as: Party): ChatSession | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(key(orderId, as)) ?? "null") as ChatSession | null;
    return s && s.expiresAt > new Date().toISOString() ? s : null;
  } catch {
    return null;
  }
}

function remember(orderId: string, s: ChatSession | null) {
  try {
    if (s) sessionStorage.setItem(key(orderId, s.as), JSON.stringify(s));
  } catch {
    // Storage unavailable: the user signs in again next time.
  }
}

export function forget(orderId: string, as: Party) {
  try {
    sessionStorage.removeItem(key(orderId, as));
  } catch {
    // nothing to forget
  }
}

const authed = (body: unknown, token: string): RequestInit => {
  const init = json(body);
  return { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } };
};

export const chatApi = {
  get: (orderId: string) => request<ChatState>(CHAT_PATHS.state(orderId)),

  /** One Phantom message signature opens a session for this party. */
  async signIn(orderId: string, as: Party): Promise<ChatSession> {
    if (!phantom.currentPublicKey()) await phantom.connect();
    const issuedAt = new Date().toISOString();
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const walletSignature = await phantom.signMessage(chatSessionMessage(orderId, as, issuedAt, nonce));
    const s = await request<ChatSession>(CHAT_PATHS.session(orderId), json({ as, issuedAt, nonce, walletSignature }));
    remember(orderId, s);
    return s;
  },

  send: (orderId: string, token: string, text: string, aiAssisted: boolean) =>
    request<ChatState>(CHAT_PATHS.messages(orderId), authed({ text, aiAssisted }, token)),

  assist: (orderId: string, token: string, draft: string) => request<ChatAssist>(CHAT_PATHS.assist(orderId), authed({ draft }, token)),
};
