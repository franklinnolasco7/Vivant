use crate::error::{Error, Result};
use epub::doc::EpubDoc;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io;
use std::hash::{Hash, Hasher};
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;
use zip::ZipArchive;

/// In-process cache for parsed TOC entries, keyed by canonical book path.
/// Avoids re-opening the zip and walking the nav tree on every chapter load.
static TOC_CACHE: LazyLock<Mutex<HashMap<PathBuf, Vec<TocEntry>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BookMeta {
    pub title: String,
    pub author: String,
    pub genre: Option<String>,
    pub description: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub published_at: Option<String>,
    pub file_size: Option<u64>,
    pub cover_data: Option<Vec<u8>>,
    pub chapter_count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TocEntry {
    pub label: String,
    pub chapter_idx: usize,
    pub depth: u8,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChapterContent {
    pub index: usize,
    pub title: String,
    pub html: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LinkTarget {
    pub chapter_idx: usize,
    pub anchor: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub chapter_idx: usize,
    pub snippet: String,
    pub match_start: usize,
    pub match_len: usize,
}

pub fn parse_meta(path: &Path, include_cover: bool) -> Result<BookMeta> {
    let mut doc = open(path)?;
    let title = doc.mdata("title").map(|m| m.value.clone()).unwrap_or_else(|| stem(path));
    let author = doc
        .mdata("creator")
        .map(|m| m.value.clone())
        .unwrap_or_else(|| "Unknown Author".to_string());
    let genre = first_meta_value(&mut doc, &["subject", "genre"]);
    let description = first_meta_value(&mut doc, &["description", "abstract"]);
    let publisher = first_meta_value(&mut doc, &["publisher"]);
    let language = first_meta_value(&mut doc, &["language"]);
    let published_at = first_meta_value(&mut doc, &["date", "published", "issued"]);
    let file_size = fs::metadata(path).ok().map(|m| m.len());
    let chapter_count = doc.get_num_chapters();

    let cover_data = if include_cover {
        doc.get_cover()
            .or_else(|| get_fallback_cover(&mut doc))
            .map(|(data, _mime)| resize_cover(&data).unwrap_or(data))
    } else {
        None
    };

    Ok(BookMeta {
        title,
        author,
        genre,
        description,
        publisher,
        language,
        published_at,
        file_size,
        cover_data,
        chapter_count,
    })
}

fn first_meta_value(
    doc: &mut epub::doc::EpubDoc<std::io::BufReader<std::fs::File>>,
    keys: &[&str],
) -> Option<String> {
    for key in keys {
        if let Some(meta) = doc.mdata(key) {
            let value = meta.value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

pub fn parse_toc(path: &Path) -> Result<Vec<TocEntry>> {
    let mut doc = open(path)?;
    let spine_ids: Vec<String> = doc.spine.iter().map(|s| s.idref.clone()).collect();
    let total = doc.get_num_chapters();
    let toc_items = doc.toc.clone();
    let mut out = Vec::new();

    fn walk(
        items: &[epub::doc::NavPoint],
        doc: &epub::doc::EpubDoc<std::io::BufReader<std::fs::File>>,
        spine_ids: &[String],
        total: usize,
        out: &mut Vec<TocEntry>,
        depth: u8,
    ) {
        for item in items {
            let src = item.content.to_string_lossy().to_string();
            let src_base = src.split('#').next().unwrap_or(&src);
            let fallback = out.last().map(|e| e.chapter_idx).unwrap_or(0);
            let chapter_idx = doc
                .resource_uri_to_chapter(&item.content)
                .or_else(|| spine_ids.iter().position(|id| src_base.contains(id.as_str())))
                .unwrap_or(fallback)
                .min(total.saturating_sub(1));
            out.push(TocEntry { label: item.label.trim().to_owned(), chapter_idx, depth });
            walk(&item.children, doc, spine_ids, total, out, depth + 1);
        }
    }

    walk(&toc_items, &doc, &spine_ids, total, &mut out, 0);

    // Dedup: TOC walk may produce multiple entries per chapter (nested headings). Keep first occurrence.
    let mut deduped = Vec::new();
    let mut seen = HashSet::new();
    for e in out {
        if seen.insert(e.chapter_idx) {
            deduped.push(e);
        }
    }

    // Merge deduped TOC with full spine to ensure every chapter is navigable,
    // even if TOC omits it (common in self-published EPUBs).
    let mut merged: BTreeMap<usize, TocEntry> = BTreeMap::new();
    for e in deduped {
        merged.entry(e.chapter_idx).or_insert(e);
    }

    // Collect indices of unmapped chapters that need fallback labels.
    let unmapped: Vec<usize> = (0..total).filter(|i| !merged.contains_key(i)).collect();

    // Fill unmapped chapters: first try spine ID pattern matching, then batch-extract
    // HTML titles from a SINGLE doc open (instead of opening a new zip per chapter).
    let mut html_titles: HashMap<usize, String> = HashMap::new();
    if !unmapped.is_empty() {
        // Batch-extract heading titles from all unmapped chapters in one pass.
        for &idx in &unmapped {
            // Try spine ID-based label first (cheap, no I/O).
            if fallback_label_from_spine_id(idx, &spine_ids).is_some() {
                continue; // Will be handled below.
            }
            // Extract title from chapter HTML using the already-open doc.
            doc.set_current_chapter(idx);
            if let Some((raw, _)) = doc.get_current_str() {
                if let Some(title) = extract_heading_from_html(&raw) {
                    html_titles.insert(idx, title);
                }
            }
        }
    }

    for i in 0..total {
        merged.entry(i).or_insert_with(|| {
            let label = if let Some(l) = fallback_label_from_spine_id(i, &spine_ids) {
                l
            } else if let Some(l) = html_titles.remove(&i) {
                l
            } else {
                format!("Section {}", i + 1)
            };
            TocEntry { label, chapter_idx: i, depth: 0 }
        });
    }

    let result: Vec<TocEntry> = merged.into_values().collect();

    // Populate the in-process cache so subsequent calls (e.g. from get_chapter) are free.
    if let Ok(canonical) = fs::canonicalize(path) {
        if let Ok(mut cache) = TOC_CACHE.lock() {
            cache.insert(canonical, result.clone());
        }
    }

    Ok(result)
}

/// Return cached TOC if available, otherwise parse and cache.
pub fn cached_toc(path: &Path) -> Result<Vec<TocEntry>> {
    if let Ok(canonical) = fs::canonicalize(path) {
        if let Ok(cache) = TOC_CACHE.lock() {
            if let Some(entries) = cache.get(&canonical) {
                return Ok(entries.clone());
            }
        }
    }
    parse_toc(path)
}

/// Remove a book's TOC from cache (e.g. after re-import).
pub fn invalidate_toc_cache(path: &Path) {
    if let Ok(canonical) = fs::canonicalize(path) {
        if let Ok(mut cache) = TOC_CACHE.lock() {
            cache.remove(&canonical);
        }
    }
}

/// Try to derive a label from the spine ID pattern (no I/O needed).
fn fallback_label_from_spine_id(idx: usize, spine_ids: &[String]) -> Option<String> {
    let id = spine_ids.get(idx)?;
    let id_l = id.to_lowercase();
    let known: &[(&str, &str)] = &[
        ("cover", "Cover"),
        ("titlepage", "Title Page"),
        ("title", "Title Page"),
        ("preface", "Preface"),
        ("foreword", "Foreword"),
        ("introduction", "Introduction"),
        ("prologue", "Prologue"),
        ("dedication", "Dedication"),
        ("epigraph", "Epigraph"),
        ("contents", "Contents"),
        ("toc", "Table of Contents"),
        ("epilogue", "Epilogue"),
        ("afterword", "Afterword"),
        ("acknowledgment", "Acknowledgments"),
        ("acknowledgement", "Acknowledgments"),
        ("appendix", "Appendix"),
        ("glossary", "Glossary"),
        ("bibliography", "Bibliography"),
        ("index", "Index"),
        ("copyright", "Copyright"),
        ("about", "About the Author"),
        ("notes", "Notes"),
        ("endnotes", "Endnotes"),
        ("footnotes", "Footnotes"),
    ];
    for (pat, label) in known {
        if id_l.contains(pat) {
            return Some(label.to_string());
        }
    }
    None
}

/// Extract the first heading (h1-h4) text from chapter HTML.
fn extract_heading_from_html(html: &str) -> Option<String> {
    for tag in &["h1", "h2", "h3", "h4"] {
        if let Some(t) = extract_tag_text(html, tag) {
            if !t.is_empty() {
                return Some(t);
            }
        }
    }
    None
}

/// Naïve tag-text extractor: returns inner text of first `<tag …>…</tag>`.
fn extract_tag_text(html: &str, tag: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let start = lower.find(&open)?;
    let after_open = html[start..].find('>')? + start + 1;
    let end = lower[after_open..].find(&close)? + after_open;
    let inner = to_plain(&html[after_open..end]);
    let trimmed = inner.trim().to_string();
    if trimmed.is_empty() { None } else { Some(trimmed) }
}

pub fn get_chapter_html_with_cache(
    path: &Path,
    chapter_idx: usize,
    cache_root: &Path,
) -> Result<ChapterContent> {
    let extracted_root = ensure_extracted(path, cache_root)?;
    let mut doc = open(path)?;
    let total = doc.get_num_chapters();

    if chapter_idx >= total {
        return Err(Error::NotFound(format!("chapter {chapter_idx} (book has {total})")));
    }

    doc.set_current_chapter(chapter_idx);
    let chapter_path = doc.get_current_path().unwrap_or_default();
    let (raw, _mime) = doc
        .get_current_str()
        .ok_or_else(|| Error::Epub(format!("chapter {chapter_idx} returned no content")))?;

    let html = strip_chrome(&raw);
    let html = rewrite_img_srcs(html, &chapter_path, &extracted_root);

    let snippet = safe_prefix(&html, 500);
    log::info!("Chapter HTML (first 500 bytes): {}", snippet);

    let spine_ids: Vec<String> = doc.spine.iter().map(|s| s.idref.clone()).collect();
    let toc = cached_toc(path).unwrap_or_default();
    let title = toc
        .iter()
        .find(|e| e.chapter_idx == chapter_idx)
        .map(|e| e.label.clone())
        .unwrap_or_else(|| {
            fallback_label_from_spine_id(chapter_idx, &spine_ids)
                .unwrap_or_else(|| format!("Section {}", chapter_idx + 1))
        });

    Ok(ChapterContent { index: chapter_idx, title, html })
}

pub fn ensure_extracted(epub_path: &Path, cache_root: &Path) -> Result<PathBuf> {
    let cache_dir = cache_dir_for_book(epub_path, cache_root);
    let marker = cache_dir.join(".vivant-source");
    let fingerprint = source_fingerprint(epub_path)?;

    if cache_dir.exists() {
        if let Ok(existing) = fs::read_to_string(&marker) {
            if existing == fingerprint {
                return Ok(cache_dir);
            }
        }
        fs::remove_dir_all(&cache_dir)?;
    }

    fs::create_dir_all(&cache_dir)?;
    extract_epub(epub_path, &cache_dir)?;
    fs::write(marker, fingerprint)?;
    Ok(cache_dir)
}

pub fn search(path: &Path, query: &str) -> Result<Vec<SearchResult>> {
    let q = query.to_lowercase();
    let mut doc = open(path)?;
    let total = doc.get_num_chapters();
    let mut results = Vec::new();

    for i in 0..total {
        doc.set_current_chapter(i);
        if let Some((raw, _)) = doc.get_current_str() {
            let plain = to_plain(&raw);
            let plain_lower = plain.to_lowercase();
            let mut pos = 0;

            while let Some(found) = plain_lower[pos..].find(&q) {
                let abs = pos + found;

                let match_len = plain[abs..]
                    .char_indices()
                    .nth(q.chars().count())
                    .map(|(b, _)| b)
                    .unwrap_or(q.len());

                let s = clamp_to_char_boundary(&plain, abs.saturating_sub(60));
                let e = clamp_to_char_boundary(&plain, (abs + match_len + 60).min(plain.len()));

                results.push(SearchResult {
                    chapter_idx: i,
                    snippet: plain[s..e].to_owned(),
                    match_start: abs - s,
                    match_len,
                });

                pos = abs + match_len;
            }
        }
    }
    Ok(results)
}

pub fn resolve_internal_link(path: &Path, current_chapter_idx: usize, href: &str) -> Result<Option<LinkTarget>> {
    let trimmed = href.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    if has_external_scheme(trimmed) {
        return Ok(None);
    }

    let (target_path_raw, anchor_raw) = match trimmed.split_once('#') {
        Some((p, a)) => (p.trim(), Some(a)),
        None => (trimmed, None),
    };

    let anchor = anchor_raw
        .map(|a| decode_fragment(a).trim().to_string())
        .filter(|a| !a.is_empty());

    let mut doc = open(path)?;
    let total = doc.get_num_chapters();
    if total == 0 {
        return Ok(None);
    }

    let current_idx = current_chapter_idx.min(total.saturating_sub(1));

    if target_path_raw.is_empty() {
        return Ok(Some(LinkTarget {
            chapter_idx: current_idx,
            anchor,
        }));
    }

    doc.set_current_chapter(current_idx);
    let chapter_path = doc.get_current_path().unwrap_or_default();
    let resolved = resolve_resource_path(&chapter_path, target_path_raw);

    let resolved_buf = PathBuf::from(&resolved);
    let raw_buf = PathBuf::from(target_path_raw);
    let stripped = target_path_raw.trim_start_matches('/');
    let stripped_buf = (stripped != target_path_raw).then(|| PathBuf::from(stripped));

    let chapter_idx = doc
        .resource_uri_to_chapter(&resolved_buf)
        .or_else(|| doc.resource_uri_to_chapter(&raw_buf))
        .or_else(|| stripped_buf.as_ref().and_then(|p| doc.resource_uri_to_chapter(p)));

    Ok(chapter_idx.map(|idx| LinkTarget {
        chapter_idx: idx.min(total.saturating_sub(1)),
        anchor,
    }))
}

pub fn get_resource(path: &Path, resource_path: &str) -> Option<(Vec<u8>, String)> {
    let mut doc = open(path).ok()?;
    let clean = normalize_resource_path(resource_path);
    log::debug!("Looking up resource: {} -> {}", resource_path, clean);
    doc.get_resource_by_path(std::path::Path::new(&clean))
        .map(|data| {
            let mime = detect_mime(&data).to_string();
            log::debug!("Resource found: {} ({} bytes, type: {})", clean, data.len(), mime);
            (data, mime)
        })
}

#[allow(dead_code)]
pub fn _keep_functions_referenced() {
    let _ = get_resource;
    let _ = normalize_resource_path;
    let _ = detect_mime;
}

fn normalize_resource_path(path: &str) -> String {
    path.trim().to_string()
}

fn rewrite_img_srcs(html: String, chapter_path: &Path, extracted_root: &Path) -> String {
    let mut out = html;
    let mut total_count = 0;

    for tag_name in ["<img", "<image"] {
        let mut temp_out = String::with_capacity(out.len() + 256);
        let mut rest = out.as_str();

        while let Some(start) = rest.find(tag_name) {
            temp_out.push_str(&rest[..start]);
            let from_tag = &rest[start..];
            let tag_len = from_tag.find('>').map(|i| i + 1).unwrap_or(from_tag.len());
            let tag = &from_tag[..tag_len];
            temp_out.push_str(&rewrite_src_attr(tag, chapter_path, extracted_root));
            rest = &from_tag[tag_len..];
            total_count += 1;
        }
        temp_out.push_str(rest);
        out = temp_out;
    }

    if total_count > 0 {
        log::info!("Rewrote {} image tags in chapter", total_count);
    } else {
        log::warn!("No image tags found in chapter HTML");
    }
    out
}

fn rewrite_src_attr(tag: &str, chapter_path: &Path, extracted_root: &Path) -> String {
    let mut modified_tag = tag.to_string();
    for attr in ["src=", "href=", "xlink:href="] {
        for quote in ['"', '\''] {
            let marker = format!("{}{}", attr, quote);
            if let Some(pos) = modified_tag.find(&marker) {
                let after = &modified_tag[pos + marker.len()..];
                if let Some(end) = after.find(quote) {
                    let src = &after[..end];

                    if src.starts_with("data:")
                        || src.starts_with("http:")
                        || src.starts_with("https:")
                        || src.starts_with("#")
                    {
                        continue;
                    }

                    let clean = resolve_resource_path(chapter_path, src);
                    if clean.is_empty() {
                        continue;
                    }

                    let absolute = extracted_root.join(Path::new(&clean));
                    let new_src = file_url(&absolute);

                    if let Some(new_src) = new_src {
                        let to_replace = format!("{}{}{}", marker, src, quote);
                        let replacement = format!("{}{}{}", marker, new_src, quote);
                        modified_tag = modified_tag.replacen(&to_replace, &replacement, 1);
                        return modified_tag;
                    }
                }
            }
        }
    }
    modified_tag
}

fn file_url(path: &Path) -> Option<String> {
    let abs = fs::canonicalize(path).ok().unwrap_or_else(|| path.to_path_buf());
    url::Url::from_file_path(&abs).ok().map(|u| u.to_string())
}

fn cache_dir_for_book(epub_path: &Path, cache_root: &Path) -> PathBuf {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    epub_path.to_string_lossy().hash(&mut hasher);
    let key = format!("{:016x}", hasher.finish());
    cache_root.join("epubs").join(key)
}

fn source_fingerprint(epub_path: &Path) -> Result<String> {
    // Fingerprint combines path + size + mtime. If any changes, cache is invalidated.
    // (Hash of path prevents collisions across multiple books in same cache root.)
    let meta = fs::metadata(epub_path)?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(format!("{}:{}:{}", epub_path.display(), meta.len(), modified))
}

fn extract_epub(epub_path: &Path, out_dir: &Path) -> Result<()> {
    let file = File::open(epub_path)?;
    let mut zip = ZipArchive::new(file)
        .map_err(|e| Error::Epub(format!("{}: {e}", epub_path.display())))?;

    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| Error::Epub(format!("{}: {e}", epub_path.display())))?;

        let Some(rel) = entry.enclosed_name().map(PathBuf::from) else {
            continue;
        };

        let out_path = out_dir.join(rel);

        if entry.is_dir() {
            fs::create_dir_all(&out_path)?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut outfile = File::create(&out_path)?;
        io::copy(&mut entry, &mut outfile)?;
    }

    Ok(())
}

fn resolve_resource_path(chapter_path: &Path, src: &str) -> String {
    // Strip query/anchor (zip keys don't include them).
    let src = src.split(['?', '#']).next().unwrap_or(src);
    if src.trim().is_empty() {
        return String::new();
    }

    let decoded = urlencoding::decode(src)
        .map(|c| c.to_string())
        .unwrap_or_else(|_| src.to_string());

    let mut base = chapter_path.to_path_buf();
    base.pop();

    // Normalize path component-by-component: only ParentDir and Normal components are allowed.
    // CurDir, RootDir, Prefix are ignored. This prevents `../../../etc/passwd` traversal attacks.
    for comp in Path::new(&decoded).components() {
        match comp {
            Component::ParentDir => {
                base.pop();
            }
            Component::Normal(seg) => {
                base.push(seg);
            }
            Component::CurDir | Component::RootDir | Component::Prefix(_) => {}
        }
    }

    path_to_unix(base)
}

fn path_to_unix(path: PathBuf) -> String {
    if cfg!(windows) {
        path.to_string_lossy().replace('\\', "/")
    } else {
        path.to_string_lossy().to_string()
    }
}

fn detect_mime(data: &[u8]) -> &'static str {
    if data.is_empty() {
        return "application/octet-stream";
    }

    // Check magic bytes (binary headers). Covers 99% of common formats.
    if data.starts_with(b"\x89PNG") {
        return "image/png";
    } else if data.starts_with(b"\xff\xd8") {
        return "image/jpeg";
    } else if data.starts_with(b"GIF8") {
        return "image/gif";
    } else if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
        return "image/webp";
    } else if data.starts_with(b"<?xml") || data.starts_with(b"<svg") {
        return "image/svg+xml";
    }

    // Some SVG images omit XML declaration. Try UTF-8 decode + tag search as last resort.
    if let Ok(s) = std::str::from_utf8(&data[..core::cmp::min(100, data.len())]) {
        if s.contains("<svg") {
            return "image/svg+xml";
        }
    }

    // Default to JPEG for unknown binary formats (EPUB covers rarely seen types).
    "image/jpeg"
}

fn open(path: &Path) -> Result<EpubDoc<std::io::BufReader<std::fs::File>>> {
    EpubDoc::new(path).map_err(|e| Error::Epub(format!("{}: {e}", path.display())))
}

fn has_external_scheme(href: &str) -> bool {
    let Some((scheme, _)) = href.split_once(':') else {
        return false;
    };
    if scheme.is_empty() || scheme.len() == 1 {
        return false;
    }
    let valid_scheme = scheme
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.');
    if !valid_scheme {
        return false;
    }

    matches!(
        scheme.to_ascii_lowercase().as_str(),
        "http" | "https" | "mailto" | "tel" | "javascript" | "data" | "file"
    )
}

fn decode_fragment(fragment: &str) -> String {
    urlencoding::decode(fragment)
        .map(|v| v.to_string())
        .unwrap_or_else(|_| fragment.to_string())
}

fn stem(path: &Path) -> String {
    path.file_stem().unwrap_or_default().to_string_lossy().into_owned()
}

fn to_plain(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut last_was_space = false;

    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                if !last_was_space {
                    out.push(' ');
                    last_was_space = true;
                }
            }
            _ if !in_tag => {
                out.push(c);
                last_was_space = c == ' ';
            }
            _ => {}
        }
    }
    out.trim().to_string()
}

