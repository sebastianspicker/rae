/** Controls the Operator's local, presentation-only color theme. */

const storageKey = "rae-operator-theme";

function preferredTheme() {
  const saved = localStorage.getItem(storageKey);
  if (saved === "light" || saved === "dark") return saved;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme, toggle) {
  document.documentElement.dataset.theme = theme;
  toggle.setAttribute("aria-pressed", String(theme === "dark"));
  toggle.setAttribute("aria-label", `Use ${theme === "dark" ? "light" : "dark"} theme`);
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    "content",
    theme === "dark" ? "#0c1114" : "#eef1f3",
  );
}

export function bindThemeToggle() {
  const toggle = document.getElementById("theme-toggle");
  if (!toggle) return;
  applyTheme(preferredTheme(), toggle);
  toggle.addEventListener("click", () => {
    const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem(storageKey, theme);
    applyTheme(theme, toggle);
  });
}
