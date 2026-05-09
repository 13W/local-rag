import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StoreMemoryParams } from "./types.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// vi.hoisted ensures these are available when vi.mock factories run
const { mockScroll, mockUpsert } = vi.hoisted(() => ({
  mockScroll: vi.fn(),
  mockUpsert: vi.fn(),
}));

vi.mock("./qdrant.js", async () => {
  const actual = await vi.importActual<typeof import("./qdrant.js")>("./qdrant.js");
  return {
    ...actual,
    qd: { scroll: mockScroll, upsert: mockUpsert },
  };
});

const { mockEmbedOne, mockBroadcast } = vi.hoisted(() => ({
  mockEmbedOne: vi.fn(async () => [0.1, 0.2, 0.3]),
  mockBroadcast: vi.fn(),
}));

vi.mock("./embedder.js", () => ({ embedOne: mockEmbedOne }));
vi.mock("./plugins/dashboard.js", () => ({ broadcastMemoryUpdate: mockBroadcast }));

vi.mock("./request-context.js", () => ({ getProjectId: () => "test-proj" }));
vi.mock("./config.js", () => ({ cfg: { debugLogPath: "" }, getProjectId: () => "test-proj" }));
vi.mock("./router.js", () => ({}));

import { storeMemory } from "./util.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function params(overrides: Partial<StoreMemoryParams> = {}): StoreMemoryParams {
  return {
    content: "test content",
    memoryType: "episodic",
    scope: "project",
    tags: "",
    importance: 0.8,
    ttlHours: 0,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no existing entry
  mockScroll.mockResolvedValue({ points: [] });
  mockUpsert.mockResolvedValue({});
});

describe("storeMemory", () => {
  it("rejects invalid memoryType", async () => {
    const result = await storeMemory(params({ memoryType: "invalid" as any }));
    expect(result).toContain("error:");
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("returns 'already exists' when content hash is found", async () => {
    mockScroll.mockResolvedValue({ points: [{ id: "existing-id" }] });

    const result = await storeMemory(params());
    expect(result).toContain("already exists");
    expect(result).toContain("existing-id");
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("upserts to Qdrant and returns stored message for new entry", async () => {
    const result = await storeMemory(params({ memoryType: "episodic", importance: 0.9 }));
    expect(result).toContain("stored [episodic]");
    expect(result).toContain("importance=0.9");
    expect(mockUpsert).toHaveBeenCalledOnce();
  });

  it("uses old schema for episodic/semantic/procedural types", async () => {
    await storeMemory(params({ memoryType: "semantic", content: "a fact" }));
    const call = mockUpsert.mock.calls[0]!;
    const payload = call[1].points[0].payload;
    expect(payload).toHaveProperty("content", "a fact");
    expect(payload).toHaveProperty("memory_type", "semantic");
    expect(payload).not.toHaveProperty("text");
  });

  it("uses new schema for memory type", async () => {
    await storeMemory(params({ memoryType: "memory", content: "new schema content" }));
    const call = mockUpsert.mock.calls[0]!;
    const payload = call[1].points[0].payload;
    expect(payload).toHaveProperty("text", "new schema content");
    expect(payload).toHaveProperty("status");
    expect(payload).not.toHaveProperty("memory_type");
  });

  it("sets expires_at when ttlHours > 0", async () => {
    await storeMemory(params({ memoryType: "episodic", ttlHours: 24 }));
    const payload = mockUpsert.mock.calls[0]![1].points[0].payload;
    expect(payload.expires_at).toBeTruthy();
    const expiresAt = new Date(payload.expires_at).getTime();
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it("leaves expires_at empty when ttlHours=0", async () => {
    await storeMemory(params({ memoryType: "episodic", ttlHours: 0 }));
    const payload = mockUpsert.mock.calls[0]![1].points[0].payload;
    expect(payload.expires_at).toBe("");
  });

  it("splits comma-separated tags into array", async () => {
    await storeMemory(params({ memoryType: "episodic", tags: "alpha, beta, gamma" }));
    const payload = mockUpsert.mock.calls[0]![1].points[0].payload;
    expect(payload.tags).toEqual(["alpha", "beta", "gamma"]);
  });

  it("default status for episodic is in_progress", async () => {
    await storeMemory(params({ memoryType: "episodic" }));
    const payload = mockUpsert.mock.calls[0]![1].points[0].payload;
    expect(payload.status).toBe("in_progress");
  });

  it("default status for semantic is resolved", async () => {
    await storeMemory(params({ memoryType: "semantic" }));
    const payload = mockUpsert.mock.calls[0]![1].points[0].payload;
    expect(payload.status).toBe("resolved");
  });

  it("explicit status overrides the default", async () => {
    await storeMemory(params({ memoryType: "episodic", status: "resolved" }));
    const payload = mockUpsert.mock.calls[0]![1].points[0].payload;
    expect(payload.status).toBe("resolved");
  });

  it("stores the project_id from context", async () => {
    await storeMemory(params({ memoryType: "episodic" }));
    const payload = mockUpsert.mock.calls[0]![1].points[0].payload;
    expect(payload.project_id).toBe("test-proj");
  });

  it("calls broadcastMemoryUpdate after successful store", async () => {
    await storeMemory(params());
    // broadcast is called with void (fire-and-forget)
    // give the microtask queue a tick
    await Promise.resolve();
    expect(mockBroadcast).toHaveBeenCalled();
  });
});
