import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { OrderDetail } from "@cleardock/shared";
import { api } from "../api";
import { PARTY, STALE_EVIDENCE, initialState, scanned, type DemoState, type OrderLike, type Role, type SignRequest, type Tx } from "./demo";
import { SentTransactionError, signAndSend } from "./sign";
import { WalletModal, type ModalState } from "./WalletModal";

// v2: settlement offers moved to the server; v1 kept them (and SIMULATED results) in the browser.
const STORAGE_KEY = "securoserv.demo.v2";

interface Stored {
  role: Role;
  orders: Record<string, DemoState>;
}

function load(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Stored;
      // A scan interrupted by a reload finishes on load instead of spinning forever.
      for (const [id, st] of Object.entries(s.orders)) if (st.step === "scanning") s.orders[id] = { ...st, ...scanned(st) };
      return s;
    }
  } catch {
    // Private mode or corrupt data: start fresh.
  }
  return { role: "buyer", orders: {} };
}

interface DemoContext {
  role: Role;
  setRole: (role: Role) => void;
  ensure: (orderId: string, detail: OrderLike | null) => void;
  peek: (orderId: string) => DemoState | null;
  states: Record<string, DemoState>;
  update: (orderId: string, patch: Partial<DemoState> | ((st: DemoState) => Partial<DemoState>)) => void;
  scan: (orderId: string) => void;
  sign: (orderId: string, request: SignRequest, detail: OrderDetail) => void;
  resetAll: () => void;
}

const Ctx = createContext<DemoContext | null>(null);

export function DemoProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<Stored>(load);
  const [modal, setModal] = useState<(ModalState & { orderId: string; request: SignRequest; detail: OrderDetail }) | null>(null);
  const supplierReady = useRef<(() => void) | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
      // Storage unavailable: the demo still works for this session.
    }
  }, [store]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const update: DemoContext["update"] = useCallback((orderId, patch) => {
    setStore((s) => {
      const st = s.orders[orderId];
      if (!st) return s;
      const next = typeof patch === "function" ? patch(st) : patch;
      return { ...s, orders: { ...s.orders, [orderId]: { ...st, ...next } } };
    });
  }, []);

  const ensure: DemoContext["ensure"] = useCallback((orderId, detail) => {
    setStore((s) => (s.orders[orderId] ? s : { ...s, orders: { ...s.orders, [orderId]: initialState(detail) } }));
  }, []);

  const scan: DemoContext["scan"] = useCallback(
    (orderId) => {
      update(orderId, { step: "scanning" });
      timers.current.push(window.setTimeout(() => update(orderId, (st) => scanned(st)), 2400));
    },
    [update],
  );

  const sign: DemoContext["sign"] = useCallback(
    (orderId, request, detail) => {
      const me = PARTY[store.role];
      const signer: [string, string] = !request.chain
        ? ["Signer", `${me.name} · ${me.wallet}`]
        : request.chain.action === "settle"
          ? ["Signers", "Buyer, then supplier, in Phantom"]
          : ["Signer", "Buyer wallet in Phantom"];
      setModal({ orderId, request, detail, title: request.title, rows: [...request.rows, signer], real: !!request.chain, phase: "ask" });
    },
    [store.role],
  );

  const confirm = async () => {
    if (!modal) return;
    const { orderId, request, detail } = modal;
    setModal({ ...modal, phase: "sending", status: undefined, error: undefined });
    try {
      // The station may have rescanned while this sheet was open: never sign amounts from older evidence.
      if (request.evidence) {
        const { order } = await api.order(orderId);
        if (order.latestScanId !== request.evidence.scanId || order.evidenceRevision !== request.evidence.revision)
          throw new Error(STALE_EVIDENCE);
      }
      await request.precheck?.();
      const tx: Tx = await signAndSend(request, detail, {
        status: (status) => setModal((m) => (m ? { ...m, phase: "sending", status } : m)),
        waitForSupplier: (supplier, note) =>
          new Promise<void>((resolve) => {
            supplierReady.current = resolve;
            setModal((m) => (m ? { ...m, phase: "switch", supplier, note } : m));
          }),
        beforeSend: request.beforeSend,
      });
      update(orderId, (st) => request.apply(tx, st));
      let note: string | undefined;
      try {
        await request.confirmed?.(tx);
      } catch (err) {
        note = `Confirmed on devnet, but ClearDock couldn't update the agreement: ${(err as Error).message} Use the order page to re-check.`;
      }
      setModal((m) => (m ? { ...m, phase: "done", tx, note } : m));
    } catch (err) {
      if (err instanceof SentTransactionError) {
        request.sendFailed?.(err.signature, err.outcome, err.message);
        // Sent but unresolved: never offer to sign again from here; the page offers a re-check.
        if (err.outcome === "unknown") {
          setModal((m) => (m ? { ...m, phase: "unknown", error: err.message, tx: { sig: err.signature, simulated: false } } : m));
          return;
        }
      }
      setModal((m) => (m ? { ...m, phase: "error", error: (err as Error).message } : m));
    }
  };

  const value: DemoContext = {
    role: store.role,
    setRole: (role) => setStore((s) => ({ ...s, role })),
    ensure,
    peek: (orderId) => store.orders[orderId] ?? null,
    states: store.orders,
    update,
    scan,
    sign,
    resetAll: () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
      setModal(null);
      setStore((s) => ({ ...s, orders: {} }));
    },
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      {modal && (
        <WalletModal
          state={modal}
          onConfirm={confirm}
          onSupplierReady={() => supplierReady.current?.()}
          onClose={() => setModal(null)}
        />
      )}
    </Ctx.Provider>
  );
}

export function useDemo() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDemo must be used inside <DemoProvider>");
  return ctx;
}
