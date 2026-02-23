import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { QdrantClient } from "@qdrant/js-client-rest";
import { cfg } from "../config.js";
import { embedBatch, embedOne } from "../embedder.js";
import { parseFile, EXTENSIONS } from "./parser.js";
import type { CodeChunk } from "../types.js";

const COLLECTION  = "code_chunks";
const BATCH_SIZE  = 32;
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage", "__tests__",
  "vendor", "charts", "testdata",
]);

export class CodeIndexer {
  private readonly qd: QdrantClient;

  constructor() {
    this.qd = new QdrantClient({ url: cfg.qdrantUrl });
  }

  async ensureCollection(): Promise<void> {
    const { collections } = await this.qd.getCollections();
    const exists = collections.some((c) => c.name === COLLECTION);
    if (exists) return;

    await this.qd.createCollection(COLLECTION, {
      vectors: { size: cfg.embedDim, distance: "Cosine" },
    });
    for (const field of ["file_path", "chunk_type", "language", "project_id"]) {
      await this.qd.createPayloadIndex(COLLECTION, {
        field_name:   field,
        field_schema: "keyword",
        wait:         true,
      });
    }
    process.stderr.write(`[indexer] Created collection '${COLLECTION}'\n`);
  }

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
    return false;
  }

  private collectFiles(dir: string): string[] {
    const results: string[] = [];
    const recurse = (d: string) => {
      for (const entry of readdirSync(d)) {
        const abs = join(d, entry);
        const st  = statSync(abs);
        if (st.isDirectory()) {
          if (!IGNORE_DIRS.has(entry)) recurse(abs);
        } else if (st.isFile() && !this.shouldSkip(abs)) {
          results.push(abs);
        }
      }
    };
    recurse(dir);
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

  async indexFile(absPath: string, root: string): Promise<number> {
    const relPath = relative(root, absPath).replace(/\\/g, "/");
    const source  = readFileSync(absPath, "utf8");
    const chunks  = await parseFile(relPath, source);
    if (chunks.length === 0) return 0;

    await this.deleteFile(relPath);

    const texts = chunks.map((c) => buildEmbedContext(c));
    const results: (number[] | null)[] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const slice = texts.slice(i, i + BATCH_SIZE);
      const batch = await embedBatch(slice).catch(() => null);
      if (batch) {
        results.push(...batch);
      } else {
        const individual = await Promise.all(
          slice.map((t) => embedOne(t).catch((): number[] | null => null))
        );
        results.push(...individual);
      }
    }

    const points = chunks
      .map((chunk, idx) => ({ chunk, embedding: results[idx] ?? null }))
      .filter((p): p is { chunk: CodeChunk; embedding: number[] } => p.embedding !== null)
      .map(({ chunk, embedding }) => ({
        id:      crypto.randomUUID(),
        vector:  embedding,
        payload: {
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
        },
      }));

    if (points.length === 0) return 0;
    await this.qd.upsert(COLLECTION, { points });
    return points.length;
  }

  async indexAll(root: string): Promise<void> {
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

// ── embedding context format (must match Python for reuse of existing index) ─

function buildEmbedContext(c: CodeChunk): string {
  let ctx = `File: ${c.filePath}\nType: ${c.chunkType}\nName: ${c.name}\n`;
  if (c.jsdoc)     ctx += `JSDoc: ${c.jsdoc}\n`;
  if (c.signature) ctx += `Sig: ${c.signature}\n`;
  ctx += `Code:\n${c.content}`;
  return ctx.slice(0, 4000);
}
