import { useEffect, useReducer, useRef } from "react";
import { liveAgreementApi, type AgreementApi } from "./client";
import { AgreementSession } from "./session";

const POLL_MS = 2000;
const UNAVAILABLE_POLL_MS = 15000;

/** The server's agreement for an order, polled so the other device's moves show up without a reload. */
export function useAgreement(orderId: string, enabled: boolean, api: AgreementApi = liveAgreementApi): AgreementSession {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const ref = useRef<AgreementSession | null>(null);
  if (!ref.current || ref.current.orderId !== orderId) ref.current = new AgreementSession(api, orderId, rerender);
  const session = ref.current;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      await session.refresh();
      if (!stopped) timer = window.setTimeout(tick, session.status === "unavailable" ? UNAVAILABLE_POLL_MS : POLL_MS);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [session, enabled]);

  return session;
}
