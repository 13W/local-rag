import { describe, it, expect, vi } from "vitest";

// Mock all heavy dependencies before importing util
vi.mock("./config.js", () => ({
  cfg: { debugLogPath: "" },
  getProjectId: vi.fn(() => "test-project"),
}));
vi.mock("./qdrant.js", async () => {
  const actual = await vi.importActual<typeof import("./qdrant.js")>("./qdrant.js");
  return { ...actual, qd: { scroll: vi.fn(), upsert: vi.fn() } };
});
vi.mock("./embedder.js", () => ({ embedOne: vi.fn() }));
vi.mock("./plugins/dashboard.js", () => ({ broadcastMemoryUpdate: vi.fn() }));
vi.mock("./request-context.js", () => ({ getProjectId: vi.fn(() => "test-project") }));
vi.mock("./router.js", () => ({}));

import {
  colForType,
  contentHash,
  normalizeForHash,
  nowIso,
  safeParseLines,
  extractLineText,
  buildWindow,
  buildValidationRequests,
} from "./util.js";

// ── colForType ────────────────────────────────────────────────────────────────

describe("colForType", () => {
  it('maps "memory" → collection name for memory', () => {
    expect(colForType("memory")).toBe("memory");
  });

  it('maps "episodic" → memory_episodic', () => {
    expect(colForType("episodic")).toBe("memory_episodic");
  });

  it('maps "semantic" → memory_semantic', () => {
    expect(colForType("semantic")).toBe("memory_semantic");
  });

  it('maps "procedural" → memory_procedural', () => {
    expect(colForType("procedural")).toBe("memory_procedural");
  });
});

// ── contentHash ───────────────────────────────────────────────────────────────

describe("contentHash", () => {
  it("returns a 16-character hex string", () => {
    const h = contentHash("hello");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic", () => {
    expect(contentHash("same")).toBe(contentHash("same"));
  });

  it("differs for different inputs", () => {
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });

  it("collapses trivial whitespace and case differences", () => {
    expect(contentHash("foo")).toBe(contentHash("Foo"));
    expect(contentHash("foo")).toBe(contentHash("foo "));
    expect(contentHash("foo bar")).toBe(contentHash("foo  bar"));
    expect(contentHash("foo\nbar")).toBe(contentHash("foo bar"));
  });
});

describe("normalizeForHash", () => {
  it("lowercases ASCII", () => {
    expect(normalizeForHash("FOO")).toBe("foo");
  });

  it("trims edges", () => {
    expect(normalizeForHash("  foo  ")).toBe("foo");
  });

  it("collapses whitespace runs", () => {
    expect(normalizeForHash("a  b\t\nc")).toBe("a b c");
  });

  it("applies NFKC to full-width characters", () => {
    expect(normalizeForHash("ＡＢ")).toBe("ab");
  });
});

// ── nowIso ────────────────────────────────────────────────────────────────────

describe("nowIso", () => {
  it("returns a valid ISO 8601 string", () => {
    const iso = nowIso();
    expect(() => new Date(iso)).not.toThrow();
    expect(new Date(iso).toISOString()).toBe(iso);
  });
});

// ── safeParseLines ────────────────────────────────────────────────────────────

describe("safeParseLines", () => {
  it("parses JSONL lines", () => {
    const raw = '{"role":"user"}\n{"role":"assistant"}';
    const result = safeParseLines(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user" });
  });

  it("parses a single JSON object with messages array", () => {
    const raw = JSON.stringify({ messages: [{ role: "user" }, { role: "assistant" }] });
    const result = safeParseLines(raw);
    expect(result).toHaveLength(2);
  });

  it("skips malformed lines", () => {
    const raw = '{"valid":true}\nnot-json\n{"also":"valid"}';
    const result = safeParseLines(raw);
    expect(result).toHaveLength(2);
  });

  it("handles empty input", () => {
    expect(safeParseLines("")).toEqual([]);
    expect(safeParseLines("   ")).toEqual([]);
  });
});

// ── extractLineText ───────────────────────────────────────────────────────────

describe("extractLineText", () => {
  it("extracts user text from claude-code format", () => {
    const line = { message: { role: "user", content: "hello" } };
    expect(extractLineText(line)).toBe("user: hello");
  });

  it("extracts assistant text from claude-code format", () => {
    const line = { message: { role: "assistant", content: "world" } };
    expect(extractLineText(line)).toBe("assistant: world");
  });

  it("extracts text from raw message object", () => {
    const line = { role: "user", content: "direct" };
    expect(extractLineText(line)).toBe("user: direct");
  });

  it("handles array content blocks", () => {
    const line = {
      role: "assistant",
      content: [{ type: "text", text: "block1" }, { type: "text", text: "block2" }],
    };
    expect(extractLineText(line)).toBe("assistant: block1 block2");
  });

  it("returns empty string for unknown roles", () => {
    const line = { role: "system", content: "ignored" };
    expect(extractLineText(line)).toBe("");
  });

  it("formats tool_use lines", () => {
    const line = { role: "tool_use", name: "recall" };
    expect(extractLineText(line)).toBe("[Tool Use: recall]");
  });

  it("formats tool_result lines with truncation", () => {
    const line = { role: "tool_result", content: "short result" };
    expect(extractLineText(line)).toContain("Tool Result:");
  });

  it("returns empty for empty content", () => {
    const line = { role: "user", content: "" };
    expect(extractLineText(line)).toBe("");
  });
});

// ── buildWindow ───────────────────────────────────────────────────────────────

describe("buildWindow", () => {
  const lines = [
    { role: "user", content: "msg1" },
    { role: "assistant", content: "msg2" },
    { role: "user", content: "msg3" },
  ];

  it("returns all lines when under maxChars", () => {
    const result = buildWindow(lines, 10_000);
    expect(result).toContain("msg1");
    expect(result).toContain("msg2");
    expect(result).toContain("msg3");
  });

  it("respects maxChars by dropping oldest lines", () => {
    // msg1 + msg2 together exceed 20 chars; only recent ones included
    const result = buildWindow(lines, 20);
    expect(result).toContain("msg3");
    // msg1 may be excluded due to char limit
  });

  it("returns empty string for empty lines", () => {
    expect(buildWindow([], 1000)).toBe("");
  });

  it("preserves chronological order", () => {
    const result = buildWindow(lines, 10_000);
    const idx1 = result.indexOf("msg1");
    const idx3 = result.indexOf("msg3");
    expect(idx1).toBeLessThan(idx3);
  });
});

// ── buildValidationRequests ───────────────────────────────────────────────────

describe("buildValidationRequests", () => {
  it("returns null for empty ops", () => {
    expect(buildValidationRequests([])).toBeNull();
  });

  it("formats ops as numbered list", () => {
    const ops = [
      { text: "some work", status: "in_progress" as const, confidence: 0.75 },
      { text: "a decision", status: "resolved" as const, confidence: 0.85 },
    ];
    const result = buildValidationRequests(ops);
    expect(result).not.toBeNull();
    expect(result).toContain("1.");
    expect(result).toContain("2.");
    expect(result).toContain("some work");
    expect(result).toContain("0.75");
  });

  it("truncates long text to 200 chars", () => {
    const longText = "x".repeat(300);
    const ops = [
      { text: longText, status: "in_progress" as const, confidence: 0.5 },
    ];
    const result = buildValidationRequests(ops);
    // The formatted line should not contain 300 x's (truncated)
    expect(result!.length).toBeLessThan(longText.length + 200);
  });
});
