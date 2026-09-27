import type { ApiError, Capture, Order, OrderDetail, PaymentTransaction, PhoneProof, PublicConfig } from "@cleardock/shared";

/** A failed API call. `status` 0 = the server couldn't be reached; `code` is absent when the reply wasn't an ApiError. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: ApiError["code"],
  ) {
    super(message);
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiRequestError("Can't reach the ClearDock server. Is it running?", 0);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = body as ApiError | null;
    throw new ApiRequestError(err?.error ?? `Request failed (${res.status})`, res.status, err?.code);
  }
  return body as T;
}

export const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export type OrderRow = Order & { supplierName?: string };

export const api = {
  config: () => request<PublicConfig>("/api/config"),
  health: () => request<{ ok: boolean; ai: "gemini" | "mock" }>("/api/health"),
  orders: () => request<OrderRow[]>("/api/orders"),
  order: (id: string) => request<OrderDetail>(`/api/orders/${id}`),

  uploadDocument: (orderId: string, kind: string, file: File) => {
    const fd = new FormData();
    fd.append("kind", kind);
    fd.append("file", file);
    return request<OrderDetail>(`/api/orders/${orderId}/documents`, { method: "POST", body: fd });
  },

  createCaptureSession: (orderId: string) =>
    request<{ session: { code: string; expiresAt: string }; url: string }>(
      `/api/orders/${orderId}/capture-sessions`,
      { method: "POST" },
    ),

  /** Test aid: a labelled synthetic photo attached as phone proof (SIMULATED photo; assessed by the configured AI). */
  /** Test aid until the station hardware exists: an uploaded photo scanned as the station camera (SIMULATED). */
  simulateStationPhoto: (orderId: string, image: File) => {
    const fd = new FormData();
    fd.append("image", image);
    return request<{ order: OrderDetail }>(`/api/dev/orders/${orderId}/station-photo`, { method: "POST", body: fd });
  },

  sampleProof: (orderId: string, sample: string) =>
    request<unknown>(`/api/dev/orders/${orderId}/sample-proof`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sample }),
    }),

  captureSession: (code: string) =>
    request<{ session: { orderId: string; expiresAt: string }; orderReference: string }>(
      `/api/capture-sessions/${code}`,
    ),

  // Phone photo = raw proof for the current station scan, for the supplier. No AI reads it; it never replaces
  // the station result. "live" only for in-app camera snapshots; picked files are "upload". 409 before any station scan.
  submitCapture: (code: string, image: Blob, kind: "live" | "upload") => {
    const fd = new FormData();
    fd.append("image", image, "capture.jpg");
    fd.append("kind", kind);
    return request<{ capture: Capture; proof: PhoneProof; order: OrderDetail }>(`/api/capture-sessions/${code}/captures`, {
      method: "POST",
      body: fd,
    });
  },

  approve: (orderId: string, evidenceRevision: number) =>
    request<OrderDetail>(`/api/orders/${orderId}/approve`, json({ evidenceRevision })),

  preparePayment: (orderId: string) =>
    request<OrderDetail>(`/api/orders/${orderId}/payments`, { method: "POST" }),

  // Unsigned transfer for the connected wallet to sign. The server never signs.
  paymentTransaction: (orderId: string, payer: string) =>
    request<PaymentTransaction>(`/api/orders/${orderId}/payments/transaction`, json({ payer })),

  // The wallet only signs; the server checks the signed bytes, records the signature, then broadcasts.
  submitPayment: (orderId: string, transaction: string) =>
    request<OrderDetail>(`/api/orders/${orderId}/payments/submit`, json({ transaction })),

  // Verifies the landed transaction on devnet. Same signature again = re-check.
  confirmPayment: (orderId: string, signature: string) =>
    request<OrderDetail>(`/api/orders/${orderId}/payments/confirm`, json({ signature })),

  // Server checks the landed transaction on devnet, then records the escrow account it reads (never client numbers).
  escrowEvent: (orderId: string, body: { action: "fund" | "accept_all" | "claim" | "settle"; signature: string; escrowAddress: string }) =>
    request<OrderDetail>(`/api/orders/${orderId}/escrow/events`, json(body)),

  reset: () => request("/api/dev/reset", { method: "POST" }),
};

export const money = (minor: number | null | undefined) =>
  minor === null || minor === undefined ? "—" : `$${(minor / 100).toFixed(2)}`;