fn strip_chrome(html: &str) -> String {
    let lower = html.to_lowercase();
    if let (Some(bs), Some(be)) = (lower.find("<body"), lower.rfind("</body>")) {
        let start = html[bs..].find('>').map(|p| bs + p + 1).unwrap_or(bs);
        return html[start..be].to_owned();
    }
    html.to_owned()
}

fn safe_prefix(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let idx = clamp_to_char_boundary(s, max_bytes);
    &s[..idx]
}

fn clamp_to_char_boundary(s: &str, idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    let mut i = idx;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn resize_cover(data: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(data).ok()?;
    let resized = img.resize(260, 390, image::imageops::FilterType::Triangle);
    let mut out = std::io::Cursor::new(Vec::new());
    resized.write_to(&mut out, image::ImageFormat::Jpeg).ok()?;
    Some(out.into_inner())
}

fn get_fallback_cover(doc: &mut epub::doc::EpubDoc<std::io::BufReader<std::fs::File>>) -> Option<(Vec<u8>, String)> {
    let mut target_id = None;

    // 1. "cover-image" property
    if target_id.is_none() {
        if let Some((id, _)) = doc.resources.iter().find(|(_, res)| {
            res.properties.as_ref().map_or(false, |p| p.split_ascii_whitespace().any(|s| s == "cover-image"))
        }) {
            target_id = Some(id.clone());
        }
    }

    // 2. Try mdata("cover") for EPUB3 files where get_cover might not look for it but mdata has it
    if target_id.is_none() {
        if let Some(item) = doc.mdata("cover") {
            if doc.resources.contains_key(&item.value) {
                target_id = Some(item.value.clone());
            }
        }
    }

    // 3. ID or path containing "cover"
    if target_id.is_none() {
        if let Some((id, _)) = doc.resources.iter().find(|(id, res)| {
            if !res.mime.starts_with("image/") { return false; }
            let p = res.path.to_string_lossy().to_lowercase();
            let i = id.to_lowercase();
            p.contains("cover") || i.contains("cover")
        }) {
            target_id = Some(id.clone());
        }
    }

    // 4. First image in manifest
    if target_id.is_none() {
        let mut images: Vec<_> = doc.resources.iter()
            .filter(|(_, res)| res.mime.starts_with("image/"))
            .collect();
        images.sort_by_key(|(_, res)| res.path.to_string_lossy().into_owned());
        if let Some((id, _)) = images.first() {
            target_id = Some((*id).clone());
        }
    }

    if let Some(id) = target_id {
        return doc.get_resource(&id);
    }

    None
}
