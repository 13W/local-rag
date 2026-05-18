import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, extname, basename } from "node:path";
import { createHash } from "node:crypto";
import { cfg } from "../config.js";
import { embedBatch, embedOne, generateDescription } from "../embedder.js";
import { parseFile, EXTENSIONS } from "./parser.js";
import { ImportResolver } from "./resolver.js";
import { GitignoreFilter } from "./gitignore.js";
import {
  setDeps,
  clearDeps,
  invalidateProjectOverview,
} from "../storage.js";
import type { CodeChunk } from "../types.js";
import { qd, CODE_VECTORS, colName } from "../qdrant.js";
import { type FileManifest, listWorktreePaths } from "./git.js";

const BATCH_SIZE  = 32;
const DESC_CONCURRENCY = 5;
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage",
  "vendor", "charts", "testdata",
]);

/**
 * Retry a transient operation (typically a Qdrant HTTP call) with exponential
 * backoff. `fetch failed` from undici, DNS hiccups, and ECONNRESET resets
 * surface as plain `TypeError` / `Error` here; the indexer should ride those
 * out rather than failing the file.
 */
async function _retryTransient<T>(fn: () => Promise<T>, label: string, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      if (i === attempts - 1) break;
      const backoffMs = Math.min(2 ** i, 8) * 1000;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[indexer] ${label}: ${msg} — retrying in ${backoffMs / 1000}s (attempt ${i + 1}/${attempts})\n`,
      );
      await new Promise<void>((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

export interface CodeIndexerOpts {
  projectId: string;
  projectRoot: string;
  includePaths: string[];
  generateDescriptions?: boolean;
  branch?: string;
}

export class CodeIndexer {
  private readonly genDescs: boolean;
  public readonly projectId: string;
  public readonly projectRoot: string;
  public readonly includePaths: string[];
  private resolver: ImportResolver    | null = null;
  private ignFilter: GitignoreFilter  | null = null;
  private _indexInFlight = new Map<string, Promise<[number, number]>>();
  private _branch = "default";
  private readonly collection = colName("code_chunks");

  // Cached list of git worktree root paths (absolute, normalized) — refreshed
  // lazily from `<projectRoot>/.git/worktrees/`. Anything under one of these
  // paths must never be indexed: it's a checkout of another branch that lives
  // inside the project tree and would otherwise be re-indexed as if it were
  // source code from the current branch.
  private worktreePaths: string[] = [];
  private worktreePathsLoadedAt = 0;
  private static readonly WORKTREE_CACHE_MS = 30_000;

  constructor(opts: CodeIndexerOpts) {
    this.projectId = opts.projectId;
    this.projectRoot = opts.projectRoot;
    this.includePaths = opts.includePaths;
    this.genDescs = opts.generateDescriptions ?? false;
    if (opts.branch) this._branch = opts.branch;
  }

  get branch(): string { return this._branch; }
  set branch(v: string) { this._branch = v; }

  async ensureCollection(): Promise<void> {
    const { collections } = await qd.getCollections();
    const existing = collections.find((c) => c.name === this.collection);

    if (existing) {
      const info    = await qd.getCollection(this.collection);
      const vectors = info.config?.params?.vectors as Record<string, unknown> | undefined;
      const hasNamedVectors = vectors !== undefined && CODE_VECTORS.code in vectors;
      if (hasNamedVectors) {
        // Idempotent: ensure all indexes exist (mirrors ensureCodeChunks in qdrant.ts).
        for (const f of ["imports", "branches"]) {
          await qd.createPayloadIndex(this.collection, { field_name: f, field_schema: "keyword", wait: true })
            .catch(() => undefined);
        }
        // Migrate name index from word → prefix tokenizer so name_pattern substring search works.
        await qd.deletePayloadIndex(this.collection, "name").catch(() => undefined);
        await qd.createPayloadIndex(this.collection, {
          field_name: "name", field_schema: { type: "text", tokenizer: "prefix", min_token_len: 2, lowercase: true }, wait: true,
        }).catch(() => undefined);
        await qd.createPayloadIndex(this.collection, {
          field_name: "content", field_schema: { type: "text", tokenizer: "word", min_token_len: 2, lowercase: true }, wait: true,
        }).catch(() => undefined);
        return;
      }

      process.stderr.write(
        `[indexer] Migrating ${this.collection} to named vectors (existing index will be cleared)\n`
      );
      await qd.deleteCollection(this.collection);
    }

    await qd.createCollection(this.collection, {
      vectors: {
        [CODE_VECTORS.code]:        { size: cfg.embedDim, distance: "Cosine" },
        [CODE_VECTORS.description]: { size: cfg.embedDim, distance: "Cosine" },
      },
    });
    for (const field of ["file_path", "chunk_type", "language", "project_id", "parent_id", "imports"]) {
      await qd.createPayloadIndex(this.collection, {
        field_name:   field,
        field_schema: "keyword",
        wait:         true,
      });
    }
    for (const [field, schema] of [
      ["name",    { type: "text", tokenizer: "prefix", min_token_len: 2, lowercase: true }],
      ["content", { type: "text", tokenizer: "word",   min_token_len: 2, lowercase: true }],
    ] as const) {
      await qd.createPayloadIndex(this.collection, { field_name: field, field_schema: schema, wait: true });
    }
    process.stderr.write(`[indexer] Created collection '${this.collection}' (named vectors)\n`);
  }

  /** Reload the cached list of git-worktree root paths from disk. */
  refreshWorktreePaths(): void {
    if (!this.projectRoot) {
      this.worktreePaths = [];
    } else {
      this.worktreePaths = listWorktreePaths(this.projectRoot).map((p) => resolve(p));
    }
    this.worktreePathsLoadedAt = Date.now();
  }

  /** Worktree paths, refreshed at most once per WORKTREE_CACHE_MS. */
  private getWorktreePaths(): string[] {
    if (Date.now() - this.worktreePathsLoadedAt > CodeIndexer.WORKTREE_CACHE_MS) {
      this.refreshWorktreePaths();
    }
    return this.worktreePaths;
  }

  /**
   * Returns true if a file should never be indexed regardless of ignore files.
   * Also checks the active GitignoreFilter when called from the watcher.
   */
  shouldSkip(absPath: string): boolean {
    const parts = absPath.split("/");
    const name  = basename(absPath);
    const ext   = extname(absPath);
    if (name.startsWith(".")) return true;
    if (!EXTENSIONS.has(ext)) return true;

    // Safety check for file size (only if file exists)
    if (ext === ".json" && existsSync(absPath)) {
      try {
        if (statSync(absPath).size > 100_000) return true;
      } catch { /* ignore stat errors */ }
    }

    for (const part of parts) {
      if (IGNORE_DIRS.has(part)) return true;
    }

    for (const wt of this.getWorktreePaths()) {
      if (absPath === wt || absPath.startsWith(wt + "/")) return true;
    }

    if (this.ignFilter?.isIgnored(absPath)) return true;

    if (this.includePaths.length > 0) {
      const base = resolve(this.projectRoot || ".");
      const included = this.includePaths.some(p => {
        const abs = resolve(base, p);
        return absPath.startsWith(abs + "/") || absPath === abs;
      });
      if (!included) return true;
    } else {
      // If no includePaths, restrict to projectRoot
      const base = resolve(this.projectRoot || ".");
      if (!absPath.startsWith(base + "/") && absPath !== base) return true;
    }
    return false;
  }

  collectFiles(root: string): string[] {
    const absRoot = resolve(root);
    // Build a fresh filter so rules discovered during recursion accumulate.
    const filter = new GitignoreFilter();
    this.ignFilter = filter;          // expose for shouldSkip / watcher
    this.refreshWorktreePaths();

    const results: string[] = [];

    const recurse = (dir: string) => {
      // Load ignore rules from this subdirectory (if present).
      filter.addDir(dir);

      for (const entry of readdirSync(dir)) {
        const abs = join(dir, entry);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(abs);
        } catch { continue; }

        if (st.isDirectory()) {
          // Hard-coded skips (fastest check first).
          if (IGNORE_DIRS.has(entry) || entry.startsWith(".")) continue;
          // gitignore check for directories.
          if (filter.isIgnored(abs)) continue;
          recurse(abs);
        } else if (st.isFile()) {
          if (this.shouldSkip(abs)) continue;
          results.push(abs);
        }
      }
    };

    if (this.includePaths.length > 0) {
      for (const p of this.includePaths) {
        const abs = resolve(absRoot, p);
        if (existsSync(abs)) {
          const st = statSync(abs);
          if (st.isDirectory()) recurse(abs);
          else if (st.isFile() && !this.shouldSkip(abs)) results.push(abs);
        }
      }
    } else {
      recurse(absRoot);
    }

    return Array.from(new Set(results)).sort();
  }

  async deleteFile(relPath: string): Promise<void> {
    await qd.delete(this.collection, {
      filter: {
        must: [
          { key: "file_path",  match: { value: relPath       } },
          { key: "project_id", match: { value: this.projectId } },
        ],
      },
    });
  }

  /**
   * Remove only the current branch tag from chunks of a file.
   * Chunks that still belong to other branches are preserved.
   */
  async untagFile(relPath: string, branch: string): Promise<void> {
    let offset: string | number | undefined;
    while (true) {
      const result = await qd.scroll(this.collection, {
        filter: {
          must: [
            { key: "file_path",  match: { value: relPath       } },
            { key: "project_id", match: { value: this.projectId } },
            { key: "branches",   match: { value: branch        } },
          ],
        },
        limit:        500,
        with_payload: ["branches"],
        with_vector:  false,
        ...(offset !== undefined && { offset }),
      }).catch((): { points: []; next_page_offset: undefined } => ({ points: [], next_page_offset: undefined }));

      for (const p of result.points) {
        const old = ((p.payload ?? {}) as Record<string, unknown>)["branches"] as string[] | undefined ?? [];
        const updated = old.filter((b) => b !== branch);
        // Always update payload — never hard-delete during indexing.
        // Chunks with branches:[] are orphaned and will be cleaned up by gc().
        await qd.setPayload(this.collection, {
          payload: { branches: updated },
          points: [String(p.id)],
          wait: true,
        } as never);
      }

      const next = (result as { next_page_offset?: string | number | null }).next_page_offset;
      if (!next) break;
      offset = next;
    }
  }

  /**
   * Incremental file indexing: reuses existing chunks when file_hash matches.
   * Returns [chunks_processed, elapsed_ms].
   */
  async indexFileIncremental(absPath: string, root: string, branch?: string): Promise<[number, number]> {
    const t0 = Date.now();
    const br = branch ?? this._branch;
    const pathBase = this.projectRoot ? resolve(this.projectRoot) : root;
    const relPath  = relative(pathBase, absPath).replace(/\\/g, "/");
    const source   = readFileSync(absPath, "utf8");
    const newHash  = hashSource(source);

    // Check if chunks with the same file_hash already exist (from any branch)
    const existing = await qd.scroll(this.collection, {
      filter: {
        must: [
          { key: "file_path",  match: { value: relPath       } },
          { key: "file_hash",  match: { value: newHash        } },
          { key: "project_id", match: { value: this.projectId } },
        ],
      },
      limit:        1,
      with_payload: ["branches"],
      with_vector:  false,
    }).catch((): { points: [] } => ({ points: [] }));

    if (existing.points.length > 0) {
      // Chunks exist with this content — check if branch is already tagged
      const branches = ((existing.points[0]!.payload ?? {}) as Record<string, unknown>)["branches"] as string[] | undefined ?? [];
      if (branches.includes(br)) {
        return [0, Date.now() - t0]; // Already tagged for this branch
      }

      // Tag all chunks of this file+hash with the new branch
      await this._addBranchTag(relPath, newHash, br);
      return [0, Date.now() - t0];
    }

    // No existing chunks with this hash — untag old version on this branch, then full index
    await this.untagFile(relPath, br);

    // Use the standard _indexFileImpl which now sets branches: [this._branch]
    const oldBranch = this._branch;
    this._branch = br;
    const result = await this._indexFileImpl(absPath, root);
    this._branch = oldBranch;
    return result;
  }

  /** Add a branch tag to all chunks of file_path + file_hash. */
  private async _addBranchTag(relPath: string, fileHash: string, branch: string): Promise<void> {
    let offset: string | number | undefined;
    while (true) {
      const result = await qd.scroll(this.collection, {
        filter: {
          must: [
            { key: "file_path",  match: { value: relPath       } },
            { key: "file_hash",  match: { value: fileHash       } },
            { key: "project_id", match: { value: this.projectId } },
          ],
        },
        limit:        500,
        with_payload: ["branches"],
        with_vector:  false,
        ...(offset !== undefined && { offset }),
      }).catch((): { points: []; next_page_offset: undefined } => ({ points: [], next_page_offset: undefined }));

      for (const p of result.points) {
        const old = ((p.payload ?? {}) as Record<string, unknown>)["branches"] as string[] | undefined ?? [];
        if (!old.includes(branch)) {
          await qd.setPayload(this.collection, {
            payload: { branches: [...old, branch] },
            points: [String(p.id)],
            wait: true,
          } as never);
        }
      }

      const next = (result as { next_page_offset?: string | number | null }).next_page_offset;
      if (!next) break;
      offset = next;
    }
  }

  /**
   * Handle branch switch: for each file on the new branch, check Qdrant by hash.
   * If chunks with the same hash already exist they are tagged for the new branch (no re-embed).
   * Only files whose content is not yet in Qdrant are indexed from scratch.
   */
  async switchBranch(root: string, oldBranch: string, newBranch: string): Promise<void> {
    const t0 = Date.now();
    const pathBase = this.projectRoot ? resolve(this.projectRoot) : root;
    this._branch = newBranch;

    if (!this.resolver) {
      this.resolver = new ImportResolver({ root: pathBase });
    }

    const files = this.collectFiles(resolve(root));
    process.stderr.write(
      `[indexer] Branch switch ${oldBranch} \u2192 ${newBranch}: checking ${files.length} files\n`,
    );

    for (const absPath of files) {
      await this.indexFileIncremental(absPath, root, newBranch).catch((err: unknown) => {
        process.stderr.write(`[indexer] ${absPath}: ${String(err)}\n`);
      });
    }

    await invalidateProjectOverview(this.projectId).catch(() => undefined);
    process.stderr.write(`[indexer] Branch switch complete in ${Date.now() - t0}ms\n`);
  }

  /** Build a manifest from files currently on disk. */
  _buildDiskManifest(root: string): FileManifest {
    const pathBase = this.projectRoot ? resolve(this.projectRoot) : root;
    const files = this.collectFiles(resolve(root));
    const manifest: FileManifest = {};
    for (const absPath of files) {
      const relPath = relative(pathBase, absPath).replace(/\\/g, "/");
      try {
        const source = readFileSync(absPath, "utf8");
        manifest[relPath] = hashSource(source);
      } catch { /* skip unreadable files */ }
    }
    return manifest;
  }

  private async getFileHash(relPath: string): Promise<string | null> {
    const result = await qd.scroll(this.collection, {
      filter: {
        must: [
          { key: "file_path",  match: { value: relPath       } },
          { key: "project_id", match: { value: this.projectId } },
        ],
      },
      limit:        1,
      with_payload: ["file_hash"],
      with_vector:  false,
    });
    const point = result.points[0];
    if (!point) return null;
    const hash = (point.payload ?? {})["file_hash"];
    return typeof hash === "string" ? hash : null;
  }

  /**
   * Scroll Qdrant for chunks in this project missing a `description` payload field.
   * Uses the `is_empty` filter so we only walk the rows that actually need work.
   */
  private async _scrollMissingDescriptions(limit: number): Promise<Array<{
    id:        string;
    content:   string;
    name:      string;
    chunkType: string;
    language:  string;
    filePath:  string;
    isChild:   boolean;
  }>> {
    const toUpdate: Array<{
      id:        string;
      content:   string;
      name:      string;
      chunkType: string;
      language:  string;
      filePath:  string;
      isChild:   boolean;
    }> = [];

    const result = await qd.scroll(this.collection, {
      filter: {
        must: [
          { key: "project_id", match: { value: this.projectId } },
          { is_empty: { key: "description" } },
        ],
      },
      limit,
      with_payload: ["content", "name", "chunk_type", "language", "parent_id", "file_path"],
      with_vector:  false,
    } as never).catch((): { points: []; next_page_offset: undefined } => ({ points: [], next_page_offset: undefined }));

    for (const p of result.points) {
      const pl = (p.payload ?? {}) as Record<string, unknown>;
      toUpdate.push({
        id:        String(p.id),
        content:   String(pl["content"]    ?? ""),
        name:      String(pl["name"]       ?? ""),
        chunkType: String(pl["chunk_type"] ?? ""),
        language:  String(pl["language"]   ?? ""),
        filePath:  String(pl["file_path"]  ?? ""),
        isChild:   typeof pl["parent_id"]  === "string",
      });
    }
    return toUpdate;
  }

  /**
   * Generate descriptions for a batch of chunks already in Qdrant and write
   * the resulting payload + description vector back. Returns counters so the
   * drainer can adapt its sleep interval on widespread failure.
   */
  private async _writeDescriptionsBatch(toUpdate: Array<{
    id: string; content: string; name: string; chunkType: string;
    language: string; filePath: string; isChild: boolean;
  }>): Promise<{ written: number; failed: number }> {
    if (toUpdate.length === 0) return { written: 0, failed: 0 };

    const fakeChunks: CodeChunk[] = toUpdate.map((t) => ({
      content:   t.content,
      name:      t.name,
      chunkType: t.chunkType,
      language:  t.language,
      filePath:  t.filePath,
      signature: "",
      startLine: 0,
      endLine:   0,
      jsdoc:     "",
    }));

    const descriptions = await this.batchGenerateDescriptions(fakeChunks);
    let failed = 0;
    for (const d of descriptions) if (!d) failed++;

    // Embed descriptions for non-child chunks (children store description text
    // but not a description_vector, matching _indexFileImpl's vector layout).
    const toEmbed: Array<{ idx: number; text: string }> = [];
    for (let i = 0; i < toUpdate.length; i++) {
      const d = descriptions[i];
      if (d && !toUpdate[i]!.isChild) toEmbed.push({ idx: i, text: d });
    }
    const descVecs: (number[] | null)[] = new Array(toUpdate.length).fill(null);
    if (toEmbed.length > 0) {
      const vecs = await embedBatch(toEmbed.map((e) => e.text)).catch(() => null);
      if (vecs) {
        for (let j = 0; j < toEmbed.length; j++) {
          descVecs[toEmbed[j]!.idx] = vecs[j] ?? null;
        }
      }
    }

    let written = 0;
    for (let i = 0; i < toUpdate.length; i++) {
      const { id, isChild } = toUpdate[i]!;
      const desc = descriptions[i];
      const vec  = descVecs[i];
      if (!desc) continue;

      await qd.setPayload(this.collection, {
        payload: { description: desc },
        points:  [id],
        wait:    true,
      } as never).catch((err: unknown) => {
        process.stderr.write(`[drainer] setPayload failed for ${id}: ${String(err)}\n`);
      });

      if (!isChild && vec) {
        await qd.updateVectors(this.collection, {
          points: [{ id, vector: { [CODE_VECTORS.description]: vec } }],
          wait:   true,
        } as never).catch((err: unknown) => {
          process.stderr.write(`[drainer] updateVectors failed for ${id}: ${String(err)}\n`);
        });
      }
      written++;
    }
    return { written, failed };
  }

  private _drainerRunning = false;
  private _drainerStop    = false;

  /**
   * Background loop: scroll Qdrant for chunks lacking a description, generate
   * them via the LLM, write payload + description_vector back. Runs forever
   * until stopDrainer() is called or the worker terminates. Idle-sleeps when
   * the backlog is empty; backs off when the LLM is unavailable.
   */
  async runDescriptionDrainer(opts?: { batchSize?: number; idleMs?: number; outageMs?: number }): Promise<void> {
    if (!this.genDescs)        return;
    if (this._drainerRunning)  return;
    this._drainerRunning = true;
    this._drainerStop    = false;

    const batchSize = opts?.batchSize ?? 50;
    const idleMs    = opts?.idleMs    ?? 10_000;
    const outageMs  = opts?.outageMs  ?? 60_000;
    const sleep     = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    process.stderr.write(`[drainer] starting for project=${this.projectId}\n`);
    try {
      while (!this._drainerStop) {
        const toUpdate = await this._scrollMissingDescriptions(batchSize);
        if (toUpdate.length === 0) {
          await sleep(idleMs);
          continue;
        }
        const { written, failed } = await this._writeDescriptionsBatch(toUpdate);
        process.stderr.write(`[drainer] batch ${written} written, ${failed} pending (size=${toUpdate.length})\n`);
        if (written === 0 && failed > 0) {
          await sleep(outageMs);
        } else {
          await sleep(500);
        }
      }
    } finally {
      this._drainerRunning = false;
      process.stderr.write(`[drainer] stopped for project=${this.projectId}\n`);
    }
  }

  /** Signal the drainer loop to exit at its next iteration. */
  stopDrainer(): void {
    this._drainerStop = true;
  }

  /** Generate descriptions for a batch of chunks (bounded concurrency). */
  private async batchGenerateDescriptions(chunks: CodeChunk[]): Promise<(string | null)[]> {
    const results: (string | null)[] = new Array(chunks.length).fill(null);
    let failures = 0;
    let lastError = "";
    for (let i = 0; i < chunks.length; i += DESC_CONCURRENCY) {
      const slice = chunks.slice(i, i + DESC_CONCURRENCY);
      const descs = await Promise.all(
        slice.map((c) =>
          generateDescription({ content: c.content, name: c.name, chunkType: c.chunkType, language: c.language })
            .catch((err: unknown) => {
              failures++;
              lastError = err instanceof Error ? err.message : String(err);
              return null;
            })
        )
      );
      for (let j = 0; j < descs.length; j++) {
        results[i + j] = descs[j] ?? null;
      }
    }
    if (failures > 0) {
      process.stderr.write(
        `[indexer] description batch: ${failures}/${chunks.length} failed, last error: ${lastError}\n`,
      );
    }
    return results;
  }

  async indexFile(absPath: string, root: string): Promise<[number, number]> {
    const prev = this._indexInFlight.get(absPath) ?? Promise.resolve([0, 0] as [number, number]);
    const next = prev.catch((): [number, number] => [0, 0]).then(() => this._indexFileImpl(absPath, root));
    this._indexInFlight.set(absPath, next);
    // The derived `.finally` promise inherits any rejection from `next`; swallow it
    // here so an `_indexFileImpl` throw is observed only via the returned `next`.
    next
      .finally(() => {
        if (this._indexInFlight.get(absPath) === next)
          this._indexInFlight.delete(absPath);
      })
      .catch(() => undefined);
    return next;
  }

  private async _indexFileImpl(absPath: string, root: string): Promise<[number, number]> {
    const t0 = Date.now();
    const pathBase = this.projectRoot ? resolve(this.projectRoot) : root;
    const relPath  = relative(pathBase, absPath).replace(/\\/g, "/");
    if (!this.resolver) {
      this.resolver = new ImportResolver({ root: pathBase });
    }
    const source  = readFileSync(absPath, "utf8");
    const newHash = hashSource(source);

    const storedHash = await this.getFileHash(relPath);
    if (storedHash === newHash) {
      // Descriptions for already-indexed files are backfilled by runDescriptionDrainer().
      return [0, 0];
    }

    const chunks = await parseFile(relPath, source);
    if (chunks.length === 0) {
      // Still update dep graph even if no chunks (empty file or no exports)
      if (this.resolver) {
        await clearDeps(this.projectId, relPath).catch(() => undefined);
      }
      return [0, 0];
    }

    await _retryTransient(() => this.deleteFile(relPath), `deleteFile ${relPath}`);

    // ── Dep graph ────────────────────────────────────────────────────────────
    const rawImports      = chunks[0]?.imports ?? [];
    const resolvedImports = rawImports.length > 0
      ? this.resolver.resolveAll(rawImports, relPath)
      : [];
    if (resolvedImports.length > 0) {
      await setDeps(this.projectId, relPath, resolvedImports).catch(() => undefined);
    }

    // ── Parent/child UUID assignment ─────────────────────────────────────────
    const chunkIds: string[] = chunks.map(() => crypto.randomUUID());

    // Map "{filePath}:{startLine}" → UUID for parent chunks
    const parentKeyToId = new Map<string, string>();
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      if (c.chunkRole === "parent") {
        parentKeyToId.set(`${c.filePath}:${c.startLine}`, chunkIds[i]!);
      }
    }

    // Map parentUUID → list of child UUIDs
    const parentToChildren = new Map<string, string[]>();
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      if (c.parentKey) {
        const parentId = parentKeyToId.get(c.parentKey);
        if (parentId) {
          const arr = parentToChildren.get(parentId) ?? [];
          arr.push(chunkIds[i]!);
          parentToChildren.set(parentId, arr);
        }
      }
    }

    // ── Embeddings ────────────────────────────────────────────────────────────
    const codeTexts = chunks.map((c) => buildEmbedContext(c));
    const codeEmbeds: (number[] | null)[] = [];
    for (let i = 0; i < codeTexts.length; i += BATCH_SIZE) {
      const slice = codeTexts.slice(i, i + BATCH_SIZE);
      const batch = await embedBatch(slice).catch(() => null);
      if (batch) {
        codeEmbeds.push(...batch);
      } else {
        const individual = await Promise.all(
          slice.map((t) => embedOne(t).catch((): number[] | null => null))
        );
        codeEmbeds.push(...individual);
      }
    }

    // Descriptions are generated asynchronously by runDescriptionDrainer().
    // The hot path here just persists chunks with code vectors; the drainer
    // backfills description text + description_vector once the LLM responds.

    // ── Build Qdrant points ───────────────────────────────────────────────────
    const points: Array<{
      id:      string;
      vector:  Record<string, number[]>;
      payload: Record<string, unknown>;
    }> = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk    = chunks[i]!;
      const id       = chunkIds[i]!;
      const codeVec  = codeEmbeds[i];

      // All chunks get code_vector at index time. Description text and
      // description_vector are populated later by runDescriptionDrainer().
      const isParent = chunk.chunkRole === "parent";

      const vector: Record<string, number[]> = {};
      if (codeVec) vector[CODE_VECTORS.code] = codeVec;

      // Skip if we have no vectors at all
      if (Object.keys(vector).length === 0) continue;

      const parentId   = chunk.parentKey ? parentKeyToId.get(chunk.parentKey) : undefined;
      const childrenIds = parentToChildren.get(id);

      const payload: Record<string, unknown> = {
        content:    chunk.content,
        file_path:  relPath,
        chunk_type: chunk.chunkType,
        name:       chunk.name,
        signature:  chunk.signature,
        start_line: chunk.startLine,
        end_line:   chunk.endLine,
        language:   chunk.language,
        jsdoc:      chunk.jsdoc,
        project_id: this.projectId,
        file_hash:  newHash,
      };

      if (isParent)      payload["is_parent"]     = true;
      if (parentId)      payload["parent_id"]     = parentId;
      if (childrenIds)   payload["children_ids"]  = childrenIds;
      if (resolvedImports.length > 0) payload["imports"] = resolvedImports;
      payload["branches"] = [this._branch];

      points.push({ id, vector, payload });
    }

    if (points.length === 0) return [0, 0];
    await _retryTransient(() => qd.upsert(this.collection, { points }), `qd.upsert ${relPath}`);
    return [points.length, Date.now() - t0];
  }

  async indexAll(
    root: string,
    opts?: {
      suppressCountLog?: boolean;
      onProgress?: (done: number, total: number, chunks: number) => void;
    },
  ): Promise<void> {
    const { suppressCountLog = false, onProgress } = opts ?? {};
    const pathBase = this.projectRoot ? resolve(this.projectRoot) : root;
    // Initialise resolver for dep graph — use pathBase so imports resolve
    // relative to project root, and tsconfig.json is found in the right place
    this.resolver = new ImportResolver({ root: pathBase });
    const files = this.collectFiles(root);
    if (!suppressCountLog) process.stderr.write(`[indexer] Found ${files.length} files\n`);

    let total = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const [n] = await this.indexFile(file, root).catch((err: unknown) => {
        process.stderr.write(`[indexer] ${file}: ${String(err)}\n`);
        return [0, 0] as [number, number];
      });
      total += n;
      onProgress?.(i + 1, files.length, n);
      if ((i + 1) % 20 === 0) {
        process.stderr.write(`[indexer] [${i + 1}/${files.length}] ${total} chunks\n`);
      }
      process.stderr.write(`[indexer] [${i + 1}/${files.length}] ${total} chunks: ${file} done.\n`)
    }

    // Invalidate cached project overview since structure may have changed
    await invalidateProjectOverview(this.projectId).catch(() => undefined);

    process.stderr.write(`[indexer] Done: ${files.length} files, ${total} chunks\n`);

    // Hint V8 to compact heap after bulk indexing (requires --expose-gc)
    if (typeof globalThis.gc === "function") globalThis.gc();
  }

  /**
   * Payload-only repair: finds chunks with empty `name` and updates them
   * using the current parser — without touching vectors or descriptions.
   */
  async repairNames(root: string): Promise<void> {
    const pathBase = this.projectRoot ? resolve(this.projectRoot) : root;
    const affected: Array<{
      id: string; filePath: string; startLine: number; chunkType: string; content: string;
    }> = [];
    let offset: string | number | undefined;

    // 1. Collect all empty-name chunks for this project
    while (true) {
      const result = await qd.scroll(this.collection, {
        filter: {
          must: [
            { key: "project_id", match: { value: this.projectId } },
            { key: "name",       match: { value: ""             } },
          ],
        },
        limit:        500,
        with_payload: ["file_path", "start_line", "chunk_type", "content"],
        with_vector:  false,
        ...(offset !== undefined && { offset }),
      }).catch((): { points: []; next_page_offset: undefined } => ({ points: [], next_page_offset: undefined }));

      for (const p of result.points) {
        const pl = (p.payload ?? {}) as Record<string, unknown>;
        affected.push({
          id:        String(p.id),
          filePath:  String(pl["file_path"]  ?? ""),
          startLine: Number(pl["start_line"] ?? 0),
          chunkType: String(pl["chunk_type"] ?? ""),
          content:   String(pl["content"]    ?? ""),
        });
      }
      const next = (result as { next_page_offset?: string | number | null }).next_page_offset;
      if (!next) break;
      offset = next;
    }

    if (affected.length === 0) {
      process.stderr.write("[repair] No unnamed chunks found.\n");
      return;
    }
    const fileCount = new Set(affected.map((a) => a.filePath)).size;
    process.stderr.write(`[repair] ${affected.length} unnamed chunks across ${fileCount} files\n`);

    // Build alternate bases from includePaths (fallback for path-root mismatches)
    const altBases: string[] = [];
    if (this.includePaths.length > 0) {
      const { glob, lstat } = await import("node:fs/promises");
      for await (const match of glob(this.includePaths, { cwd: pathBase })) {
        const abs = join(pathBase, match);
        try {
          const s = await lstat(abs);
          if (s.isDirectory()) altBases.push(abs);
        } catch { /* skip */ }
      }
    }

    // 2. Group by file
    const byFile = new Map<string, typeof affected>();
    for (const a of affected) {
      const arr = byFile.get(a.filePath) ?? [];
      arr.push(a);
      byFile.set(a.filePath, arr);
    }

    // 3. Re-parse each file and patch payload only (vectors/descriptions untouched)
    let fixed = 0, stillEmpty = 0, unfound = 0, skippedChunks = 0, skippedFiles = 0;
    for (const [relPath, points] of byFile) {
      // Try primary base, then each altBase
      let source: string | undefined;
      let resolvedBase = pathBase;
      try {
        source = readFileSync(join(pathBase, relPath), "utf8");
      } catch {
        for (const base of altBases) {
          try {
            source = readFileSync(join(base, relPath), "utf8");
            resolvedBase = base;
            break;
          } catch { /* try next */ }
        }
      }
      if (source === undefined) {
        process.stderr.write(`[repair] cannot read ${relPath}, skipping\n`);
        skippedFiles++;
        skippedChunks += points.length;
        continue;
      }

      // Re-parse relative to the base that found the file
      const effectiveRelPath = relative(pathBase, join(resolvedBase, relPath)).replace(/\\/g, "/");
      const chunks = await parseFile(effectiveRelPath, source).catch(() => [] as CodeChunk[]);

      // Primary key: chunkType:startLine (exact match)
      // Fallback key: content (handles line-shift when file modified since indexing)
      const allKeysFound  = new Set<string>();
      const chunkMap      = new Map<string, string>(); // chunkType:startLine → name
      const contentMap    = new Map<string, string>(); // content → name

      for (const c of chunks) {
        const key = `${c.chunkType}:${c.startLine}`;
        allKeysFound.add(key);
        if (c.content) allKeysFound.add(c.content);
        if (c.name) {
          chunkMap.set(key, c.name);
          if (c.content) contentMap.set(c.content, c.name);
        }
      }

      for (const p of points) {
        const name = chunkMap.get(`${p.chunkType}:${p.startLine}`) ?? contentMap.get(p.content);
        if (!name) {
          const found = allKeysFound.has(`${p.chunkType}:${p.startLine}`) || allKeysFound.has(p.content);
          if (found) stillEmpty++; else unfound++;
          continue;
        }
        await qd.setPayload(this.collection, { payload: { name }, points: [p.id], wait: true } as never);
        fixed++;
      }
    }

    process.stderr.write(`[repair] Done: ${fixed}/${affected.length} chunks repaired\n`);
    if (skippedChunks > 0)
      process.stderr.write(`[repair] ${skippedChunks} chunks in ${skippedFiles} files could not be read (path not found)\n`);
    if (stillEmpty > 0)
      process.stderr.write(`[repair] ${stillEmpty} chunks still have no parseable name (parser fix needed)\n`);
    if (unfound > 0)
      process.stderr.write(`[repair] ${unfound} chunks could not be matched — run 'local-rag index <root>' to fully re-index those files.\n`);
  }

  /**
   * One-time migration: add branches: [branch] to all existing chunks that lack the field.
   */
  async migrateBranches(branch: string, root: string): Promise<void> {
    // Build disk manifest so we only tag chunks whose files actually exist on this branch
    const diskManifest = this._buildDiskManifest(root);
    const diskFiles = new Set(Object.keys(diskManifest));

    let offset: string | number | undefined;
    let migrated = 0;
    let skipped  = 0;

    while (true) {
      const result = await qd.scroll(this.collection, {
        filter: {
          must: [
            { key: "project_id", match: { value: this.projectId } },
          ],
          must_not: [
            { key: "branches", match: { value: branch } },
          ],
        },
        limit:        500,
        with_payload: ["chunk_type", "file_path", "file_hash"],
        with_vector:  false,
        ...(offset !== undefined && { offset }),
      }).catch((): { points: []; next_page_offset: undefined } => ({ points: [], next_page_offset: undefined }));

      // Only tag chunks whose file exists on disk with matching hash
      const ids: string[] = [];
      for (const p of result.points) {
        const pl = (p.payload as Record<string, unknown>) ?? {};
        const ct = pl["chunk_type"];
        if (ct === "git_state" || ct === "branch_manifest") continue;

        const filePath = String(pl["file_path"] ?? "");
        const fileHash = String(pl["file_hash"] ?? "");
        if (!filePath || !diskFiles.has(filePath)) { skipped++; continue; }
        if (fileHash && diskManifest[filePath] && fileHash !== diskManifest[filePath]) { skipped++; continue; }

        ids.push(String(p.id));
      }

      if (ids.length > 0) {
        await qd.setPayload(this.collection, {
          payload: { branches: [branch] },
          points: ids,
          wait: true,
        } as never);
        migrated += ids.length;
      }

      const next = (result as { next_page_offset?: string | number | null }).next_page_offset;
      if (!next) break;
      offset = next;
    }

    if (migrated > 0 || skipped > 0) {
      process.stderr.write(`[indexer] Migration: tagged ${migrated} chunks with branch "${branch}", skipped ${skipped}\n`);
    }
  }

  /**
   * Garbage-collect chunks for branches that no longer exist in git.
   */
  async gc(root: string): Promise<void> {
    const { getLocalBranches, deleteManifest } = await import("./git.js");
    const liveBranches = new Set(getLocalBranches(root));
    if (liveBranches.size === 0) liveBranches.add("default");

    // Collect all unique branch values from indexed chunks
    const allBranches = new Set<string>();
    let offset: string | number | undefined;

    while (true) {
      const result = await qd.scroll(this.collection, {
        filter: { must: [{ key: "project_id", match: { value: this.projectId } }] },
        limit:        500,
        with_payload: ["branches", "chunk_type"],
        with_vector:  false,
        ...(offset !== undefined && { offset }),
      }).catch((): { points: []; next_page_offset: undefined } => ({ points: [], next_page_offset: undefined }));

      for (const p of result.points) {
        const pl = (p.payload ?? {}) as Record<string, unknown>;
        if (pl["chunk_type"] === "git_state" || pl["chunk_type"] === "branch_manifest") continue;
        const branches = pl["branches"] as string[] | undefined ?? [];
        for (const b of branches) allBranches.add(b);
      }

      const next = (result as { next_page_offset?: string | number | null }).next_page_offset;
      if (!next) break;
      offset = next;
    }

    const staleBranches = [...allBranches].filter((b) => !liveBranches.has(b));
    if (staleBranches.length === 0) {
      process.stderr.write("[gc] No stale branches found\n");
      return;
    }

    process.stderr.write(`[gc] Cleaning up ${staleBranches.length} stale branch(es): ${staleBranches.join(", ")}\n`);

    // For each stale branch: remove it from chunks' branches[], delete manifests
    for (const branch of staleBranches) {
      let gcOffset: string | number | undefined;
      let cleaned = 0;

      while (true) {
        const result = await qd.scroll(this.collection, {
          filter: {
            must: [
              { key: "project_id", match: { value: this.projectId } },
              { key: "branches",   match: { value: branch        } },
            ],
          },
          limit:        500,
          with_payload: ["branches"],
          with_vector:  false,
          ...(gcOffset !== undefined && { offset: gcOffset }),
        }).catch((): { points: []; next_page_offset: undefined } => ({ points: [], next_page_offset: undefined }));

        for (const p of result.points) {
          const old = ((p.payload ?? {}) as Record<string, unknown>)["branches"] as string[] | undefined ?? [];
          const updated = old.filter((b) => b !== branch);
          if (updated.length === 0) {
            await qd.delete(this.collection, { points: [String(p.id)] });
          } else {
            await qd.setPayload(this.collection, {
              payload: { branches: updated },
              points: [String(p.id)],
              wait: true,
            } as never);
          }
          cleaned++;
        }

        const next = (result as { next_page_offset?: string | number | null }).next_page_offset;
        if (!next) break;
        gcOffset = next;
      }

      await deleteManifest(branch).catch(() => undefined);
      process.stderr.write(`[gc] Branch "${branch}": cleaned ${cleaned} chunks\n`);
    }
  }

  async clear(): Promise<void> {
    await qd.delete(this.collection, {
      filter: { must: [{ key: "project_id", match: { value: this.projectId } }] },
    });
    process.stderr.write("[indexer] Index cleared\n");
  }

  async stats(): Promise<void> {
    const info = await qd.getCollection(this.collection);
    process.stdout.write(
      `Code Index: ${info.points_count ?? 0} points, ${info.segments_count ?? 0} segments\n`
    );
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function hashSource(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function buildEmbedContext(c: CodeChunk): string {
  let ctx = `File: ${c.filePath}\nType: ${c.chunkType}\nName: ${c.name}\n`;
  if (c.jsdoc)     ctx += `JSDoc: ${c.jsdoc}\n`;
  if (c.signature) ctx += `Sig: ${c.signature}\n`;
  ctx += `Code:\n${c.content}`;
  return ctx.slice(0, 4000);
}
