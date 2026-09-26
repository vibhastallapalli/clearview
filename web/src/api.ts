import type { ApiError, Order, OrderDetail } from "@cleardock/shared";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error("Can't reach the ClearDock server. Is it running?");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body as ApiError | null)?.error ?? `Request failed (${res.status})`);
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export type OrderRow = Order & { supplierName?: string };

export const api = {
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

  captureSession: (code: string) =>
    request<{ session: { orderId: string; expiresAt: string }; orderReference: string }>(
      `/api/capture-sessions/${code}`,
    ),

  submitCapture: (code: string, image: Blob, mockScenario?: string) => {
    const fd = new FormData();
    fd.append("image", image, "capture.jpg");
    if (mockScenario) fd.append("mockScenario", mockScenario);
    return request(`/api/capture-sessions/${code}/captures`, { method: "POST", body: fd });
  },

  approve: (orderId: string, evidenceRevision: number) =>
    request<OrderDetail>(`/api/orders/${orderId}/approve`, json({ evidenceRevision })),

  preparePayment: (orderId: string) =>
    request<OrderDetail>(`/api/orders/${orderId}/payments`, { method: "POST" }),

  reset: () => request("/api/dev/reset", { method: "POST" }),
};

export const money = (minor: number | null | undefined) =>
  minor === null || minor === undefined ? "—" : `$${(minor / 100).toFixed(2)}`;
