import { describe, expect, it } from "vitest";
import { estimateProgress, toTagList, extractYear, formatFileSize, formatTimeRead, formatDate } from "../format.js";

describe("format.js", () => {
  describe("estimateProgress", () => {
    it("returns 0 for zero chapters", () => {
      expect(estimateProgress(0, 0)).toBe(0);
    });

    it("returns 0 for negative chapters", () => {
      expect(estimateProgress(0, -1)).toBe(0);
    });

    it("returns 0 at first chapter", () => {
      expect(estimateProgress(0, 5)).toBe(20);
    });

    it("returns 100 at last chapter", () => {
      expect(estimateProgress(4, 5)).toBe(100);
    });

    it("returns middle percentage", () => {
      expect(estimateProgress(2, 5)).toBe(60);
    });

    it("clamps to 100 for out of range", () => {
      expect(estimateProgress(10, 5)).toBe(100);
    });
  });

  describe("toTagList", () => {
    it("returns empty array for null/undefined", () => {
      expect(toTagList(null)).toEqual([]);
      expect(toTagList(undefined)).toEqual([]);
    });

    it("returns empty array for empty string", () => {
      expect(toTagList("")).toEqual([]);
    });

    it("splits comma-separated string", () => {
      expect(toTagList("tag1, tag2, tag3")).toEqual(["tag1", "tag2", "tag3"]);
    });

    it("filters empty values", () => {
      expect(toTagList("tag1, , tag2")).toEqual(["tag1", "tag2"]);
    });

    it("handles array input", () => {
      expect(toTagList(["tag1", "tag2"])).toEqual(["tag1", "tag2"]);
    });

    it("converts numbers to strings", () => {
      expect(toTagList(123)).toEqual(["123"]);
    });
  });

  describe("extractYear", () => {
    it("returns empty for null/undefined", () => {
      expect(extractYear(null)).toBe("");
      expect(extractYear(undefined)).toBe("");
    });

    it("extracts year from ISO string", () => {
      expect(extractYear("2024-06-15")).toBe("2024");
    });

    it("returns empty for invalid date", () => {
      expect(extractYear("not-a-date")).toBe("");
    });
  });

  describe("formatFileSize", () => {
    it("returns dash for non-finite or zero", () => {
      expect(formatFileSize(0)).toBe("-");
      expect(formatFileSize(-1)).toBe("-");
      expect(formatFileSize(NaN)).toBe("-");
    });

    it("formats bytes", () => {
      expect(formatFileSize(500)).toBe("500 B");
    });

    it("formats kilobytes", () => {
      expect(formatFileSize(1024)).toBe("1.0 KB");
      expect(formatFileSize(1536)).toBe("1.5 KB");
    });

    it("formats megabytes", () => {
      expect(formatFileSize(1048576)).toBe("1.0 MB");
    });

    it("formats gigabytes", () => {
      expect(formatFileSize(1073741824)).toBe("1.0 GB");
    });
  });

  describe("formatTimeRead", () => {
    it("returns dash for no reading time", () => {
      expect(formatTimeRead({})).toBe("-");
      expect(formatTimeRead({ reading_seconds: 0 })).toBe("-");
    });

    it("returns minutes only when less than an hour", () => {
      expect(formatTimeRead({ reading_seconds: 300 })).toBe("5m");
    });

    it("returns hours only when exactly on hour", () => {
      expect(formatTimeRead({ reading_seconds: 3600 })).toBe("1h");
    });

    it("returns hours and minutes", () => {
      expect(formatTimeRead({ reading_seconds: 3660 })).toBe("1h 1m");
    });

    it("returns dash for invalid seconds", () => {
      expect(formatTimeRead({ reading_seconds: NaN })).toBe("-");
    });
  });

  describe("formatDate", () => {
    it("returns empty for null/undefined", () => {
      expect(formatDate(null)).toBe("");
      expect(formatDate(undefined)).toBe("");
    });

    it("returns empty for invalid date", () => {
      expect(formatDate("not-a-date")).toBe("");
    });

    it("formats valid date", () => {
      const result = formatDate("2024-06-15");
      expect(result).toContain("Jun");
      expect(result).toContain("15");
      expect(result).toContain("2024");
    });
  });
});