import * as ann from "./annotations.js";
import { esc } from "./ui.js";

let getChapterIdx = () => 0;

export function init(options) {
  getChapterIdx = options.getChapterIdx || getChapterIdx;

  const tooltip = document.getElementById("sel-tooltip");
  const area    = document.getElementById("reading-area");

  area.addEventListener("mouseup", (e) => {
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 4) {
      const maxLeft = Math.max(4, window.innerWidth - 180);
      tooltip.style.top  = Math.max(0, e.clientY - 48) + "px";
      tooltip.style.left = clamp(e.clientX - 70, 4, maxLeft) + "px";
      tooltip.classList.add("show");
    } else {
      hideTooltip();
    }
  });

  document.getElementById("sel-cancel").addEventListener("click", hideTooltip);
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#sel-tooltip")) hideTooltip();
  });

  document.getElementById("sel-highlight").addEventListener("click", () =>
    saveSelection(null)
  );
  document.getElementById("sel-note").addEventListener("click", async () => {
    const selectedQuote = window.getSelection()?.toString().trim() || "";
    const note = await showAddNoteDialog();
    await saveSelection(note, selectedQuote);
  });
}

import { clamp } from "./ui.js";

async function saveSelection(note, quoteOverride = "") {
  const sel = window.getSelection();
  const quote = quoteOverride || sel?.toString().trim();
  hideTooltip();
  if (!quote) return;

  const saved = await ann.add({ chapterIdx: getChapterIdx(), quote, note });
  if (saved) ann.open();
}

function hideTooltip() {
  document.getElementById("sel-tooltip")?.classList.remove("show");
  window.getSelection?.()?.removeAllRanges();
}

function showAddNoteDialog() {
  return new Promise((resolve) => {
    const existing = document.getElementById("add-note-dialog");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "add-note-dialog";
    overlay.className = "add-note-dialog-backdrop";
    overlay.innerHTML = `
      <div class="add-note-dialog" role="dialog" aria-modal="true" aria-labelledby="add-note-dialog-title">
        <div class="add-note-dialog-title" id="add-note-dialog-title">Add a note</div>
        <textarea class="add-note-dialog-input" data-role="note-input" rows="4" maxlength="2000" placeholder="Write a note..."></textarea>
        <div class="add-note-dialog-actions">
          <button class="nav-btn" type="button" data-action="cancel">Cancel</button>
          <button class="nav-btn" type="button" data-action="save">Save</button>
        </div>
      </div>`;

    const input = overlay.querySelector('[data-role="note-input"]');
    const saveBtn = overlay.querySelector('[data-action="save"]');
    const cancelBtn = overlay.querySelector('[data-action="cancel"]');

    const autoSizeInput = () => {
      if (!input) return;
      input.style.height = "auto";
      const maxPx = Math.floor(window.innerHeight * 0.45);
      input.style.height = `${Math.min(input.scrollHeight, maxPx)}px`;
    };

    const close = (result) => {
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.classList.remove("open");
      setTimeout(() => {
        overlay.remove();
        resolve(result);
      }, 120);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(null);
      }
      // Cmd+Enter or Ctrl+Enter to save (common note-taking shortcut)
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        const value = String(input?.value ?? "").trim();
        close(value || null);
      }
    };

    saveBtn?.addEventListener("click", () => {
      const value = String(input?.value ?? "").trim();
      close(value || null);
    });

    cancelBtn?.addEventListener("click", () => {
      close(null);
    });

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        close(null);
      }
    });

    input?.addEventListener("input", autoSizeInput);

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("open"));
    document.addEventListener("keydown", onKeyDown, true);

    saveBtn?.focus();
    input?.focus();
    autoSizeInput();
  });
}
