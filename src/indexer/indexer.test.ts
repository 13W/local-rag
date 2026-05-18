import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeIndexer } from "./indexer.js";

describe("CodeIndexer.shouldSkip — git worktrees", () => {
  it("skips paths inside a registered git worktree", () => {
    const tmp = mkdtempSync(join(tmpdir(), "local-rag-wt-"));
    try {
      const repo = join(tmp, "repo");
      const wt = join(repo, ".worktrees", "wt1");

      mkdirSync(join(repo, ".git", "worktrees", "wt1"), { recursive: true });
      // gitdir content points to the worktree's .git file
      writeFileSync(join(repo, ".git", "worktrees", "wt1", "gitdir"), `${wt}/.git\n`);
      mkdirSync(join(wt, "src"), { recursive: true });
      mkdirSync(join(repo, "src"), { recursive: true });

      const indexer = new CodeIndexer({
        projectId: "test",
        projectRoot: repo,
        includePaths: [],
      });

      expect(indexer.shouldSkip(join(wt, "src", "foo.ts"))).toBe(true);
      expect(indexer.shouldSkip(join(repo, "src", "foo.ts"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("CodeIndexer.indexFile", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not leak unhandledRejection when _indexFileImpl rejects", async () => {
    const indexer = new CodeIndexer({
      projectId:   "test",
      projectRoot: "/tmp/does-not-matter",
      includePaths: [],
    });

    const impl = vi
      .spyOn(indexer as unknown as { _indexFileImpl: () => Promise<[number, number]> }, "_indexFileImpl")
      .mockRejectedValue(new TypeError("fetch failed"));

    const listener = vi.fn();
    process.on("unhandledRejection", listener);

    try {
      await expect(indexer.indexFile("/tmp/does-not-matter/foo.ts", "/tmp/does-not-matter"))
        .rejects.toThrow(/fetch failed/);

      // Give Node's microtask queue a chance to surface a missed rejection.
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));

      expect(listener).not.toHaveBeenCalled();
      expect(impl).toHaveBeenCalledTimes(1);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});
