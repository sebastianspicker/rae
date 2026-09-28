/** Session-authenticated API helpers and surface status. */

import { elements, state } from "./state.js";

export interface OperatorTransport {
  request(path: string, options?: RequestInit): Promise<unknown>;
  eventStream?(path: string, options?: RequestInit): Promise<Response>;
}

type HttpError = Error & { status: number };
let transport: OperatorTransport | null = null;
let toastTimer: number | undefined;

/**
 * Installs the narrow browser transport seam used by the static Pages demo.
 * Production leaves this unset, so every request keeps its bearer-authenticated
 * same-origin `/api/v1` behavior.
 */
export function setTransport(nextTransport: OperatorTransport): void {
  if (!nextTransport || typeof nextTransport.request !== "function") {
    throw new TypeError("operator transport must provide request(path, options)");
  }
  transport = nextTransport;
}

export function resetTransport(): void {
  transport = null;
}

export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  if (transport) return (await transport.request(path, options)) as T;
  if (!state.token) {
    throw new Error("Missing session token. Reopen the URL printed by the operator server.");
  }
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${state.token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object" &&
      "message" in payload.error &&
      typeof payload.error.message === "string"
        ? payload.error.message
        : `Request failed (${response.status})`;
    const error = new Error(message) as HttpError;
    error.status = response.status;
    throw error;
  }
  return payload as T;
}

/** Opens an NDJSON event response through the active transport. */
export async function eventStream(path: string, options: RequestInit = {}): Promise<Response> {
  if (transport) {
    if (typeof transport.eventStream !== "function") {
      throw new Error("active operator transport does not support event streams");
    }
    return transport.eventStream(path, options);
  }
  if (!state.token) {
    throw new Error("Missing session token. Reopen the URL printed by the operator server.");
  }
  return fetch(`/api/v1${path}`, {
    ...options,
    headers: { authorization: `Bearer ${state.token}`, ...(options.headers ?? {}) },
  });
}

export function showToast(message: string, toneValue = "error"): void {
  const toast = elements.toast;
  toast.hidden = false;
  toast.dataset.tone = toneValue;
  toast.textContent = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 5200);
}

export function showError(error: unknown): void {
  showToast(error instanceof Error ? error.message : "Unexpected operator error", "error");
}

export function setConnection(stateValue: string, label: string, detail = "Local session"): void {
  const status = elements["connection-status"];
  const dot = document.createElement("span");
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  const description = document.createElement("small");
  status.dataset.state = stateValue;
  dot.className = "session-state__dot";
  dot.setAttribute("aria-hidden", "true");
  title.textContent = label;
  description.textContent = detail;
  copy.append(title, description);
  status.replaceChildren(dot, copy);
}
