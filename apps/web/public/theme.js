// Applies the saved appearance before first paint (external file: the CSP forbids inline scripts).
// Values: "light" (default), "dark", "system". Kept in sync with src/lib/theme.ts.
(() => {
  let saved = null;
  try {
    saved = localStorage.getItem("da-theme");
  } catch {
    // Storage blocked (private mode): fall back to the default.
  }
  document.documentElement.dataset.theme = saved === "dark" || saved === "system" ? saved : "light";
})();
