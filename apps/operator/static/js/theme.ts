/** Controls the Operator's local, presentation-only color theme. */

const storageKey = "rae-operator-theme";

type OperatorTheme = "light" | "dark";

function preferredTheme(): OperatorTheme {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* A blocked storage area must not block the interface. */
  }
  // Without a stored choice, follow the OS; dark remains the default when it states none.
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme: OperatorTheme, toggle: HTMLElement): void {
  document.documentElement.dataset.theme = theme;
  toggle.setAttribute("aria-pressed", String(theme === "dark"));
  toggle.setAttribute("aria-label", `Use ${theme === "dark" ? "light" : "dark"} theme`);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#0e171c" : "#f2f5f6");
}

export function bindThemeToggle(): void {
  const toggle = document.getElementById("theme-toggle");
  if (!toggle) return;
  applyTheme(preferredTheme(), toggle);
  toggle.addEventListener("click", () => {
    const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(storageKey, theme);
    } catch {
      /* The selected theme still applies for this session. */
    }
    applyTheme(theme, toggle);
  });
}
