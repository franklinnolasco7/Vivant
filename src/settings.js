import * as ui from "./ui.js";

let panel = null;
let activeTab = "appearance";

const THEME_OPTIONS = [
  {
    value: "dark",
    label: "Dark",
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
  },
  {
    value: "light",
    label: "Light",
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/></svg>`,
  },
  {
    value: "sepia",
    label: "Sepia",
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><line x1="6" y1="2" x2="6" y2="4"/><line x1="10" y1="2" x2="10" y2="4"/><line x1="14" y1="2" x2="14" y2="4"/></svg>`,
  },
  {
    value: "bw",
    label: "Black & White",
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>`,
  },
];

export function init() {
  const btn = document.getElementById("btn-settings");
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });
}

function toggle() {
  if (panel) close();
  else open();
}

function open() {
  if (panel) return;

  const backdrop = document.createElement("div");
  backdrop.id = "settings-backdrop";
  backdrop.className = "settings-backdrop";
  backdrop.addEventListener("click", close);

  panel = document.createElement("div");
  panel.id = "settings-panel";
  panel.className = "settings-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "settings-title");
  panel.addEventListener("click", (e) => e.stopPropagation());

  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);

  render();
  requestAnimationFrame(() => backdrop.classList.add("open"));
  document.addEventListener("keydown", onKeyDown, true);
}

function close() {
  if (!panel) return;
  const backdrop = document.getElementById("settings-backdrop");
  if (backdrop) {
    backdrop.classList.remove("open");
    backdrop.addEventListener("transitionend", () => backdrop.remove(), { once: true });
  }
  panel = null;
  document.removeEventListener("keydown", onKeyDown, true);
}

function onKeyDown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}

function setTab(tab) {
  activeTab = tab;
  render();
}

function render() {
  if (!panel) return;
  const currentTheme = ui.savedTheme();

  panel.innerHTML = `
    <div class="settings-header">
      <div>
        <div class="settings-title" id="settings-title">Settings</div>
        <div class="settings-sub">Customize your reading experience</div>
      </div>
      <button class="settings-close-btn" id="settings-close" aria-label="Close settings">
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <line x1="3" y1="3" x2="11" y2="11"/>
          <line x1="11" y1="3" x2="3" y2="11"/>
        </svg>
      </button>
    </div>

    <div class="settings-tabs">
      <button class="settings-tab ${activeTab === "appearance" ? "active" : ""}" data-tab="appearance">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        Appearance
      </button>
      <button class="settings-tab ${activeTab === "reading" ? "active" : ""}" data-tab="reading">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
        Reading
      </button>
    </div>

    <div class="settings-body">
      ${activeTab === "appearance" ? renderAppearance(currentTheme) : renderReading()}
    </div>
  `;

  panel.querySelector("#settings-close").addEventListener("click", close);

  panel.querySelectorAll(".settings-tab").forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
  });

  if (activeTab === "appearance") {
    panel.querySelectorAll(".settings-theme-row").forEach((row) => {
      row.addEventListener("click", () => {
        ui.applyTheme(row.dataset.theme);
        render();
      });
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          ui.applyTheme(row.dataset.theme);
          render();
        }
      });
    });
  }
}

function renderAppearance(currentTheme) {
  return `
    <div class="settings-section">
      <div class="settings-section-title">Theme</div>
      <div class="settings-option-list">
        ${THEME_OPTIONS.map((t) => `
          <div
            class="settings-theme-row ${currentTheme === t.value ? "active" : ""}"
            data-theme="${t.value}"
            role="radio"
            aria-checked="${currentTheme === t.value}"
            tabindex="0"
          >
            <span class="settings-row-dot"></span>
            <span class="settings-row-icon">${t.icon}</span>
            <span class="settings-row-label">${t.label}</span>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderReading() {
  return `
    <div class="settings-section">
      <div class="settings-section-title">Reading</div>
      <div class="settings-placeholder">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
        <span>Reading settings coming soon</span>
      </div>
    </div>
  `;
}
