import { esc } from "./ui.js";

let tocOpen = true;
const tocCollapsedGroups = new Set();
let currentToc = [];
let currentChapterIdx = 0;
let loadChapterCallback = null;

export function initToc({ onChapterSelect }) {
  document.getElementById("btn-toc").addEventListener("click", toggleToc);
  loadChapterCallback = onChapterSelect;
}

export function setTocData(toc, chapterIdx) {
  currentToc = toc;
  currentChapterIdx = chapterIdx;
}

export function renderToc() {
  const el = document.getElementById("toc-items");
  if (!currentToc.length) {
    el.innerHTML = `<div style="padding:12px 14px;font-size:12px;color:var(--t2)">No table of contents</div>`;
    return;
  }

  const tree = buildTocTree(currentToc);
  const activePath = new Set();
  markActivePath(tree, activePath, currentChapterIdx);

  // Keep the active chapter visible when users collapse sibling groups.
  expandToActivePath(tree, activePath);

  el.innerHTML = renderTocNodes(tree, 0, activePath, currentChapterIdx);

  el.onclick = (evt) => {
    const target = evt.target;
    if (!(target instanceof Element)) return;

    const toggleBtn = target.closest(".toc-group-toggle");
    if (toggleBtn) {
      const groupId = toggleBtn.getAttribute("data-group-id");
      if (!groupId) return;

      if (tocCollapsedGroups.has(groupId)) {
        tocCollapsedGroups.delete(groupId);
      } else {
        tocCollapsedGroups.add(groupId);
      }
      renderToc();
      return;
    }

    // Resolve chapter from nested clicks within grouped TOC rows.
    let chapter = null;
    let walkEl = target;
    while (walkEl && walkEl !== el) {
      const ch = walkEl.getAttribute?.("data-chapter");
      if (ch !== null && ch !== undefined) {
        chapter = Number(ch);
        if (Number.isFinite(chapter)) break;
      }
      walkEl = walkEl.parentElement;
    }

    if (!Number.isFinite(chapter)) return;

    if (loadChapterCallback) {
      loadChapterCallback(chapter);
    }
  };
}

export function toggleToc() {
  tocOpen = !tocOpen;
  document.getElementById("toc-panel").classList.toggle("collapsed", !tocOpen);
}

function buildTocTree(entries) {
  const root = [];
  const stack = [];
  let seq = 0;

  for (const entry of entries) {
    const depth = Math.max(0, Number(entry.depth) || 0);
    const node = {
      label: entry.label,
      chapter_idx: entry.chapter_idx,
      depth,
      groupId: `g-${entry.chapter_idx}-${seq++}`,
      children: [],
    };

    while (stack.length && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }

    if (!stack.length) {
      root.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  }

  return root;
}

function markActivePath(nodes, activePath, chapterIdx) {
  let found = false;

  for (const node of nodes) {
    const inSubtree = node.chapter_idx === chapterIdx || markActivePath(node.children, activePath, chapterIdx);
    if (inSubtree) {
      activePath.add(node.groupId);
      found = true;
    }
  }

  return found;
}

function expandToActivePath(nodes, activePath) {
  for (const node of nodes) {
    if (node.children.length > 0) {
      const hasActiveLocal = markActivePath([node], new Set(), currentChapterIdx);
      if (hasActiveLocal && activePath.has(node.groupId)) {
        tocCollapsedGroups.delete(node.groupId);
      }
      expandToActivePath(node.children, activePath);
    }
  }
}

function renderTocNodes(nodes, level, activePath, chapterIdx) {
  return nodes.map((node) => {
    const hasChildren = node.children.length > 0;
    const active = node.chapter_idx === chapterIdx;
    const shouldCollapse = hasChildren
      ? tocCollapsedGroups.has(node.groupId) && !activePath.has(node.groupId)
      : false;

    const item = `<div class="toc-item${active ? " active" : ""}" data-depth="${level}" data-chapter="${node.chapter_idx}">${esc(node.label)}</div>`;

    if (!hasChildren) return item;

    return `<div class="toc-group${shouldCollapse ? " collapsed" : ""}" data-depth="${level}">
      <div class="toc-group-header" data-depth="${level}">
        <button class="toc-group-toggle" data-group-id="${node.groupId}" aria-label="Toggle section" title="Toggle section">
          <span class="toc-group-chevron" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="2.5,4.5 6,8 9.5,4.5"></polyline>
            </svg>
          </span>
        </button>
        ${item}
      </div>
      <div class="toc-group-children">
        ${renderTocNodes(node.children, level + 1, activePath, chapterIdx)}
      </div>
    </div>`;
  }).join("");
}
