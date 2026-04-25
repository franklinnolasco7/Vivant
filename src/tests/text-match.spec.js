import { describe, expect, it } from "vitest";
import { normalizeSearchString, normalizeTextForMatch, normalizeAnnotationString, normalizeMatchChar, longestCommonSubstring } from "../text-match.js";

describe("text-match.js", () => {
  describe("normalizeSearchString", () => {
    it("trims whitespace", () => {
      expect(normalizeSearchString("  hello  ")).toBe("hello");
    });

    it("collapses multiple spaces", () => {
      expect(normalizeSearchString("hello    world")).toBe("hello world");
    });

    it("normalizes unicode punctuation", () => {
      expect(normalizeSearchString("Hello – World")).toBe("Hello - World");
    });
  });

  describe("normalizeTextForMatch", () => {
    it("trims whitespace", () => {
      expect(normalizeTextForMatch("  hello  ")).toBe("hello");
    });

    it("collapses multiple spaces", () => {
      expect(normalizeTextForMatch("hello    world")).toBe("hello world");
    });

    it("strips punctuation when option enabled", () => {
      expect(normalizeTextForMatch("Hello, World!", { stripPunct: true })).toBe("Hello World");
    });

    it("keeps punctuation when option disabled", () => {
      expect(normalizeTextForMatch("Hello, World!", { stripPunct: false })).toBe("Hello, World!");
    });

    it("normalizes unicode quotes", () => {
      expect(normalizeTextForMatch("\u201CHello\u201D")).toBe('"Hello"');
    });
  });

  describe("normalizeAnnotationString", () => {
    it("strips punctuation including smart quotes (stripPunct removes them)", () => {
      expect(normalizeAnnotationString('"Hello"')).toBe("Hello");
      expect(normalizeAnnotationString("'Hello'")).toBe("Hello");
    });

    it("normalizes ellipsis to space (punctuation stripped)", () => {
      expect(normalizeAnnotationString("Hello... world")).toBe("Hello world");
    });

    it("collapses whitespace", () => {
      expect(normalizeAnnotationString("Hello    world")).toBe("Hello world");
    });

    it("trims", () => {
      expect(normalizeAnnotationString("  Hello  ")).toBe("Hello");
    });
  });

  describe("normalizeMatchChar", () => {
    it("converts nbsp to space", () => {
      expect(normalizeMatchChar("\u00A0")).toBe(" ");
    });

    it("removes soft hyphen and zero width chars", () => {
      expect(normalizeMatchChar("\u00AD")).toBe("");
      expect(normalizeMatchChar("\u200B")).toBe("");
      expect(normalizeMatchChar("\uFEFF")).toBe("");
    });

    it("normalizes smart quotes", () => {
      expect(normalizeMatchChar("\u201C")).toBe('"');
      expect(normalizeMatchChar("\u201D")).toBe('"');
      expect(normalizeMatchChar("\u2018")).toBe("'");
      expect(normalizeMatchChar("\u2019")).toBe("'");
    });

    it("normalizes dashes", () => {
      expect(normalizeMatchChar("\u2013")).toBe("-");
      expect(normalizeMatchChar("\u2014")).toBe("-");
      expect(normalizeMatchChar("\u2212")).toBe("-");
    });
  });

  describe("longestCommonSubstring", () => {
    it("returns 0 for empty input", () => {
      expect(longestCommonSubstring("", "abc")).toBe(0);
      expect(longestCommonSubstring("abc", "")).toBe(0);
    });

    it("returns length when one is substring", () => {
      expect(longestCommonSubstring("hello", "hello world")).toBe(5);
    });

    it("finds common substring length", () => {
      expect(longestCommonSubstring("abcdef", "xyzdef")).toBe(3);
    });

    it("returns first match when multiple equal length", () => {
      expect(longestCommonSubstring("abxyz", "cdxyz")).toBe(3);
    });
  });
});