/** Pure formatting helpers for the operator console. */

export function phaseLabel(phase) {
  const labels = new Map([
    ["arm", "Intake"],
    ["design", "Design"],
    ["adversarial-review", "Adversarial review"],
    ["plan", "Plan"],
    ["pmatch", "Drift match"],
    ["build", "Build"],
    ["quality-static", "Quality static"],
    ["quality-tests", "Quality tests"],
    ["post-build", "Post-build"],
    ["release-readiness", "Release readiness"],
  ]);
  return labels.get(phase) ?? humanize(phase);
}

export function humanize(value) {
  return String(value ?? "")
    .replaceAll(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function tone(status) {
  const value = String(status ?? "").toLowerCase();
  if (["pass", "passed", "completed", "success", "approved"].includes(value)) return "pass";
  if (["fail", "failed", "error", "blocked", "rejected"].includes(value)) return "error";
  if (["running", "active", "in_progress", "pending", "awaiting"].includes(value)) return "active";
  if (["interrupted", "stopped", "cancelled", "canceled"].includes(value)) return "muted";
  return "muted";
}

export function runTone(run) {
  if (run?.checkpoints?.some((item) => item.status === "pending")) return "blocked";
  const statusTone = tone(run?.status);
  if (statusTone === "pass") return "proof";
  if (statusTone === "active") return "active";
  if (statusTone === "error") return "blocked";
  return "muted";
}

export function runStateWord(run) {
  if (run?.checkpoints?.some((item) => item.status === "pending")) return "hold";
  const statusTone = tone(run?.status);
  if (statusTone === "pass") return "pass";
  if (statusTone === "active") return "live";
  if (statusTone === "error") return "stop";
  return "stop";
}

export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", `#icon-${name}`);
  svg.append(use);
  return svg;
}

export function formatNumber(value, unavailable = "—") {
  if (value === null || value === undefined || value === "") return unavailable;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toLocaleString() : String(value);
}

export function formatCost(value) {
  if (value === null || value === undefined || value === "") return "Unavailable";
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 4,
      }).format(numeric)
    : String(value);
}

export function formatTime(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Not available"
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatDateTime(value) {
  if (!value) return "Unavailable";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Unavailable"
    : date.toLocaleString([], {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function relativeTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  const delta = Date.now() - date.valueOf();
  if (delta < 60_000) return "Now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;
  if (delta < dayMs) return `${Math.floor(delta / hourMs)}h`;
  if (delta < 2 * dayMs) return "Yesterday";
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function shortId(id) {
  const value = String(id ?? "");
  return value.length > 8 ? value.slice(0, 8) : value;
}

export function shortRef(value) {
  const text = String(value ?? "");
  if (!text) return "—";
  if (text.length <= 18) return text;
  return `${text.slice(0, 10)}…${text.slice(-4)}`;
}
