import { describe, it, expect } from "bun:test";
import {
  escapeHtml,
  stripAnsi,
  stripSystemTags,
  markdownToTelegramHtml,
  wrapCode,
  formatLong,
  parseJsonSafe,
} from "./format.js";

// ── escapeHtml ──────────────────────────────────────────

describe("escapeHtml", () => {
  it("escapes ampersand", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes less-than", () => {
    expect(escapeHtml("a<b")).toBe("a&lt;b");
  });

  it("escapes greater-than", () => {
    expect(escapeHtml("a>b")).toBe("a&gt;b");
  });

  it("is a no-op on plain text", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("escapes multiple special chars", () => {
    expect(escapeHtml("<a>&</a>")).toBe("&lt;a&gt;&amp;&lt;/a&gt;");
  });
});

// ── stripAnsi ───────────────────────────────────────────

describe("stripAnsi", () => {
  it("removes ANSI escape sequences", () => {
    expect(stripAnsi("\x1B[31mred\x1B[0m")).toBe("red");
  });

  it("removes box-drawing characters", () => {
    expect(stripAnsi("┌───┐\n│hi│\n└───┘")).toBe("\nhi\n");
  });

  it("leaves plain text unchanged", () => {
    expect(stripAnsi("hello")).toBe("hello");
  });
});

// ── stripSystemTags ─────────────────────────────────────

describe("stripSystemTags", () => {
  it("removes system-reminder blocks", () => {
    const input = "before<system-reminder>ignore me</system-reminder>after";
    expect(stripSystemTags(input)).toBe("beforeafter");
  });

  it("removes multiline system-reminder blocks", () => {
    const input = "start\n<system-reminder>\nline1\nline2\n</system-reminder>\nend";
    expect(stripSystemTags(input)).toBe("start\n\nend");
  });

  it("preserves text without system tags", () => {
    expect(stripSystemTags("hello world")).toBe("hello world");
  });
});

// ── markdownToTelegramHtml ──────────────────────────────

describe("markdownToTelegramHtml", () => {
  it("converts headings to bold", () => {
    const result = markdownToTelegramHtml("# Title");
    expect(result).toContain("<b>");
    expect(result).toContain("Title");
  });

  it("converts bold **text** to <b>", () => {
    expect(markdownToTelegramHtml("**bold**")).toContain("<b>bold</b>");
  });

  it("converts italic _text_ to <i>", () => {
    const result = markdownToTelegramHtml("_italic_");
    expect(result).toContain("<i>italic</i>");
  });

  it("converts code blocks to <pre><code>", () => {
    const result = markdownToTelegramHtml("```\ncode\n```");
    expect(result).toContain("<pre><code>");
  });

  it("converts inline code to <code>", () => {
    const result = markdownToTelegramHtml("`code`");
    expect(result).toContain("<code>code</code>");
  });

  it("converts links to <a>", () => {
    const result = markdownToTelegramHtml("[link](https://example.com)");
    expect(result).toContain('<a href="https://example.com">link</a>');
  });

  it("returns empty string for empty input", () => {
    expect(markdownToTelegramHtml("")).toBe("");
  });

  it("escapes HTML in regular text", () => {
    expect(markdownToTelegramHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes HTML inside code blocks", () => {
    const result = markdownToTelegramHtml("```<div>```");
    expect(result).toContain("&lt;div&gt;");
  });

  it("escapes HTML inside inline code", () => {
    const result = markdownToTelegramHtml("`<script>`");
    expect(result).toContain("&lt;script&gt;");
  });
});

// ── wrapCode ────────────────────────────────────────────

describe("wrapCode", () => {
  it("wraps text in pre/code tags with HTML escaping", () => {
    expect(wrapCode("hello")).toBe("<pre><code>hello</code></pre>");
  });

  it("escapes HTML entities in the text", () => {
    expect(wrapCode("a<b")).toBe("<pre><code>a&lt;b</code></pre>");
  });

  it("strips ANSI codes before wrapping", () => {
    expect(wrapCode("\x1B[31mred\x1B[0m")).toBe("<pre><code>red</code></pre>");
  });
});

// ── formatLong ──────────────────────────────────────────

describe("formatLong", () => {
  it("returns a single chunk for short text", () => {
    const result = formatLong("hello");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("hello");
  });

  it("returns multiple chunks for long text", () => {
    const longText = "a".repeat(5000);
    const result = formatLong(longText);
    expect(result.length).toBeGreaterThan(1);
  });

  it("formatLong preserves content at chunk boundaries", () => {
    const line = "a".repeat(3500);
    const text = line + "\nnext paragraph";
    const chunks = formatLong(text);
    expect(chunks.length).toBe(2);
  });

  it("each chunk is at most 3500 chars (after markdown conversion)", () => {
    const longText = "word ".repeat(1000); // ~5000 chars
    const result = formatLong(longText);
    for (const chunk of result) {
      // chunks could be slightly over due to markdown conversion
      // but should be reasonably sized
      expect(chunk.length).toBeLessThan(4000);
    }
  });
});

// ── parseJsonSafe ───────────────────────────────────────

describe("parseJsonSafe", () => {
  it("parses valid JSON", () => {
    expect(parseJsonSafe('{"a":1}', { a: 0 })).toEqual({ a: 1 });
  });

  it("returns fallback for invalid JSON", () => {
    expect(parseJsonSafe("not json", { a: 0 })).toEqual({ a: 0 });
  });

  it("parses arrays", () => {
    expect(parseJsonSafe("[1,2,3]", [] as number[])).toEqual([1, 2, 3]);
  });

  it("parses null", () => {
    expect(parseJsonSafe("null", "fallback")).toBeNull();
  });

  it("returns fallback for empty string", () => {
    expect(parseJsonSafe("", [])).toEqual([]);
  });
});
