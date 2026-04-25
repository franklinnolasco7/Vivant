import { toast } from "./ui.js";

const IMAGE_VIEWER_CLOSE_DELAY_MS = 140;

let _imageViewerBackdrop = null;
let _imageViewerPanel = null;
let _imageViewerImg = null;
let _imageViewerCaption = null;
let _imageViewerCloseTimer = null;
let _imageViewerMenu = null;
let _imageViewerMenuOpen = false;
let _imageViewerMenuSrc = "";
let _imageViewerMenuAlt = "";

export function initImageViewer() {
  const content = document.getElementById("content");
  if (!content) return;

  _imageViewerBackdrop = document.createElement("div");
  _imageViewerBackdrop.className = "image-viewer-backdrop";
  _imageViewerBackdrop.setAttribute("aria-hidden", "true");

  _imageViewerPanel = document.createElement("aside");
  _imageViewerPanel.className = "image-viewer-panel";
  _imageViewerPanel.setAttribute("aria-hidden", "true");
  _imageViewerPanel.innerHTML = `
    <div class="image-viewer-stage">
      <img class="image-viewer-img" alt="" />
      <div class="image-viewer-caption" aria-hidden="true"></div>
    </div>
  `;

  content.appendChild(_imageViewerBackdrop);
  content.appendChild(_imageViewerPanel);

  _imageViewerMenu = document.createElement("div");
  _imageViewerMenu.className = "image-viewer-menu";
  _imageViewerMenu.setAttribute("role", "menu");
  _imageViewerMenu.setAttribute("aria-hidden", "true");
  _imageViewerMenu.innerHTML = `
    <div class="image-viewer-menu-title">Image</div>
    <button class="image-viewer-menu-item" type="button" data-action="copy" role="menuitem">Copy image</button>
    <button class="image-viewer-menu-item" type="button" data-action="export" role="menuitem">Export image...</button>
  `;
  content.appendChild(_imageViewerMenu);

  _imageViewerImg = _imageViewerPanel.querySelector(".image-viewer-img");
  _imageViewerCaption = _imageViewerPanel.querySelector(".image-viewer-caption");

  _imageViewerBackdrop.addEventListener("click", closeImageViewer);
  _imageViewerPanel.addEventListener("click", (event) => {
    if (event.target === _imageViewerPanel) closeImageViewer();
  });
  _imageViewerImg?.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setImageMenuSource(_imageViewerImg);
    openImageViewerMenu(event.clientX, event.clientY);
  });

  const readingArea = document.getElementById("reading-area");
  readingArea?.addEventListener("contextmenu", (event) => {
    if (!(event.target instanceof Element)) return;
    const img = event.target.closest("img");
    if (!img || !img.closest(".chapter-body")) return;
    event.preventDefault();
    event.stopPropagation();
    setImageMenuSource(img);
    openImageViewerMenu(event.clientX, event.clientY);
  });

  _imageViewerMenu.addEventListener("click", (event) => {
    const action = event.target?.closest?.("[data-action]")?.getAttribute("data-action");
    if (action === "copy") {
      void copyImageFromViewer();
    } else if (action === "export") {
      void exportImageFromViewer();
    }
  });

  document.addEventListener("click", (event) => {
    if (_imageViewerMenuOpen && !_imageViewerMenu.contains(event.target)) {
      closeImageViewerMenu();
    }
  });
  document.addEventListener("scroll", () => {
    if (_imageViewerMenuOpen) closeImageViewerMenu();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && _imageViewerPanel?.classList.contains("open")) {
      event.preventDefault();
      closeImageViewerMenu();
      closeImageViewer();
    }
    if (event.key === "Escape") closeImageViewerMenu();
  });
}

function openImageViewerMenu(x, y) {
  if (!_imageViewerMenu || !_imageViewerMenuSrc) return;

  _imageViewerMenuOpen = true;
  _imageViewerMenu.classList.add("open");
  _imageViewerMenu.setAttribute("aria-hidden", "false");
  _imageViewerMenu.style.visibility = "hidden";
  _imageViewerMenu.style.left = "0px";
  _imageViewerMenu.style.top = "0px";

  requestAnimationFrame(() => {
    if (!_imageViewerMenu) return;
    const rect = _imageViewerMenu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    const left = Math.max(8, Math.min(x, maxX));
    const top = Math.max(8, Math.min(y, maxY));
    _imageViewerMenu.style.left = `${left}px`;
    _imageViewerMenu.style.top = `${top}px`;
    _imageViewerMenu.style.visibility = "";
  });
}

function setImageMenuSource(img) {
  if (!img) return;
  const src = img.getAttribute("src") || "";
  if (!src) return;
  _imageViewerMenuSrc = src;
  _imageViewerMenuAlt = String(img.getAttribute("alt") || "").trim();
}

