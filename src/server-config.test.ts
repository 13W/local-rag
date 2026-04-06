import { describe, it, expect } from "vitest";
import { mergeServerConfig, mergeProjectConfig } from "./server-config.js";

describe("mergeServerConfig", () => {
  it("fills missing fields with defaults", () => {
    const cfg = mergeServerConfig({});
    expect(cfg.port).toBe(7531);
    expect(cfg.embed.provider).toBe("ollama");
    expect(cfg.llm.provider).toBe("ollama");
    expect(cfg.collection_prefix).toBe("");
  });

  it("overrides defaults with provided values", () => {
    const cfg = mergeServerConfig({ port: 9000, collection_prefix: "test" });
    expect(cfg.port).toBe(9000);
    expect(cfg.collection_prefix).toBe("test");
  });
});

describe("mergeProjectConfig", () => {
  it("returns default project with provided project_id", () => {
    const p = mergeProjectConfig({ project_id: "myproj" });
    expect(p.project_id).toBe("myproj");
    expect(p.indexer_state).toBe("stopped");
    expect(p.include_paths).toEqual([]);
  });
});
