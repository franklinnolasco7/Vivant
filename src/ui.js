/**
 * ui.js — shared UI primitives: theme, toast, HTML escaping, colour palette.
 * No business logic lives here.
 */

// ── Theme ─────────────────────────────────────────────────────────────────────

const THEMES = ["dark", "sepia", "light", "bw"];

export function applyTheme(theme) {
  if (!THEMES.includes(theme)) theme = "dark";
  document.documentElement.className = theme === "dark" ? "" : `theme-${theme}`;
  document.querySelectorAll(".swatch-btn").forEach((s) =>
    s.classList.toggle("active", s.dataset.theme === theme)
  );
  localStorage.setItem("theme", theme);
  return theme;
}

export function savedTheme() {
  return localStorage.getItem("theme") || "dark";
}

// ── Toast ─────────────────────────────────────────────────────────────────────

let _toastTimer;

export function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

/** Prevent XSS by escaping HTML metacharacters before innerHTML. */
export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render empty-state UI for panels ("book" or "highlighter" icon).
 * @returns {string} HTML safe for innerHTML.
 */
export function emptyState(icon, title, sub) {
  let iconSvg = "";

  if (icon === "book") {
    iconSvg = `<svg class="empty-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 7v14"/>
      <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>
    </svg>`;
  } else if (icon === "highlighter") {
    iconSvg = `<svg class="empty-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="m9 11-6 6v3h9l3-3"/>
      <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>
    </svg>`;
  }

  return `<div class="empty-state">
    <div class="empty-state-icon">${iconSvg}</div>
    <div class="empty-state-title">${esc(title)}</div>
    <div class="empty-state-sub">${esc(sub)}</div>
  </div>`;
}

// ── Cover colour palette ──────────────────────────────────────────────────────

const PALETTE = [
  { bg: "#132518", ac: "#4e9a6f" },
  { bg: "#1e1004", ac: "#c4875a" },
  { bg: "#080e18", ac: "#3a8ab5" },
  { bg: "#120a1e", ac: "#8a5ab5" },
  { bg: "#1a1000", ac: "#c4a030" },
  { bg: "#180a0a", ac: "#b55a5a" },
];

/** Deterministic colour from a book title — same title always gives same colour. */
export function coverColor(title) {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = title.charCodeAt(i) + ((h << 5) - h);
  return PALETTE[Math.abs(h) % PALETTE.length];
}

/** SVG fallback cover art for books without an extracted image. */
export function fallbackCover(title) {
  const c = coverColor(title);
  return `
  <div class="book-cover-fallback" style="background:${c.bg}">
    <svg viewBox="0 0 140 210" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
      <rect width="140" height="210" fill="${c.bg}"/>
      <circle cx="70" cy="88" r="52" stroke="${c.ac}" stroke-width="1" fill="none" opacity=".2"/>
      <circle cx="70" cy="88" r="30" stroke="${c.ac}" stroke-width=".8" fill="none" opacity=".15"/>
      <circle cx="70" cy="88" r="12" fill="${c.ac}" opacity=".18"/>
      <rect x="14" y="18" width="112" height=".5" fill="${c.ac}" opacity=".3"/>
      <rect x="14" y="170" width="112" height=".5" fill="${c.ac}" opacity=".3"/>
    </svg>
    <span class="book-cover-fallback-title">${esc(title)}</span>
  </div>`;
}
