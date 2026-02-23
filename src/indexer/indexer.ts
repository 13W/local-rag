import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { createHash } from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import { cfg } from "../config.js";
import { embedBatch, embedOne, generateDescription } from "../embedder.js";
import { parseFile, EXTENSIONS } from "./parser.js";
import { ImportResolver } from "./resolver.js";
import { GitignoreFilter } from "./gitignore.js";
import {
  setDeps,
  clearDeps,
  invalidateProjectOverview,
} from "../redis.js";
import type { CodeChunk } from "../types.js";
import { CODE_VECTORS } from "../qdrant.js";

const COLLECTION  = "code_chunks";
const BATCH_SIZE  = 32;
const DESC_CONCURRENCY = 5;
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage", "__tests__",
  "vendor", "charts", "testdata",
]);

export class CodeIndexer {
  private readonly qd:       QdrantClient;
  private readonly genDescs: boolean;
  private resolver: ImportResolver    | null = null;
  private ignFilter: GitignoreFilter  | null = null;

  constructor(opts: { generateDescriptions?: boolean } = {}) {
    this.qd       = new QdrantClient({ url: cfg.qdrantUrl });
    this.genDescs = opts.generateDescriptions ?? false;
  }

  async ensureCollection(): Promise<void> {
    const { collections } = await this.qd.getCollections();
    const existing = collections.find((c) => c.name === COLLECTION);

    if (existing) {
      const info    = await this.qd.getCollection(COLLECTION);
      const vectors = info.config?.params?.vectors as Record<string, unknown> | undefined;
      const hasNamedVectors = vectors !== undefined && CODE_VECTORS.code in vectors;
      if (hasNamedVectors) return;

      process.stderr.write(
        "[indexer] Migrating code_chunks to named vectors (existing index will be cleared)\n"
      );
      await this.qd.deleteCollection(COLLECTION);
    }

    await this.qd.createCollection(COLLECTION, {
      vectors: {
        [CODE_VECTORS.code]:        { size: cfg.embedDim, distance: "Cosine" },
        [CODE_VECTORS.description]: { size: cfg.embedDim, distance: "Cosine" },
      },
    });
    for (const field of ["file_path", "chunk_type", "language", "project_id", "parent_id"]) {
      await this.qd.createPayloadIndex(COLLECTION, {
        field_name:   field,
        field_schema: "keyword",
        wait:         true,
      });
    }
    process.stderr.write(`[indexer] Created collection '${COLLECTION}' (named vectors)\n`);
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
    if (ext === ".json" && statSync(absPath).size > 100_000) return true;
    for (const part of parts) {
      if (IGNORE_DIRS.has(part)) return true;
    }
    if (this.ignFilter?.isIgnored(absPath)) return true;
    return false;
  }