function closeImageViewerMenu() {
  if (!_imageViewerMenuOpen || !_imageViewerMenu) return;
  _imageViewerMenuOpen = false;
  _imageViewerMenu.classList.remove("open");
  _imageViewerMenu.setAttribute("aria-hidden", "true");
  _imageViewerMenu.style.left = "-9999px";
  _imageViewerMenu.style.top = "-9999px";
}

async function copyImageFromViewer() {
  if (!_imageViewerMenuSrc) return;
  closeImageViewerMenu();

  try {
    const blob = await fetchImageBlob(_imageViewerMenuSrc);
    if (!blob) throw new Error("Image not available");

    try {
      const { writeImage } = await import("@tauri-apps/plugin-clipboard-manager");
      const { Image } = await import("@tauri-apps/api/image");
      if (writeImage) {
        const pngBytes = await rasterizeImageToPngBytes(blob);
        const tauriImage = await Image.fromBytes(pngBytes);
        await writeImage(tauriImage);
        toast("Image copied to clipboard");
        return;
      }
    } catch {
      // Fall back to web clipboard below.
    }

    if (navigator.clipboard?.write && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      toast("Image copied to clipboard");
      return;
    }

    const dataUrl = await blobToDataUrl(blob);
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(dataUrl);
      toast("Copied image data URL");
      return;
    }

    throw new Error("Clipboard image copy not supported");
  } catch (err) {
    toast(`Copy failed: ${err.message}`);
  }
}

async function exportImageFromViewer() {
  if (!_imageViewerMenuSrc) return;
  closeImageViewerMenu();

  try {
    const blob = await fetchImageBlob(_imageViewerMenuSrc);
    if (!blob) throw new Error("Image not available");

    const ext = (blob.type.split("/")[1] || "png").replace(/[^a-z0-9]+/gi, "");
    const base = (_imageViewerMenuAlt || "image").replace(/[^a-z0-9._-]+/gi, "_");
    const defaultName = `${base || "image"}.${ext || "png"}`;

    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: defaultName,
      filters: [{ name: "Image", extensions: [ext || "png"] }],
    });
    if (!path) return;

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { writeFile } = await import("@tauri-apps/plugin-fs");

    try {
      await writeFile(path, bytes);
    } catch {
      await writeFile({ path, contents: bytes });
    }

    toast("Image exported");
  } catch (err) {
    toast(`Export failed: ${err.message}`);
  }
}

async function fetchImageBlob(src) {
  const res = await fetch(src);
  if (!res.ok) throw new Error("Image fetch failed");
  return await res.blob();
}

async function rasterizeImageToPngBytes(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not available");
  ctx.drawImage(bitmap, 0, 0);

  const pngBlob = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png")
  );
  if (!pngBlob) throw new Error("PNG conversion failed");
  return new Uint8Array(await pngBlob.arrayBuffer());
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.readAsDataURL(blob);
  });
}

export function openImageViewer(img) {
  if (!_imageViewerBackdrop || !_imageViewerPanel || !_imageViewerImg) return;

  if (_imageViewerCloseTimer) {
    clearTimeout(_imageViewerCloseTimer);
    _imageViewerCloseTimer = null;
  }

  const src = img.getAttribute("src") || "";
  if (!src) return;

  _imageViewerImg.src = src;
  const altText = String(img.getAttribute("alt") || "").trim();
  _imageViewerImg.alt = altText || "Image preview";
  setImageMenuSource(_imageViewerImg);
  if (_imageViewerCaption) {
    _imageViewerCaption.textContent = altText;
    _imageViewerCaption.setAttribute("aria-hidden", altText ? "false" : "true");
  }

  _imageViewerBackdrop.classList.add("open");
  _imageViewerPanel.classList.add("open");
  _imageViewerBackdrop.setAttribute("aria-hidden", "false");
  _imageViewerPanel.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

export function closeImageViewer() {
  if (!_imageViewerBackdrop || !_imageViewerPanel || !_imageViewerImg) return;

  if (_imageViewerCloseTimer) return;

  _imageViewerBackdrop.classList.remove("open");
  _imageViewerPanel.classList.remove("open");
  closeImageViewerMenu();

  _imageViewerCloseTimer = setTimeout(() => {
    _imageViewerCloseTimer = null;
    _imageViewerBackdrop.setAttribute("aria-hidden", "true");
    _imageViewerPanel.setAttribute("aria-hidden", "true");
    _imageViewerImg.src = "";
    _imageViewerMenuSrc = "";
    _imageViewerMenuAlt = "";
    if (_imageViewerCaption) {
      _imageViewerCaption.textContent = "";
      _imageViewerCaption.setAttribute("aria-hidden", "true");
    }
    document.body.style.overflow = "";
  }, IMAGE_VIEWER_CLOSE_DELAY_MS);
}

export function isImageViewerOpen() {
  return _imageViewerBackdrop?.classList.contains("open") ?? false;
}
