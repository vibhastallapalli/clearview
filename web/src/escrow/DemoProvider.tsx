import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { PARTY, initialState, scanned, type DemoState, type OrderLike, type Role, type SignRequest, type Tx } from "./demo";
import { signAndSend, simulatedSignature } from "./sign";
import { WalletModal, type ModalState } from "./WalletModal";

const STORAGE_KEY = "securoserv.demo.v1";

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
  sign: (orderId: string, request: SignRequest) => void;
  resetAll: () => void;
}

const Ctx = createContext<DemoContext | null>(null);

export function DemoProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<Stored>(load);
  const [modal, setModal] = useState<(ModalState & { orderId: string; request: SignRequest }) | null>(null);
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
    setStore((s) => (s.orders[orderId] ? s : { ...s, orders: { ...s.orders, [orderId]: initialState(detail, simulatedSignature()) } }));
  }, []);

  const scan: DemoContext["scan"] = useCallback(
    (orderId) => {
      update(orderId, { step: "scanning" });
      timers.current.push(window.setTimeout(() => update(orderId, (st) => scanned(st)), 2400));
    },
    [update],
  );

  const sign: DemoContext["sign"] = useCallback(
    (orderId, request) => {
      const me = PARTY[store.role];
      setModal({
        orderId,
        request,
        title: request.title,
        rows: [...request.rows, ["Signer", `${me.name} · ${me.wallet}`], ["Memo", "SecuroServ PO-1001"]],
        phase: "ask",
      });
    },
    [store.role],
  );

  const confirm = async () => {
    if (!modal) return;
    const { orderId, request } = modal;
    setModal({ ...modal, phase: "sending" });
    const tx: Tx = await signAndSend(request);
    update(orderId, (st) => request.apply(tx, st));
    setModal((m) => (m ? { ...m, phase: "done", tx } : m));
  };

  const value: DemoContext = {
    role: store.role,
    setRole: (role) => setStore((s) => ({ ...s, role, orders: Object.fromEntries(Object.entries(s.orders).map(([k, v]) => [k, { ...v, countering: false }])) })),
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
      {modal && <WalletModal state={modal} onConfirm={confirm} onClose={() => setModal(null)} />}
    </Ctx.Provider>
  );
}

export function useDemo() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDemo must be used inside <DemoProvider>");
  return ctx;
}
