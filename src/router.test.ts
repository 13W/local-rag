import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCallLlmTool } = vi.hoisted(() => ({
  mockCallLlmTool: vi.fn(),
}));

vi.mock("./llm-client.js", () => ({
  callLlmTool: mockCallLlmTool,
  defaultRouterSpec: vi.fn(() => ({
    provider: "ollama",
    model: "gemma3n:e2b",
  })),
}));
vi.mock("./config.js", () => ({
  cfg: { routerConfig: null, debugLogPath: "" },
}));
vi.mock("./util.js", () => ({
  debugLog: vi.fn(),
}));

import { runRouter, looksLikeReasoning, hasCJKLeak } from "./router.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runRouter", () => {
  it("returns empty array when LLM returns null", async () => {
    mockCallLlmTool.mockResolvedValue(null);
    const result = await runRouter("transcript");
    expect(result).toEqual([]);
  });

  it("returns empty array when operations is missing", async () => {
    mockCallLlmTool.mockResolvedValue({ other: "field" });
    const result = await runRouter("transcript");
    expect(result).toEqual([]);
  });

  it("returns valid operations with confidence >= 0.5", async () => {
    mockCallLlmTool.mockResolvedValue({
      operations: [
        { text: "Bug found in parser", status: "resolved", confidence: 0.9 },
        { text: "Possible memory leak", status: "open_question", confidence: 0.7 },
      ],
    });

    const result = await runRouter("transcript");
    expect(result).toHaveLength(2);
    expect(result[0]!.text).toBe("Bug found in parser");
    expect(result[0]!.status).toBe("resolved");
    expect(result[0]!.confidence).toBe(0.9);
  });

  it("filters out operations with invalid status", async () => {
    mockCallLlmTool.mockResolvedValue({
      operations: [
        { text: "valid", status: "resolved", confidence: 0.8 },
        { text: "bad", status: "unknown_status", confidence: 0.9 },
      ],
    });

    const result = await runRouter("transcript");
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("valid");
  });

  it("filters out operations with confidence < 0.5", async () => {
    mockCallLlmTool.mockResolvedValue({
      operations: [
        { text: "low confidence", status: "resolved", confidence: 0.3 },
        { text: "borderline", status: "resolved", confidence: 0.49 },
        { text: "high confidence", status: "in_progress", confidence: 0.8 },
      ],
    });

    const result = await runRouter("transcript");
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("high confidence");
  });

  it("drops reasoning-leak entries from router output", async () => {
    mockCallLlmTool.mockResolvedValue({
      operations: [
        { text: "(Wait, the user is asking in Russian, I should...)", status: "observation", confidence: 0.8 },
        { text: "Hmm, let me think about this", status: "observation", confidence: 0.8 },
        { text: "The user is testing the memory system", status: "observation", confidence: 0.8 },
        { text: "I should check if recall returned anything", status: "observation", confidence: 0.8 },
        { text: "사용자가 요청한 작업", status: "observation", confidence: 0.8 },
        { text: "Bug fixed in src/util.ts: contentHash now normalizes whitespace", status: "resolved", confidence: 0.8 },
      ],
    });

    const result = await runRouter("transcript");
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toContain("contentHash");
  });
});

describe("looksLikeReasoning", () => {
  it("matches parenthetical Wait", () => {
    expect(looksLikeReasoning("(Wait, the user is asking...)")).toBe(true);
  });

  it("matches Hmm/Let me think", () => {
    expect(looksLikeReasoning("Hmm, that's interesting")).toBe(true);
    expect(looksLikeReasoning("Let me think about this")).toBe(true);
  });

  it("matches narration about the user", () => {
    expect(looksLikeReasoning("The user is testing memory")).toBe(true);
    expect(looksLikeReasoning("The user wants to know X")).toBe(true);
  });

  it("matches first-person agent narration", () => {
    expect(looksLikeReasoning("I should check the docs")).toBe(true);
    expect(looksLikeReasoning("I will analyse this")).toBe(true);
  });

  it("does not match real memory entries", () => {
    expect(looksLikeReasoning("Bug fixed in parser.ts")).toBe(false);
    expect(looksLikeReasoning("Architectural decision: use Qdrant")).toBe(false);
    expect(looksLikeReasoning("Problem: import fails on Windows")).toBe(false);
  });
});

describe("hasCJKLeak", () => {
  it("detects Korean text", () => {
    expect(hasCJKLeak("사용자가 요청한 작업입니다")).toBe(true);
  });

  it("detects Japanese text", () => {
    expect(hasCJKLeak("これはテストです、長い文章")).toBe(true);
  });

  it("detects Chinese text", () => {
    expect(hasCJKLeak("这是一个测试句子很长")).toBe(true);
  });

  it("ignores ascii / cyrillic", () => {
    expect(hasCJKLeak("Bug fixed in parser.ts")).toBe(false);
    expect(hasCJKLeak("Архитектурное решение: использовать Qdrant")).toBe(false);
  });

  it("tolerates short CJK substrings", () => {
    expect(hasCJKLeak("Tested with input 测 stub")).toBe(false);
  });

  it("filters out operations with empty text", async () => {
    mockCallLlmTool.mockResolvedValue({
      operations: [
        { text: "", status: "resolved", confidence: 0.9 },
        { text: "  ", status: "resolved", confidence: 0.9 },
        { text: "good", status: "resolved", confidence: 0.9 },
      ],
    });

    const result = await runRouter("transcript");
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("good");
  });

  it("returns empty array when LLM throws and no fallback", async () => {
    mockCallLlmTool.mockRejectedValue(new Error("timeout"));
    const result = await runRouter("transcript");
    expect(result).toEqual([]);
  });

  it("accepts all valid status values", async () => {
    const statuses = ["in_progress", "resolved", "open_question", "hypothesis", "observation"];
    mockCallLlmTool.mockResolvedValue({
      operations: statuses.map((s) => ({ text: `text for ${s}`, status: s, confidence: 0.8 })),
    });

    const result = await runRouter("transcript");
    expect(result).toHaveLength(statuses.length);
  });

  it("handles non-array operations gracefully", async () => {
    mockCallLlmTool.mockResolvedValue({ operations: "not-an-array" });
    const result = await runRouter("transcript");
    expect(result).toEqual([]);
  });
});
