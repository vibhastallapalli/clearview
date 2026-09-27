import { useEffect, useMemo, useState } from "react";
import type { ChatMessage, ChatSession, ChatState, OrderDetail, Party } from "@cleardock/shared";
import { ApiRequestError, money } from "../api";
import { useDemo } from "../escrow/DemoProvider";
import { PARTY } from "../escrow/demo";
import { short } from "../format";
import { KIND_LABEL, heldMinor, reviewedFrom, viewFor } from "../agreement/model";
import type { AgreementSession } from "../agreement/session";
import { chatApi, forget, savedSession } from "./chat";
import { COMMAND_HELP, parseCommand, type Command } from "./commands";

const POLL_MS = 2500;
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

type Item = { at: string; key: string } & ({ kind: "message"; m: ChatMessage } | { kind: "event"; text: string });

/**
 * Buyer ↔ supplier chat for a claim. Messages are free text. Commands (/offer, /accept, /reject) are parsed
 * by code and sent as the same wallet-signed offers as the buttons; signed offers appear in the thread.
 */
export function ChatPanel({ detail, session }: { detail: OrderDetail; session: AgreementSession }) {
  const { role } = useDemo();
  const orderId = detail.order.id;
  const [chat, setChat] = useState<ChatState | null>(null);
  const [me, setMe] = useState<ChatSession | null>(() => savedSession(orderId, role));
  const [text, setText] = useState("");
  const [aiText, setAiText] = useState<string | null>(null);
  const [pending, setPending] = useState<Extract<Command, { type: "offer" }> | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "warn" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setMe(savedSession(orderId, role)), [orderId, role]);
  useEffect(() => {
    let stop = false;
    const tick = () => chatApi.get(orderId).then((c) => !stop && setChat(c), () => {});
    tick();
    const t = window.setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [orderId]);

  const st = session.state;
  const held = heldMinor(detail.order.escrow);
  const v = st ? viewFor(st, role, detail.order.escrow) : null;

  // Messages and signed offers in one thread, oldest first.
  const items = useMemo<Item[]>(() => {
    const out: Item[] = (chat?.messages ?? []).map((m) => ({ kind: "message", m, at: m.at, key: m.id }));
    for (const o of st?.offers ?? []) {
      out.push({
        kind: "event",
        key: `${o.id}-made`,
        at: o.createdAt,
        text: `${PARTY[o.proposedBy].name} proposed v${o.version} · ${KIND_LABEL[o.kind]}: ${money(o.toSupplierMinor)} to supplier · ${money(o.toBuyerMinor)} to buyer (wallet-signed)`,
      });
      if (o.respondedBy && o.respondedAt && o.status !== "superseded")
        out.push({ kind: "event", key: `${o.id}-answer`, at: o.respondedAt, text: `${PARTY[o.respondedBy].name} ${o.status} v${o.version} (wallet-signed)` });
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }, [chat, st]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        forget(orderId, role);
        setMe(null);
      }
      setNote({ tone: "bad", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const signIn = () => run(async () => setMe(await chatApi.signIn(orderId, role)));

  const send = () => {
    const cmd = parseCommand(text, held);
    if (!cmd) {
      if (!me) return setNote({ tone: "warn", text: "Sign in to the chat first." });
      return run(async () => {
        setChat(await chatApi.send(orderId, me.token, text.trim(), aiText !== null && text === aiText));
        setText("");
        setAiText(null);
      });
    }
    if (cmd.type === "help") return setNote({ tone: "ok", text: COMMAND_HELP.join("\n") });
    if (cmd.type === "error") return setNote({ tone: "warn", text: cmd.message });
    if (!st || !v) return setNote({ tone: "warn", text: "The agreement isn't loaded yet." });
    if (cmd.type === "offer") {
      if (!v.canPropose) return setNote({ tone: "warn", text: v.phase === "open" && !v.youAct ? "Wait for the other party to answer the open offer." : "You can't make an offer right now." });
      return setPending(cmd); // confirm the exact split before the wallet signs it
    }
    const cur = v.current;
    if (!v.canRespond || !cur) return setNote({ tone: "warn", text: "There is no open offer for you to answer." });
    return run(async () => {
      await session.respond(role, reviewedFrom(st, cur), cmd.type === "accept");
      setText("");
    });
  };

  const confirmOffer = () =>
    pending &&
    run(async () => {
      await session.propose(role, pending.kind, pending.toSupplierMinor, pending.toBuyerMinor);
      setPending(null);
      setText("");
    });

  const assist = () =>
    me &&
    run(async () => {
      const r = await chatApi.assist(orderId, me.token, text);
      if (r.used) {
        setText(r.text);
        setAiText(r.text);
        setNote({ tone: "ok", text: `Suggested by ${r.model}. Edit it if needed, then send. It is marked as AI-assisted if you send it unchanged.` });
      } else setNote({ tone: "warn", text: r.note ?? "No suggestion." });
    });

  const isCommand = text.trim().startsWith("/");
  return (
    <section className="card">
      <div className="row between wrap">
        <span className="eyebrow">Dispute chat</span>
        {me ? (
          <span className="pill ok pill-xs">
            Signed in as {role} · {short(me.wallet)}
          </span>
        ) : (
          <button className="secondary sm" disabled={busy} onClick={signIn}>
            Sign in to chat as {role} (one Phantom message)
          </button>
        )}
      </div>
      <p className="note">
        Talk it through here. Messages move no money. To make or answer an offer, type a command (/help); your wallet signs it exactly
        like the buttons above.
      </p>

      <div className="chat-thread" aria-live="polite">
        {items.length === 0 && <p className="caption-plain">No messages yet.</p>}
        {items.map((it) =>
          it.kind === "event" ? (
            <p key={it.key} className="chat-event">
              {time(it.at)} · {it.text}
            </p>
          ) : (
            <div key={it.key} className={it.m.from === role ? "chat-msg mine" : "chat-msg"}>
              <span className="caption-plain">
                {PARTY[it.m.from].name} ({it.m.from}) · wallet {short(it.m.wallet)} · {time(it.m.at)}
                {it.m.aiAssisted && " · AI-assisted wording"}
              </span>
              <span className="chat-text">{it.m.text}</span>
            </div>
          ),
        )}
      </div>

      {pending && (
        <div className="notice suggest stack-8">
          <b>
            Sign offer: {KIND_LABEL[pending.kind]} · {money(pending.toSupplierMinor)} to supplier · {money(pending.toBuyerMinor)} back to buyer
          </b>
          <span className="note">Your wallet signs this exact split. It moves no money until both of you sign the settlement.</span>
          <div className="row wrap gap-6">
            <button className="primary" disabled={busy || session.busy} onClick={confirmOffer}>
              {session.busy ? "Waiting for Phantom…" : "Sign and send offer"}
            </button>
            <button className="secondary sm" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="chat-compose">
        <textarea
          value={text}
          rows={2}
          maxLength={2000}
          placeholder={me ? "Write a message, or /offer 5.00 · /accept · /reject · /help" : "Sign in to send messages. Commands work with your wallet."}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), text.trim() && send())}
        />
        <div className="row wrap gap-6">
          <button className="primary sm" disabled={busy || !text.trim()} onClick={send}>
            {isCommand ? "Run command" : "Send"}
          </button>
          <button className="secondary sm" disabled={busy || !me || !text.trim() || isCommand} onClick={assist} title="An AI rewords your draft. It can't add or change numbers.">
            Help me word this (AI)
          </button>
        </div>
      </div>
      {(note || session.notice) && (
        <p className={(note ?? session.notice)!.tone === "bad" ? "error" : (note ?? session.notice)!.tone === "ok" ? "ok-text chat-help" : "notice warn"}>
          {(note ?? session.notice)!.text}
        </p>
      )}
    </section>
  );
}
