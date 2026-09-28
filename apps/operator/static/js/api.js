/** Session-authenticated API helpers and surface status. */

import { elements, state } from "./state.js";

let transport = null;

/**
 * Installs the narrow browser transport seam used by the static Pages demo.
 * Production leaves this unset, so every request keeps its bearer-authenticated
 * same-origin `/api/v1` behavior.
 */
export function setTransport(nextTransport) {
  if (!nextTransport || typeof nextTransport.request !== "function") {
    throw new TypeError("operator transport must provide request(path, options)");
  }
  transport = nextTransport;
}

export function resetTransport() {
  transport = null;
}

export async function api(path, options = {}) {
  if (transport) return transport.request(path, options);
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
    const error = new Error(payload?.error?.message || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

/** Opens an NDJSON event response through the active transport. */
export async function eventStream(path, options = {}) {
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

export function showToast(message, toneValue = "error") {
  const toast = elements.toast;
  toast.hidden = false;
  toast.dataset.tone = toneValue;
  toast.textContent = message;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.hidden = true;
  }, 5200);
}

export function showError(error) {
  showToast(error?.message || "Unexpected operator error", "error");
}

export function setConnection(stateValue, label, detail = "Local session") {
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
