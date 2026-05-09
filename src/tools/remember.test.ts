import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockStoreMemory } = vi.hoisted(() => ({
  mockStoreMemory: vi.fn(),
}));

vi.mock("../util.js", () => ({
  storeMemory: mockStoreMemory,
}));

import { rememberTool } from "./remember.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("rememberTool", () => {
  it("delegates to storeMemory with mapped arguments", async () => {
    mockStoreMemory.mockResolvedValue("stored: abc");

    const result = await rememberTool({
      content: "auth tokens are stored in Redis",
      memory_type: "episodic",
      scope: "project",
      tags: "auth,redis",
      importance: 0.8,
      ttl_hours: 24,
    });

    expect(mockStoreMemory).toHaveBeenCalledWith({
      content:    "auth tokens are stored in Redis",
      memoryType: "episodic",
      scope:      "project",
      tags:       "auth,redis",
      importance: 0.8,
      ttlHours:   24,
      source:     "mcp",
    });
    expect(result).toBe("stored: abc");
  });

  it("passes through scope and memory_type as-is", async () => {
    mockStoreMemory.mockResolvedValue("ok");

    await rememberTool({
      content: "x",
      memory_type: "semantic",
      scope: "agent",
      tags: "",
      importance: 0.5,
      ttl_hours: 0,
    });

    expect(mockStoreMemory).toHaveBeenCalledWith(
      expect.objectContaining({ memoryType: "semantic", scope: "agent" })
    );
  });

  it("returns whatever storeMemory returns", async () => {
    mockStoreMemory.mockResolvedValue("stored: uuid-999");
    const result = await rememberTool({
      content: "y", memory_type: "procedural", scope: "global",
      tags: "", importance: 0.5, ttl_hours: 0,
    });
    expect(result).toBe("stored: uuid-999");
  });
});
