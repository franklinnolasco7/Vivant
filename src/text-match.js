// Explicit browser line breaks.
export const BLOCK_TAGS = new Set([
  "ADDRESS","ARTICLE","ASIDE","BLOCKQUOTE","DD","DETAILS","DIALOG","DIV",
  "DL","DT","FIELDSET","FIGCAPTION","FIGURE","FOOTER","FORM","H1","H2",
  "H3","H4","H5","H6","HEADER","HGROUP","HR","LI","MAIN","NAV","OL",
  "P","PRE","SECTION","SUMMARY","TABLE","UL","BR","TR","TD","TH",
]);

export function isBlockElement(node) {
  return node instanceof Element && BLOCK_TAGS.has(node.tagName);
}

export function crossesBlockBoundary(a, b) {
  if (!a || !b) return false;
  let cur = b.parentNode;
  while (cur) {
    if (isBlockElement(cur)) {
      return !cur.contains(a);
    }
    cur = cur.parentNode;
  }
  return false;
}

export function buildNormalizedTextMap(root, { stripPunct = false } = {}) {
  const textNodes = [];
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const txt = node.nodeValue || "";
        const parentTag = node.parentElement?.tagName;
        if (parentTag === "SCRIPT" || parentTag === "STYLE") return NodeFilter.FILTER_REJECT;
        return txt.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    }
  );

  let node;
  while ((node = walker.nextNode())) {
    textNodes.push(node);
  }

  const nodeIndex = new Map();
  textNodes.forEach((n, idx) => nodeIndex.set(n, idx));

  let normalizedText = "";
  const map = [];
  let prevSpace = false;
  let prevTextNode = null;

  for (const textNode of textNodes) {
    // Block boundaries should create spacing in normalized text to match browser selection behavior
    if (prevTextNode && crossesBlockBoundary(prevTextNode, textNode)) {
      if (!prevSpace && normalizedText.length > 0) {
        normalizedText += " ";
        // Map synthetic space back to real DOM position via next node's first char
        map.push({ node: textNode, offset: 0, synthetic: true });
        prevSpace = true;
      }
    }
    prevTextNode = textNode;

    const text = textNode.nodeValue || "";
    for (let i = 0; i < text.length; i++) {
      let ch = normalizeMatchChar(text[i], { stripPunct });
      if (ch === "") continue;

      if (ch === " ") {
        if (!normalizedText.length || prevSpace) {
          prevSpace = true;
          continue;
        }
        prevSpace = true;
      } else {
        prevSpace = false;
      }

      normalizedText += ch;
      map.push({ node: textNode, offset: i });
    }
  }

  while (normalizedText.endsWith(" ")) {
    normalizedText = normalizedText.slice(0, -1);
    map.pop();
  }

  return { normalizedText, map, nodeIndex, textNodes };
}

export function normalizeSearchString(text) {
  return normalizeTextForMatch(text, { stripPunct: false });
}

export function normalizeAnnotationString(text) {
  return normalizeTextForMatch(text, { stripPunct: true });
}

export function normalizeTextForMatch(text, { stripPunct = false } = {}) {
  const raw = String(text || "");
  let normalized = "";
  let prevSpace = false;

  for (let i = 0; i < raw.length; i++) {
    let ch = normalizeMatchChar(raw[i], { stripPunct });
    if (ch === "") continue;

    if (ch === " ") {
      if (!normalized.length || prevSpace) {
        prevSpace = true;
        continue;
      }
      prevSpace = true;
    } else {
      prevSpace = false;
    }

    normalized += ch;
  }

  return normalized.trim();
}

export function normalizeMatchChar(ch, { stripPunct = false } = {}) {
  let out = ch;
  if (out === "\u00A0") out = " ";
  if (out === "\u00AD" || out === "\u200B" || out === "\uFEFF") return "";
  if (out === "\u201C" || out === "\u201D") out = '"';
  if (out === "\u2018" || out === "\u2019") out = "'";
  if (out === "\u2013" || out === "\u2014" || out === "\u2212") out = "-";
  if (/\s/.test(out)) out = " ";
  if (stripPunct && /[\p{P}\p{S}]/u.test(out)) out = " ";
  return out;
}

export function highlightTextRange(textNodes, nodeIndex, startNode, startOffset, endNode, endOffset) {
  const startIdx = nodeIndex.get(startNode);
  const endIdx = nodeIndex.get(endNode);
  if (!Number.isInteger(startIdx) || !Number.isInteger(endIdx)) return [];

  const from = Math.min(startIdx, endIdx);
  const to = Math.max(startIdx, endIdx);
  const spans = [];

  for (let i = from; i <= to; i++) {
    const node = textNodes[i];
    if (!node?.nodeValue) continue;

    let nodeStart = 0;
    let nodeEnd = node.nodeValue.length;

    if (node === startNode) nodeStart = startOffset;
    if (node === endNode) nodeEnd = endOffset;

    if (nodeStart >= nodeEnd) continue;
    const span = wrapTextInNode(node, nodeStart, nodeEnd);
    if (span) spans.push(span);
  }

  return spans;
}

export function buildHighlightNeedles(query) {
  const q = (query || "").trim().toLocaleLowerCase();
  return q ? [q] : [];
}

export function wrapTextInNode(textNode, start, end) {
  const txt = textNode.nodeValue || "";
  if (start < 0 || end <= start || end > txt.length) return null;

  const after = textNode.splitText(end);
  const middle = textNode.splitText(start);
  const span = document.createElement("span");
  span.className = "search-hit-flash";
  middle.parentNode?.insertBefore(span, middle);
  span.appendChild(middle);
  after.parentNode?.normalize();
  return span;
}

export function clearExistingSearchHighlight() {
  document.querySelectorAll(".search-hit-flash").forEach((el) => unwrapHighlight(el));
}

