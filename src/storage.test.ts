import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRetrieve, mockSetPayload, mockScroll } = vi.hoisted(() => ({
  mockRetrieve: vi.fn(),
  mockSetPayload: vi.fn(),
  mockScroll: vi.fn(),
}));

vi.mock("./qdrant.js", () => ({
  qd: {
    retrieve:   mockRetrieve,
    setPayload: mockSetPayload,
    scroll:     mockScroll,
  },
  colName: (base: string) => base,
}));
vi.mock("./config.js", () => ({
  getCurrentBranchCached: vi.fn(() => "main"),
}));

import {
  insertMeta,
  getMemoryMeta,
  deleteById,
  incrementAccess,
  topAccessed,
  setDeps,
  getDeps,
  getReverseDeps,
  getTransitiveDeps,
  setProjectOverview,
  getProjectOverview,
  clearDeps,
  topFilesByRevDeps,
} from "./storage.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── no-op functions ───────────────────────────────────────────────────────────

describe("insertMeta", () => {
  it("resolves without throwing", async () => {
    await expect(insertMeta({
      id: "x", projectId: "p", memoryType: "episodic",
      scope: "project", importance: 0.5, createdAt: "", expiresAt: null,
      tags: "", contentHash: "",
    })).resolves.toBeUndefined();
  });
});

describe("deleteById", () => {
  it("resolves without throwing", async () => {
    await expect(deleteById("any-id")).resolves.toBeUndefined();
  });
});

describe("setDeps / clearDeps", () => {
  it("setDeps is a no-op", async () => {
    await expect(setDeps("p", "f", [])).resolves.toBeUndefined();
  });
  it("clearDeps is a no-op", async () => {
    await expect(clearDeps("p", "f")).resolves.toBeUndefined();
  });
});

describe("project overview stubs", () => {
  it("setProjectOverview is a no-op", async () => {
    await expect(setProjectOverview("p", "overview")).resolves.toBeUndefined();
  });
  it("getProjectOverview always returns null", async () => {
    expect(await getProjectOverview("p")).toBeNull();
  });
});

// ── getMemoryMeta ─────────────────────────────────────────────────────────────

describe("getMemoryMeta", () => {
  it("returns null when point not found in any collection", async () => {
    mockRetrieve.mockResolvedValue([]);
    const result = await getMemoryMeta("missing-id");
    expect(result).toBeNull();
  });

  it("returns memoryType and projectId when point exists", async () => {
    mockRetrieve.mockImplementation((col: string) => {
      if (col === "memory_episodic") {
        return Promise.resolve([{
          id: "abc",
          payload: { memory_type: "episodic", project_id: "proj-1" },
        }]);
      }
      return Promise.resolve([]);
    });

    const result = await getMemoryMeta("abc");
    expect(result).toEqual({ memoryType: "episodic", projectId: "proj-1" });
  });

  it("derives memoryType from collection name when payload has no memory_type", async () => {
    mockRetrieve.mockImplementation((col: string) => {
      if (col === "memory_semantic") {
        return Promise.resolve([{
          id: "abc",
          payload: { project_id: "proj-1" },
        }]);
      }
      return Promise.resolve([]);
    });

    const result = await getMemoryMeta("abc");
    expect(result).toEqual({ memoryType: "semantic", projectId: "proj-1" });
  });

  it("skips points with no project_id", async () => {
    mockRetrieve.mockResolvedValue([{
      id: "x",
      payload: { memory_type: "episodic" },
    }]);
    const result = await getMemoryMeta("x");
    expect(result).toBeNull();
  });

  it("returns null when retrieve throws", async () => {
    mockRetrieve.mockRejectedValue(new Error("connection refused"));
    const result = await getMemoryMeta("y");
    expect(result).toBeNull();
  });
});

// ── incrementAccess ───────────────────────────────────────────────────────────

