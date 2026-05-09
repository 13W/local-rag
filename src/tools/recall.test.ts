import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockEmbedOne, mockLlmFilter, mockSearch } = vi.hoisted(() => ({
  mockEmbedOne: vi.fn(),
  mockLlmFilter: vi.fn(),
  mockSearch: vi.fn(),
}));

vi.mock("../embedder.js", () => ({
  embedOne: mockEmbedOne,
  llmFilter: mockLlmFilter,
}));
vi.mock("../qdrant.js", () => ({
  qd: { search: mockSearch },
  colName: (b: string) => b,
}));
vi.mock("../config.js", () => ({
  getProjectId: vi.fn(() => "proj"),
}));
vi.mock("../scoring.js", () => ({
  finalScore: vi.fn((cosine: number) => cosine),
}));
vi.mock("../storage.js", () => ({
  incrementAccess: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../util.js", () => ({
  colForType: (t: string) => (t.startsWith("memory_") ? t : t === "memory" ? t : `memory_${t}`),
  nowIso: vi.fn(() => "2099-01-01T00:00:00Z"),
  debugLog: vi.fn(),
}));

import { recallTool } from "./recall.js";

const baseArgs = {
  query: "auth tokens",
  memory_type: "",
  scope: "",
  tags: "",
  limit: 5,
  min_relevance: 0.3,
  time_decay: false,
  llm_filter: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEmbedOne.mockResolvedValue([0.1, 0.2, 0.3]);
  mockSearch.mockResolvedValue([]);
});

describe("recallTool", () => {
  it("returns 'nothing found' when no results", async () => {
    const result = await recallTool(baseArgs);
    expect(result).toBe("nothing found.");
  });

  it("returns formatted results when hits are found", async () => {
    mockSearch.mockResolvedValue([
      {
        id: "mem-1",
        score: 0.85,
        payload: {
          text: "Use JWT for auth",
          importance: 0.8,
          created_at: "2026-01-01T00:00:00Z",
          tags: ["auth", "jwt"],
        },
      },
    ]);

    const result = await recallTool(baseArgs);
    expect(result).toContain("Found");
    expect(result).toContain("memories");
    expect(result).toContain("Use JWT for auth");
  });

  it("filters out expired memories", async () => {
    mockSearch.mockResolvedValue([
      {
        id: "mem-expired",
        score: 0.9,
        payload: {
          text: "expired memory",
          importance: 0.5,
          created_at: "2020-01-01T00:00:00Z",
          expires_at: "2020-06-01T00:00:00Z",
        },
      },
    ]);

    const result = await recallTool(baseArgs);
    expect(result).toBe("nothing found.");
  });

  it("filters by tags when tags argument is set", async () => {
    mockSearch.mockResolvedValue([
      {
        id: "mem-tagged",
        score: 0.9,
        payload: {
          text: "tagged memory",
          importance: 0.5,
          created_at: "2026-01-01T00:00:00Z",
          tags: ["auth"],
        },
      },
      {
        id: "mem-untagged",
        score: 0.85,
        payload: {
          text: "no tags",
          importance: 0.5,
          created_at: "2026-01-01T00:00:00Z",
          tags: ["other"],
        },
      },
    ]);

    const result = await recallTool({ ...baseArgs, tags: "auth" });
    expect(result).toContain("tagged memory");
    expect(result).not.toContain("no tags");
  });

  it("invokes llm_filter when enabled and results exist", async () => {
    mockSearch.mockResolvedValue([
      {
        id: "m1",
        score: 0.9,
        payload: { text: "mem text", importance: 0.5, created_at: "2026-01-01T00:00:00Z" },
      },
    ]);
    mockLlmFilter.mockResolvedValue([]);

    const result = await recallTool({ ...baseArgs, llm_filter: true });
    expect(mockLlmFilter).toHaveBeenCalled();
    expect(result).toBe("nothing found.");
  });

  it("searches all collections when memory_type is empty", async () => {
    await recallTool(baseArgs);
    expect(mockSearch.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("searches only specified collection when memory_type is set", async () => {
    await recallTool({ ...baseArgs, memory_type: "episodic" });
    expect(mockSearch.mock.calls.length).toBe(1);
  });

  it("applies scope filter to Qdrant query when scope is set", async () => {
    await recallTool({ ...baseArgs, scope: "agent" });
    const call = mockSearch.mock.calls[0]!;
    const options = call[1] as any;
    expect(JSON.stringify(options.filter)).toContain("scope");
    expect(JSON.stringify(options.filter)).toContain("agent");
  });
});
