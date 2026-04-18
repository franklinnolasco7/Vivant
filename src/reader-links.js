import * as api from "./api.js";
import { esc, toast } from "./ui.js";

let _skipExternalLinkConfirmForSession = false;
let ctx = null;

export function init(context) {
  ctx = context;
}

export function attach(body) {
  if (!body) return;
  body.addEventListener("click", (event) => {
    void handleChapterLinkClick(event);
  });
}

async function handleChapterLinkClick(event) {
  if (!(event.target instanceof Element) || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const link = event.target.closest("a[href]");
  const book = ctx.getBook ? ctx.getBook() : null;
  if (!link || !book) return;

  const href = (link.getAttribute("href") || "").trim();
  if (!href) return;

  // External URLs jump to browser; EPUB-internal links navigate within reader
  if (isExternalHref(href)) {
    event.preventDefault();

    if (!isAllowedExternalHref(href)) {
      toast("Blocked unsafe link");
      return;
    }

    const approved = await confirmOpenExternalLink(href);
    if (!approved) return;

    try {
      await api.openExternalUrl(href);
    } catch (err) {
      toast(`Could not open link: ${err.message}`);
    }
    return;
  }

  event.preventDefault();

  try {
    const chapterIdx = ctx.getChapterIdx();
    const target = await api.resolveBookLink(book.file_path, chapterIdx, href);
    if (!target) {
      toast("Link target not found");
      return;
    }

    const targetChapter = ctx.clampChapterIndex(target.chapter_idx);
    const targetAnchor = ctx.normalizeAnchorTarget(target.anchor ?? "");

    if (targetChapter === chapterIdx) {
      if (targetAnchor && ctx.scrollToAnchor(targetAnchor)) {
        ctx.scheduleProgressSave();
      }
      return;
    }

    await ctx.loadChapter(targetChapter, {
      scrollTarget: "top",
      anchorTarget: targetAnchor,
    });
  } catch (err) {
    toast(`Link navigation failed: ${err.message}`);
  }
}

function isExternalHref(href) {
  const value = String(href || "").trim().toLowerCase();
  return /^(https?:|mailto:|tel:|javascript:|data:|file:)/.test(value);
}

function isAllowedExternalHref(href) {
  const value = String(href || "").trim().toLowerCase();
  return /^(https?:|mailto:|tel:)/.test(value);
}

async function confirmOpenExternalLink(href) {
  const safeHref = String(href ?? "").trim();
  if (_skipExternalLinkConfirmForSession) return true;
  return showExternalLinkConfirm(safeHref);
}

function showExternalLinkConfirm(href) {
  return new Promise((resolve) => {
    const existing = document.getElementById("external-link-confirm");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "external-link-confirm";
    overlay.className = "external-link-confirm-backdrop";
    overlay.innerHTML = `
      <div class="external-link-confirm" role="dialog" aria-modal="true" aria-labelledby="external-link-confirm-title">
        <div class="external-link-confirm-title" id="external-link-confirm-title">Open External Link</div>
        <div class="external-link-confirm-body">Open this link in your default browser?</div>
        <input class="external-link-confirm-url" type="text" readonly value="${esc(href)}" />
        <label class="external-link-confirm-session-opt">
          <input class="external-link-confirm-session-checkbox" type="checkbox" data-role="skip-session" />
          <span class="external-link-confirm-session-text">Don't ask again for this session</span>
        </label>
        <div class="external-link-confirm-actions">
          <button class="nav-btn" type="button" data-action="open">Open</button>
          <button class="nav-btn" type="button" data-action="cancel">Cancel</button>
        </div>
      </div>`;

    const urlInput = overlay.querySelector(".external-link-confirm-url");
    const skipSessionInput = overlay.querySelector('[data-role="skip-session"]');
    const openBtn = overlay.querySelector('[data-action="open"]');

    const close = (approved) => {
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.classList.remove("open");
      setTimeout(() => {
        overlay.remove();
        resolve(approved);
      }, 120);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(false);
      }
      if (event.key === "Enter") {
        event.preventDefault();
        close(true);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        urlInput?.focus();
        urlInput?.select();
      }
    };

    overlay.addEventListener("click", (event) => {
      const action = event.target?.closest?.("[data-action]")?.getAttribute("data-action");
      if (action === "open") {
        _skipExternalLinkConfirmForSession = Boolean(skipSessionInput?.checked);
        close(true);
        return;
      }
      if (action === "cancel" || event.target === overlay) {
        close(false);
      }
    });

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("open"));
    document.addEventListener("keydown", onKeyDown, true);

    openBtn?.focus();
  });
}
