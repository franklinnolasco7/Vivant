import { describe, expect, it } from "vitest";
import { esc, clamp, coverColor } from "../ui.js";
import { filterBooks, progressLabel, normalizeEpubPaths } from "../library.js";
import { normalizeAnchorTarget } from "../reader.js";

describe("ui helpers", () => {
  describe("esc", () => {
    it("escapes html-sensitive characters", () => {
      expect(esc('<div class="x">A&B</div>')).toBe("&lt;div class=&quot;x&quot;&gt;A&amp;B&lt;/div&gt;");
    });

    it("handles null and undefined", () => {
      expect(esc(null)).toBe("");
      expect(esc(undefined)).toBe("");
    });

    it("handles empty string", () => {
      expect(esc("")).toBe("");
    });

    it("leaves plain text unchanged", () => {
      expect(esc("Hello World")).toBe("Hello World");
    });
  });

  describe("clamp", () => {
    it("returns value when within range", () => {
      expect(clamp(5, 0, 10)).toBe(5);
    });

    it("returns min when value is below range", () => {
      expect(clamp(-5, 0, 10)).toBe(0);
    });

    it("returns max when value is above range", () => {
      expect(clamp(15, 0, 10)).toBe(10);
    });

    it("works with floating point", () => {
      expect(clamp(5.5, 0, 10)).toBe(5.5);
    });

    it("handles edge cases at boundaries", () => {
      expect(clamp(0, 0, 10)).toBe(0);
      expect(clamp(10, 0, 10)).toBe(10);
    });
  });

  describe("coverColor", () => {
    it("returns deterministic cover colors for the same title", () => {
      const a = coverColor("The Hobbit");
      const b = coverColor("The Hobbit");

      expect(a).toEqual(b);
      expect(a).toHaveProperty("bg");
      expect(a).toHaveProperty("ac");
    });

    it("returns different colors for different titles", () => {
      const a = coverColor("The Hobbit");
      const b = coverColor("1984");

      expect(a.bg).not.toBe(b.bg);
    });
  });

  describe("filterBooks", () => {
    const books = [
      { title: "The Hobbit", author: "J.R.R. Tolkien" },
      { title: "1984", author: "George Orwell" },
      { title: "The Great Gatsby", author: "F. Scott Fitzgerald" },
    ];

    it("returns all books when query is empty", () => {
      expect(filterBooks(books, "")).toEqual(books);
      expect(filterBooks(books, null)).toEqual(books);
    });

    it("filters by title (case-insensitive)", () => {
      expect(filterBooks(books, "hobbit")).toHaveLength(1);
      expect(filterBooks(books, "hobbit")[0].title).toBe("The Hobbit");
    });

    it("filters by author (case-insensitive)", () => {
      expect(filterBooks(books, "orwell")).toHaveLength(1);
      expect(filterBooks(books, "orwell")[0].author).toBe("George Orwell");
    });

    it("returns empty array when no match", () => {
      expect(filterBooks(books, "xyz")).toHaveLength(0);
    });

    it("matches partial strings", () => {
      expect(filterBooks(books, "grea")).toHaveLength(1);
    });
  });

  describe("progressLabel", () => {
    it("returns 'Not started' for 0%", () => {
      expect(progressLabel({ progress_pct: 0 })).toBe("Not started");
    });

    it("returns 'Not started' for negative values", () => {
      expect(progressLabel({ progress_pct: -5 })).toBe("Not started");
    });

    it("returns percentage for in-progress", () => {
      expect(progressLabel({ progress_pct: 50 })).toBe("50% read");
      expect(progressLabel({ progress_pct: 33 })).toBe("33% read");
    });

    it("returns 'Finished' for 100%", () => {
      expect(progressLabel({ progress_pct: 100 })).toBe("✓ Finished");
    });

    it("rounds to nearest integer", () => {
      expect(progressLabel({ progress_pct: 33.7 })).toBe("34% read");
      expect(progressLabel({ progress_pct: 33.3 })).toBe("33% read");
    });
  });

  describe("normalizeEpubPaths", () => {
    it("filters to only .epub files", () => {
      const paths = [
        "/foo/book.epub",
        "/foo/book.txt",
        "/foo/document.EPUB",
        "/foo/image.png",
      ];
      expect(normalizeEpubPaths(paths)).toEqual([
        "/foo/book.epub",
        "/foo/document.EPUB",
      ]);
    });

    it("trims whitespace", () => {
      expect(normalizeEpubPaths(["  /foo/book.epub  "])).toEqual(["/foo/book.epub"]);
    });

    it("filters out non-strings", () => {
      expect(normalizeEpubPaths(["/foo/book.epub", null, undefined, 123])).toEqual([
        "/foo/book.epub",
      ]);
    });

    it("filters out empty strings", () => {
      expect(normalizeEpubPaths(["", "  ", "/foo/book.epub"])).toEqual(["/foo/book.epub"]);
    });

    it("returns empty array for no valid paths", () => {
      expect(normalizeEpubPaths([])).toEqual([]);
    });
  });

  describe("normalizeAnchorTarget", () => {
    it("strips leading #", () => {
      expect(normalizeAnchorTarget("#chapter1")).toBe("chapter1");
    });

    it("returns empty string for empty input", () => {
      expect(normalizeAnchorTarget("")).toBe("");
      expect(normalizeAnchorTarget(null)).toBe("");
      expect(normalizeAnchorTarget(undefined)).toBe("");
    });

    it("trims whitespace", () => {
      expect(normalizeAnchorTarget("  chapter1  ")).toBe("chapter1");
    });

    it("decodes URI-encoded strings", () => {
      expect(normalizeAnchorTarget("chapter%201")).toBe("chapter 1");
    });

    it("handles invalid URI gracefully", () => {
      expect(normalizeAnchorTarget("%ZZ")).toBe("%ZZ");
    });

    it("preserves valid anchors without #", () => {
      expect(normalizeAnchorTarget("chapter1")).toBe("chapter1");
    });
  });
});