describe("incrementAccess", () => {
  it("increments access_count when point found", async () => {
    mockRetrieve.mockImplementation((col: string) => {
      if (col === "memory_episodic") {
        return Promise.resolve([{ id: "id1", payload: { access_count: 3 } }]);
      }
      return Promise.resolve([]);
    });
    mockSetPayload.mockResolvedValue({});

    await incrementAccess("id1", "proj", "episodic", "2026-01-01T00:00:00Z");

    expect(mockSetPayload).toHaveBeenCalledWith(
      "memory_episodic",
      expect.objectContaining({
        payload: expect.objectContaining({ access_count: 4 }),
        points: ["id1"],
      })
    );
  });

  it("starts from 1 when access_count is absent", async () => {
    mockRetrieve.mockImplementation((col: string) => {
      if (col === "memory_episodic") {
        return Promise.resolve([{ id: "id2", payload: {} }]);
      }
      return Promise.resolve([]);
    });
    mockSetPayload.mockResolvedValue({});

    await incrementAccess("id2", "proj", "episodic", "now");

    expect(mockSetPayload).toHaveBeenCalledWith(
      "memory_episodic",
      expect.objectContaining({ payload: expect.objectContaining({ access_count: 1 }) })
    );
  });

  it("does nothing when point not found", async () => {
    mockRetrieve.mockResolvedValue([]);
    await incrementAccess("missing", "proj", "episodic", "now");
    expect(mockSetPayload).not.toHaveBeenCalled();
  });
});

// ── topAccessed ───────────────────────────────────────────────────────────────

describe("topAccessed", () => {
  it("returns entries sorted by access_count descending", async () => {
    mockScroll.mockImplementation((col: string) => {
      if (col === "memory_episodic") {
        return Promise.resolve({
          points: [
            { id: "a", payload: { access_count: 10 } },
            { id: "b", payload: { access_count: 5 } },
          ],
          next_page_offset: null,
        });
      }
      return Promise.resolve({ points: [], next_page_offset: null });
    });

    const result = await topAccessed("proj");
    expect(result[0]!.accessCount).toBe(10);
    expect(result[1]!.accessCount).toBe(5);
  });

  it("filters out entries with access_count = 0", async () => {
    mockScroll.mockResolvedValue({
      points: [{ id: "z", payload: { access_count: 0 } }],
      next_page_offset: null,
    });

    const result = await topAccessed("proj");
    expect(result).toHaveLength(0);
  });

  it("caps results at 5", async () => {
    mockScroll.mockImplementation((col: string) => {
      if (col === "memory_episodic") {
        return Promise.resolve({
          points: Array.from({ length: 10 }, (_, i) => ({
            id: String(i),
            payload: { access_count: 10 - i },
          })),
          next_page_offset: null,
        });
      }
      return Promise.resolve({ points: [], next_page_offset: null });
    });

    const result = await topAccessed("proj");
    expect(result).toHaveLength(5);
  });
});

// ── getDeps ───────────────────────────────────────────────────────────────────

describe("getDeps", () => {
  it("returns imports array from first chunk payload", async () => {
    mockScroll.mockResolvedValue({
      points: [{ id: "c1", payload: { imports: ["src/util", "src/config"] } }],
    });

    const deps = await getDeps("proj", "src/indexer/parser.ts");
    expect(deps).toEqual(["src/util", "src/config"]);
  });

  it("returns empty array when no chunks found", async () => {
    mockScroll.mockResolvedValue({ points: [] });
    const deps = await getDeps("proj", "src/missing.ts");
    expect(deps).toHaveLength(0);
  });

  it("returns empty array when imports field is absent", async () => {
    mockScroll.mockResolvedValue({
      points: [{ id: "c2", payload: {} }],
    });
    const deps = await getDeps("proj", "src/foo.ts");
    expect(deps).toHaveLength(0);
  });
});

// ── topFilesByRevDeps ─────────────────────────────────────────────────────────

describe("topFilesByRevDeps", () => {
  it("returns empty array for empty filePaths input", async () => {
    const result = await topFilesByRevDeps("proj", [], 5);
    expect(result).toHaveLength(0);
  });

  it("counts files by how many chunks import them", async () => {
    mockScroll.mockResolvedValue({
      points: [
        { id: "1", payload: { imports: ["src/util.ts"] } },
        { id: "2", payload: { imports: ["src/util.ts", "src/config.ts"] } },
        { id: "3", payload: { imports: ["src/config.ts"] } },
      ],
      next_page_offset: null,
    });

    const result = await topFilesByRevDeps("proj", ["src/util.ts", "src/config.ts"], 5);
    expect(result[0]!.count).toBe(2);
    expect(result[1]!.count).toBe(2);
  });
});