  private collectFiles(root: string): string[] {
    // Build a fresh filter so rules discovered during recursion accumulate.
    const filter = new GitignoreFilter();
    this.ignFilter = filter;          // expose for shouldSkip / watcher
    filter.addDir(root);              // root-level .gitignore / .ignore

    const results: string[] = [];

    const recurse = (dir: string) => {
      // Load ignore rules from this subdirectory (if present).
      if (dir !== root) filter.addDir(dir);

      for (const entry of readdirSync(dir)) {
        const abs = join(dir, entry);
        const st  = statSync(abs);

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

    recurse(root);
    return results.sort();
  }

  async deleteFile(relPath: string): Promise<void> {
    await this.qd.delete(COLLECTION, {
      filter: {
        must: [
          { key: "file_path",  match: { value: relPath       } },
          { key: "project_id", match: { value: cfg.projectId } },
        ],
      },
    });
  }

  private async getFileHash(relPath: string): Promise<string | null> {
    const result = await this.qd.scroll(COLLECTION, {
      filter: {
        must: [
          { key: "file_path",  match: { value: relPath       } },
          { key: "project_id", match: { value: cfg.projectId } },
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

  /** Generate descriptions for a batch of chunks (bounded concurrency). */
  private async batchGenerateDescriptions(chunks: CodeChunk[]): Promise<(string | null)[]> {
    const results: (string | null)[] = new Array(chunks.length).fill(null);
    for (let i = 0; i < chunks.length; i += DESC_CONCURRENCY) {
      const slice = chunks.slice(i, i + DESC_CONCURRENCY);
      const descs = await Promise.all(
        slice.map((c) =>
          generateDescription({ content: c.content, name: c.name, chunkType: c.chunkType, language: c.language })
            .catch(() => null)
        )
      );
      for (let j = 0; j < descs.length; j++) {
        results[i + j] = descs[j] ?? null;
      }
    }
    return results;
  }

  async indexFile(absPath: string, root: string): Promise<number> {
    const relPath = relative(root, absPath).replace(/\\/g, "/");
    const source  = readFileSync(absPath, "utf8");
    const newHash = hashSource(source);

    const storedHash = await this.getFileHash(relPath);
    if (storedHash === newHash) return 0;

    const chunks = await parseFile(relPath, source);
    if (chunks.length === 0) {
      // Still update dep graph even if no chunks (empty file or no exports)
      if (this.resolver) {
        await clearDeps(cfg.projectId, relPath).catch(() => undefined);
      }
      return 0;
    }

    await this.deleteFile(relPath);

    // ── Dep graph ────────────────────────────────────────────────────────────
    const rawImports = chunks[0]?.imports ?? [];
    if (rawImports.length > 0 && this.resolver) {
      const resolved = this.resolver.resolveAll(rawImports, relPath);
      if (resolved.length > 0) {
        await setDeps(cfg.projectId, relPath, resolved).catch(() => undefined);
      }
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

    // ── LLM Descriptions ─────────────────────────────────────────────────────
    // Parent chunks always get descriptions (they hold the summary).
    // For regular/child chunks, only when flag is enabled.
    const needsDesc = chunks.map((c) =>
      c.chunkRole === "parent" || (this.genDescs && c.chunkRole !== "child")
    );

    const descTexts: (string | null)[] = new Array(chunks.length).fill(null);
    const descChunkIndices = chunks
      .map((_, i) => i)
      .filter((i) => needsDesc[i]);

    if (descChunkIndices.length > 0) {
      const descChunks = descChunkIndices.map((i) => chunks[i]!);
      const descriptions = await this.batchGenerateDescriptions(descChunks);
      for (let j = 0; j < descChunkIndices.length; j++) {
        descTexts[descChunkIndices[j]!] = descriptions[j] ?? null;
      }
    }

    // Embed descriptions where available
    const descEmbeds: (number[] | null)[] = new Array(chunks.length).fill(null);
    const descToEmbed: Array<{ idx: number; text: string }> = [];
    for (let i = 0; i < chunks.length; i++) {
      const d = descTexts[i];
      if (d) descToEmbed.push({ idx: i, text: d });
    }
    if (descToEmbed.length > 0) {
      const descVecs = await embedBatch(descToEmbed.map((d) => d.text)).catch(() => null);
      if (descVecs) {
        for (let j = 0; j < descToEmbed.length; j++) {
          descEmbeds[descToEmbed[j]!.idx] = descVecs[j] ?? null;
        }
      }
    }

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
      const descVec  = descEmbeds[i];

      // Parent chunks: description_vector only (no code_vector)
      // Child chunks: code_vector only (no description_vector)
      // Regular chunks: code_vector always, description_vector if generated
      const isParent = chunk.chunkRole === "parent";
      const isChild  = chunk.chunkRole === "child";

      const vector: Record<string, number[]> = {};
      if (!isParent && codeVec) vector[CODE_VECTORS.code]        = codeVec;
      if (!isChild  && descVec) vector[CODE_VECTORS.description] = descVec;

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
        project_id: cfg.projectId,
        file_hash:  newHash,
      };

      if (descTexts[i])  payload["description"]  = descTexts[i];
      if (isParent)      payload["is_parent"]     = true;
      if (parentId)      payload["parent_id"]     = parentId;
      if (childrenIds)   payload["children_ids"]  = childrenIds;
      if (chunk.imports) payload["imports"]        = chunk.imports;

      points.push({ id, vector, payload });
    }

    if (points.length === 0) return 0;
    await this.qd.upsert(COLLECTION, { points });
    return points.length;
  }

  async indexAll(root: string): Promise<void> {
    // Initialise resolver for dep graph
    this.resolver = new ImportResolver({ root });
    const files = this.collectFiles(root);
    process.stderr.write(`[indexer] Found ${files.length} files\n`);

    let total = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const n = await this.indexFile(file, root).catch((err: unknown) => {
        process.stderr.write(`[indexer] ${file}: ${String(err)}\n`);
        return 0;
      });
      total += n;
      if ((i + 1) % 20 === 0) {
        process.stderr.write(`[indexer] [${i + 1}/${files.length}] ${total} chunks\n`);
      }
    }

    // Invalidate cached project overview since structure may have changed
    await invalidateProjectOverview(cfg.projectId).catch(() => undefined);

    process.stderr.write(`[indexer] Done: ${files.length} files, ${total} chunks\n`);
  }

  async clear(): Promise<void> {
    await this.qd.delete(COLLECTION, {
      filter: { must: [{ key: "project_id", match: { value: cfg.projectId } }] },
    });
    process.stderr.write("[indexer] Index cleared\n");
  }

  async stats(): Promise<void> {
    const info = await this.qd.getCollection(COLLECTION);
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