export function unwrapHighlight(el) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
  parent.normalize();
}

export function longestCommonSubstring(a, b) {
  if (!a || !b) return 0;
  let max = 0;
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        if (dp[i][j] > max) max = dp[i][j];
      }
    }
  }
  return max;
}

export function flashAnnotationHit(quote) {
  const body = document.querySelector(".chapter-body");
  if (!body) return false;

  clearExistingSearchHighlight();

  const q = quote.trim();
  if (!q || q.length < 4) return false;

  const { normalizedText, map, nodeIndex, textNodes } =
    buildNormalizedTextMap(body, { stripPunct: true });

  const normalizedQuote = normalizeAnnotationString(q);
  if (!normalizedQuote || normalizedQuote.length < 4) return false;
  if (normalizedText.length < normalizedQuote.length) return false;

  // Fuzzy match: try full quote, then progressively shorten from word boundaries
  // Only require 50% or 20 chars minimum so partial highlights don't fail
  const MIN_SEARCH_LEN = Math.max(20, Math.floor(normalizedQuote.length * 0.5));
  let matchIdx = -1;
  let matchedLen = 0;
  let searchQ = normalizedQuote;

  while (searchQ.length >= MIN_SEARCH_LEN) {
    const idx = normalizedText.indexOf(searchQ);
    if (idx >= 0) {
      matchIdx = idx;
      matchedLen = searchQ.length;
      break;
    }

    // Shorten by trimming to previous word boundary.
    const lastSpace = searchQ.trimEnd().lastIndexOf(" ");
    if (lastSpace < MIN_SEARCH_LEN) break;
    searchQ = searchQ.slice(0, lastSpace).trimEnd();
  }

  if (matchIdx < 0 || matchedLen === 0) return false;

  const startInfo = map[matchIdx];
  if (!startInfo) return false;

  // Use actual match length to avoid selecting beyond what was found
  let endMapIdx = matchIdx + matchedLen - 1;
  // Include trailing punctuation/symbols that normalization removed if they're in the original quote
  const originalEnd = q.trimEnd();
  while (endMapIdx + 1 < map.length) {
    const nextEntry = map[endMapIdx + 1];
    const nextRawChar = nextEntry.node.nodeValue?.[nextEntry.offset] ?? "";

    // Stop extending past word chars (prevents selecting unrelated text)
    if (/\w/.test(nextRawChar)) break;
    const quoteEndsWithIt = originalEnd.endsWith(
      (nextEntry.node.nodeValue || "").slice(
        nextEntry.offset,
        nextEntry.offset + 1
      )
    );
    if (!quoteEndsWithIt) break;

    endMapIdx++;
  }

  const endInfo = map[Math.min(endMapIdx, map.length - 1)];
  if (!endInfo) return false;

  // Validate overlap (75%+) before highlighting to avoid false positives
  const matchedRaw = textNodes
    .slice(nodeIndex.get(startInfo.node), nodeIndex.get(endInfo.node) + 1)
    .map((n, i, arr) => {
      const val = n.nodeValue || "";
      if (arr.length === 1) return val.slice(startInfo.offset, endInfo.offset + 1);
      if (i === 0) return val.slice(startInfo.offset);
      if (i === arr.length - 1) return val.slice(0, endInfo.offset + 1);
      return val;
    })
    .join("");

  const matchedNorm = normalizeAnnotationString(matchedRaw);
  const overlapRatio = longestCommonSubstring(matchedNorm, normalizedQuote) / normalizedQuote.length;
  if (overlapRatio < 0.75) return false;

  const spans = highlightTextRange(
    textNodes, nodeIndex,
    startInfo.node, startInfo.offset,
    endInfo.node,   endInfo.offset + 1
  );
  if (!spans.length) return false;

  spans.forEach(s =>
    s.addEventListener("animationend", () => unwrapHighlight(s), { once: true })
  );
  spans[0].scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

export function flashSearchHit(query) {
  const body = document.querySelector(".chapter-body");
  if (!body) return false;

  clearExistingSearchHighlight();

  const q = query.trim();
  if (!q) return false;

  // Strategy 1: exact phrase match across the full normalized text map
  const { normalizedText, map, nodeIndex, textNodes } = buildNormalizedTextMap(body, { stripPunct: false });
  const normalizedQ = normalizeSearchString(q);

  if (normalizedQ.length >= 2) {
    const matchIdx = normalizedText.indexOf(normalizedQ);
    if (matchIdx >= 0) {
      const startInfo = map[matchIdx];
      const endInfo   = map[matchIdx + normalizedQ.length - 1];
      if (startInfo && endInfo) {
        const spans = highlightTextRange(
          textNodes, nodeIndex,
          startInfo.node, startInfo.offset,
          endInfo.node,   endInfo.offset + 1
        );
        if (spans.length) {
          spans.forEach(s => s.addEventListener("animationend", () => unwrapHighlight(s), { once: true }));
          spans[0].scrollIntoView({ behavior: "smooth", block: "center" });
          return true;
        }
      }
    }
  }

  // Strategy 2: single text node match on the full query only, never tokens
  const needle = q.toLocaleLowerCase();
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const tag = node.parentElement?.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
      return node.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  let node;
  while ((node = walker.nextNode())) {
    const lower = (node.nodeValue || "").toLocaleLowerCase();
    const idx = lower.indexOf(needle);
    if (idx < 0) continue;

    const candidate = (node.nodeValue || "").slice(idx, idx + needle.length);
    if (candidate.toLocaleLowerCase() !== needle) continue;

    const span = wrapTextInNode(node, idx, idx + needle.length);
    if (!span) continue;

    span.addEventListener("animationend", () => unwrapHighlight(span), { once: true });
    span.scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  }

  return false;
}
