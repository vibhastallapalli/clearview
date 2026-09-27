import { createHash, randomBytes } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import {
  chatSessionMessage,
  numbersPreserved,
  type ApiError,
  type ChatAssist,
  type ChatMessage,
  type ChatSession,
  type ChatState,
  type Order,
  type Party,
} from "@cleardock/shared";
import { db, id, save, type ChatRecord } from "./store.ts";
import { HttpError } from "./solana/payments.ts";
import { signedBy } from "./agreement.ts";
import { geminiEnabled, geminiJson } from "./ai/gemini.ts";

// Dispute chat (CONTRACTS.md "Dispute chat"). Free text only: offers stay in the wallet-signed agreement API.

const SESSION_HOURS = 12;
const SIGN_IN_WINDOW_MS = 10 * 60 * 1000;
const MAX_TEXT = 2000;
const CHAT_MODEL = () => process.env.GEMINI_CHAT_MODEL || "gemini-3.1-flash-lite";

const now = () => new Date().toISOString();
const bad = (msg: string) => new HttpError(400, "bad_request", msg);
const unauthorized = (msg: string) => new HttpError(401, "unauthorized", msg);
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

function getOrder(orderId: string): Order {
  const order = db.orders.find((o) => o.id === orderId);
  if (!order) throw new HttpError(404, "not_found", `Order ${orderId} not found`);
  return order;
}

/** The party's wallet: from the verified escrow once linked, else from server config (as in order terms). */
function partyWallet(order: Order, as: Party): string {
  if (order.escrow) return as === "buyer" ? order.escrow.buyer : order.escrow.supplier;
  const supplier = db.suppliers.find((s) => s.id === order.supplierId);
  const wallet = as === "buyer" ? process.env.DEMO_BUYER_WALLET?.trim() : supplier?.verified ? supplier.walletAddress : undefined;
  if (!wallet) throw new HttpError(409, "conflict", `No ${as} wallet is configured for this order.`);
  return wallet;
}

function record(orderId: string): ChatRecord {
  let rec = db.chats.find((c) => c.orderId === orderId);
  if (!rec) {
    rec = { orderId, messages: [], sessions: [], nonces: [] };
    db.chats.push(rec);
  }
  return rec;
}

const view = (rec: ChatRecord): ChatState => ({ orderId: rec.orderId, messages: rec.messages });

/** The signed-in party for this request, from `Authorization: Bearer <token>`. */
function sessionOf(req: Request, rec: ChatRecord) {
  const token = /^Bearer (\S+)$/.exec(req.header("authorization") ?? "")?.[1];
  const s = token && rec.sessions.find((x) => x.tokenHash === tokenHash(token));
  if (!s || s.expiresAt < now()) throw unauthorized("Sign in to the chat with your wallet first (the session is missing or expired).");
  return s;
}

function signIn(order: Order, body: Record<string, unknown>): ChatSession {
  const as = body.as;
  if (as !== "buyer" && as !== "supplier") throw bad('as must be "buyer" or "supplier"');
  const issuedAt = typeof body.issuedAt === "string" ? body.issuedAt : "";
  const nonce = typeof body.nonce === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.nonce) ? body.nonce : "";
  if (!nonce) throw bad("nonce must be 8 to 64 letters, digits, - or _");
  const age = Date.now() - Date.parse(issuedAt);
  if (!(age >= -60_000 && age <= SIGN_IN_WINDOW_MS)) throw unauthorized("The sign-in message is too old (or from the future). Sign in again.");
  const wallet = partyWallet(order, as);
  if (!signedBy(wallet, chatSessionMessage(order.id, as, issuedAt, nonce), body.walletSignature))
    throw unauthorized(`Chat sign-in must be signed by the ${as} wallet ${wallet}.`);
  const rec = record(order.id);
  if (rec.nonces.includes(nonce)) throw unauthorized("That sign-in was already used. Sign in again.");
  const token = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
  rec.nonces.push(nonce);
  rec.sessions = rec.sessions.filter((s) => s.expiresAt > now());
  rec.sessions.push({ tokenHash: tokenHash(token), as, wallet, expiresAt });
  save();
  return { token, as, wallet, expiresAt };
}

function post(order: Order, req: Request): ChatState {
  const rec = record(order.id);
  const s = sessionOf(req, rec);
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text || text.length > MAX_TEXT) throw bad(`text must be 1 to ${MAX_TEXT} characters`);
  if (text.startsWith("/")) throw bad("Commands (/offer, /accept, /reject) are signed offers, not chat messages. The chat box sends them through the agreement.");
  const msg: ChatMessage = { id: id("msg"), orderId: order.id, from: s.as, wallet: s.wallet, text, at: now(), aiAssisted: req.body?.aiAssisted === true };
  rec.messages.push(msg);
  save();
  return view(rec);
}

const ASSIST_PROMPT = (as: Party, draft: string) => `You help a ${as} in a delivery dispute word a chat message to the ${as === "buyer" ? "supplier" : "buyer"}.
Rewrite the draft below to be clear, calm and professional. Keep the sender's meaning and stance.
Rules: keep every number exactly as written; do not add any number, amount, percentage, date or deadline;
do not add promises, threats, legal claims or facts that are not in the draft; do not write commands starting with "/".
Return JSON {"text": "..."} with only the rewritten message.

Draft:
${draft}`;

async function assist(order: Order, req: Request): Promise<ChatAssist> {
  const rec = record(order.id);
  const s = sessionOf(req, rec);
  const draft = typeof req.body?.draft === "string" ? req.body.draft.trim() : "";
  if (!draft || draft.length > MAX_TEXT) throw bad(`draft must be 1 to ${MAX_TEXT} characters`);
  if (!geminiEnabled()) throw new HttpError(501, "not_implemented", "AI wording help is off: GEMINI_API_KEY is not set on this server.");
  const model = CHAT_MODEL();
  const out = (await geminiJson({
    prompt: ASSIST_PROMPT(s.as, draft),
    schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    model,
  }).catch((err: Error) => {
    throw new HttpError(502, "upstream_error", `AI wording help failed: ${err.message}`);
  })) as { text?: unknown };
  const text = typeof out.text === "string" ? out.text.trim().replace(/^\/+/gm, "") : "";
  if (!text || text.length > MAX_TEXT) return { text: draft, model, used: false, note: "The AI returned nothing usable, so your draft is unchanged." };
  if (!numbersPreserved(draft, text)) return { text: draft, model, used: false, note: "The AI's version changed or added numbers, so it was discarded. Your draft is unchanged." };
  return { text, model, used: true, note: null };
}

// ---------- routes ----------

export const chatRouter = Router();

const route =
  (fn: (order: Order, req: Request) => unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => fn(getOrder(req.params.id), req))
      .then((out) => res.json(out))
      .catch((err) => {
        if (err instanceof HttpError) res.status(err.status).json({ error: err.message, code: err.code } satisfies ApiError);
        else next(err);
      });
  };

chatRouter.get("/api/orders/:id/chat", route((order) => view(record(order.id))));
chatRouter.post("/api/orders/:id/chat/session", route((order, req) => signIn(order, req.body ?? {})));
chatRouter.post("/api/orders/:id/chat/messages", route(post));
chatRouter.post("/api/orders/:id/chat/assist", route(assist));
