import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "local-rag-test-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true }); });

describe("local-config", () => {
  it("returns defaults when file does not exist", async () => {
    const { readLocalConfig } = await import("./local-config.js");
    const cfg = await readLocalConfig(join(tmpDir, "config.json"));
    expect(cfg.qdrant.url).toBe("http://localhost:6333");
    expect(cfg.port).toBe(7531);
  });

  it("round-trips write/read", async () => {
    const { readLocalConfig, writeLocalConfig } = await import("./local-config.js");
    const path = join(tmpDir, "config.json");
    await writeLocalConfig(path, {
      qdrant: { url: "http://myqdrant:6333", api_key: "tok", tls: false, prefix: "" },
      port: 8080,
    });
    const cfg = await readLocalConfig(path);
    expect(cfg.qdrant.url).toBe("http://myqdrant:6333");
    expect(cfg.port).toBe(8080);
  });
});
