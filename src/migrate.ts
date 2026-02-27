import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { QdrantClient } from "@qdrant/js-client-rest";
import { cfg } from "./config.js";
import { generateDescription } from "./embedder.js";

const BATCH_SIZE = 32;
const MEMORY_COLS = ["memory_episodic", "memory_semantic", "memory_procedural"] as const;
const CODE_CHUNK  = "code_chunks";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeProgress(total: number) {
  const start = Date.now();
  let done = 0;

  function render(final: boolean): void {
    const elapsedS = (Date.now() - start) / 1000;
    const rate     = elapsedS > 0.1 ? done / elapsedS : 0;
    const pct      = total > 0 ? done / total : 0;
    const barW     = 28;
    const filled   = Math.round(pct * barW);
    const bar      = "█".repeat(filled) + "░".repeat(barW - filled);
    const etaSec   = rate > 0 ? (total - done) / rate : 0;
    const eta      = final          ? "done          " :
      etaSec <  60                  ? `ETA ${Math.ceil(etaSec)}s  ` :
      `ETA ${Math.floor(etaSec / 60)}m${String(Math.ceil(etaSec % 60)).padStart(2, "0")}s`;
    const rateStr  = rate >= 1 ? `${Math.round(rate)} pts/s` : "…       ";
    process.stderr.write(
      `\r  [${bar}] ${String(done).padStart(6)}/${total}  ${String(Math.round(pct * 100)).padStart(3)}%  ${rateStr}  ${eta}  `
    );
  }

  return {
    tick(n: number): void { done += n; render(false); },
    finish():        void { done = total; render(true); process.stderr.write("\n"); },
  };
}

function colName(prefix: string, base: string): string {
  return prefix ? `${prefix}_${base}` : base;
}

function chunkArr<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

function buildEmbedCtx(p: Record<string, unknown>): string {
  return [
    `// file: ${p["file_path"]}`,
    `// type: ${p["chunk_type"]}  name: ${p["name"]}`,
    p["jsdoc"]   ? `// ${p["jsdoc"]}` : "",
    p["signature"] ?? "",
    p["content"]   ?? "",
  ].filter(Boolean).join("\n").slice(0, 4000);
}

/**
 * Re-read chunk content from disk using stored start/end line numbers.
 * Falls back to payload.content if file is missing or lines are invalid.
 */
function readFreshContent(p: Record<string, unknown>, projectRoot: string): string {
  const filePath  = p["file_path"]  as string | undefined;
  const startLine = p["start_line"] as number | undefined;
  const endLine   = p["end_line"]   as number | undefined;

  if (!filePath || startLine == null || endLine == null) {
    return (p["content"] as string | undefined) ?? "";
  }

  const absPath = projectRoot ? resolve(projectRoot, filePath) : filePath;
  if (!existsSync(absPath)) return (p["content"] as string | undefined) ?? "";

  const lines   = readFileSync(absPath, "utf8").split("\n");
  const content = lines.slice(Math.max(0, startLine - 1), endLine).join("\n");
  return content || ((p["content"] as string | undefined) ?? "");
}

async function embedWithModel(model: string, texts: string[], maxChars: number): Promise<number[][]> {
  const truncated = texts.map((t) => t.slice(0, maxChars));
  const resp = await fetch(`${cfg.ollamaUrl}/api/embed`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ model, input: truncated }),
    signal:  AbortSignal.timeout(120_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return Promise.reject(new Error(`Embed failed: ${resp.status} — ${body}`));
  }
  return ((await resp.json()) as { embeddings: number[][] }).embeddings;
}

async function getDim(model: string): Promise<number> {
  const vecs = await embedWithModel(model, ["test"], 100);
  return vecs[0]!.length;
}

type QdrantPoint = { id: string | number; payload?: Record<string, unknown> | null };

async function scrollAll(
  qd:        QdrantClient,
  col:       string,
  projectId: string | undefined,
): Promise<QdrantPoint[]> {
  const points: QdrantPoint[] = [];
  let offset: string | number | undefined;

  const filter = projectId
    ? { must: [{ key: "project_id", match: { value: projectId } }] }
    : undefined;

  while (true) {
    const result = await qd.scroll(col, {
      limit:        500,
      with_payload: true,
      with_vector:  false,
      ...(filter   !== undefined && { filter }),
      ...(offset   !== undefined && { offset }),
    });
    for (const pt of result.points) points.push(pt as QdrantPoint);
    if (result.next_page_offset == null) break;
    offset = result.next_page_offset as string | number;
  }

  return points;
}

async function createMemoryCol(qd: QdrantClient, name: string, dim: number): Promise<void> {
  await qd.createCollection(name, { vectors: { size: dim, distance: "Cosine" } });
  for (const field of ["project_id", "agent_id", "scope", "content_hash"]) {
    await qd.createPayloadIndex(name, { field_name: field, field_schema: "keyword", wait: true });
  }
}

async function createCodeChunkCol(qd: QdrantClient, name: string, dim: number): Promise<void> {
  await qd.createCollection(name, {
    vectors: {
      code_vector:        { size: dim, distance: "Cosine" },
      description_vector: { size: dim, distance: "Cosine" },
    },
  });
  for (const field of ["file_path", "chunk_type", "language", "project_id", "parent_id", "imports"]) {
    await qd.createPayloadIndex(name, { field_name: field, field_schema: "keyword", wait: true });
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

export async function runMigrate(): Promise<void> {
  const { values: args } = parseArgs({
    args:             process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      "from-prefix":           { type: "string",  default: "" },
      "to-prefix":             { type: "string",  default: "" },
      "to-model":              { type: "string",  default: "embeddinggemma:300m" },
      "project-root":          { type: "string",  default: "" },
      "project-id":            { type: "string",  default: "" },
      "generate-descriptions": { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict:           false,
  });

  const fromPrefix  = (args["from-prefix"]  ?? "") as string;
  const toPrefix    = (args["to-prefix"]    ?? "") as string;
  const toModel     = (args["to-model"]     ?? "embeddinggemma:300m") as string;
  const projectRoot   = ((args["project-root"] as string | undefined) || cfg.projectRoot) ?? "";
  const projectId     = ((args["project-id"]   as string | undefined) || cfg.projectId)   || undefined;
  const genDescs      = Boolean(args["generate-descriptions"]);

  const qd = new QdrantClient({ url: cfg.qdrantUrl });

  process.stderr.write(`[migrate] Probing dim for ${toModel}…\n`);
  const newDim = await getDim(toModel);
  process.stderr.write(`[migrate] dim=${newDim}\n`);
  if (projectRoot) process.stderr.write(`[migrate] project-root: ${projectRoot}\n`);

  const { collections } = await qd.getCollections();
  const { aliases }     = await qd.getAliases();
  const existingNames   = new Set([
    ...collections.map((c) => c.name),
    ...aliases.map((a) => a.alias_name),
  ]);

  // ── Memory collections ─────────────────────────────────────────────────────
  // Collections are shared across all projects (isolated by project_id inside).
  // Create dst if it doesn't exist yet, then always upsert into it.
  for (const base of MEMORY_COLS) {
    const srcName = colName(fromPrefix, base);
    const dstName = colName(toPrefix,   base);

    if (!existingNames.has(srcName)) {
      process.stderr.write(`[migrate] Skipping ${srcName} — not found\n`);
      continue;
    }
    if (!existingNames.has(dstName)) {
      await createMemoryCol(qd, dstName, newDim);
      existingNames.add(dstName);
    }

    process.stderr.write(`[migrate] ${srcName} → ${dstName} (project_id=${projectId ?? "all"})…\n`);
    const points = await scrollAll(qd, srcName, projectId);
    process.stderr.write(`[migrate] ${base}: ${points.length} pts → ${toModel} (dim=${newDim})\n`);
    const memProgress = makeProgress(points.length);

    for (const batch of chunkArr(points, BATCH_SIZE)) {
      const payloads = batch.map((p) => (p.payload ?? {}) as Record<string, unknown>);
      const texts    = payloads.map((p) => (p["content"] as string | undefined) ?? "");
      const vecs     = await embedWithModel(toModel, texts, 3000);

      await qd.upsert(dstName, {
        wait:   true,
        points: batch.map((pt, i) => ({ id: pt.id, vector: vecs[i]!, payload: payloads[i] })),
      });
      memProgress.tick(batch.length);
    }

    memProgress.finish();
    process.stderr.write(`[migrate] ${base}: done\n`);
  }

  // ── code_chunks ────────────────────────────────────────────────────────────
  // Also shared across projects. Create dst if needed, then upsert by project_id.
  const srcCode = colName(fromPrefix, CODE_CHUNK);
  const dstCode = colName(toPrefix,   CODE_CHUNK);

  if (!existingNames.has(srcCode)) {
    process.stderr.write(`[migrate] Skipping ${srcCode} — not found\n`);
  } else {
    if (!existingNames.has(dstCode)) {
      await createCodeChunkCol(qd, dstCode, newDim);
    }

    process.stderr.write(`[migrate] ${srcCode} → ${dstCode} (project_id=${projectId ?? "all"})…\n`);
    if (projectId) process.stderr.write(`[migrate] filtering by project_id=${projectId}\n`);
    const points = await scrollAll(qd, srcCode, projectId);
    process.stderr.write(`[migrate] code_chunks: ${points.length} pts → ${toModel} (dim=${newDim})\n`);
    const codeProgress = makeProgress(points.length);

    for (const batch of chunkArr(points, BATCH_SIZE)) {
      const payloads = batch.map((p) => (p.payload ?? {}) as Record<string, unknown>);

      // Re-read content from disk; fallback to payload content if file missing
      const freshContents = payloads.map((p) => readFreshContent(p, projectRoot));

      // Reuse existing description; generate via LLM only if missing + flag set.
      // Sequential to avoid overwhelming Ollama.
      const descriptions: string[] = [];
      for (let i = 0; i < payloads.length; i++) {
        const existing = payloads[i]!["description"] as string | undefined;
        if (existing) {
          descriptions.push(existing);
        } else if (genDescs) {
          const desc = await generateDescription({
            content:   freshContents[i]!,
            name:      (payloads[i]!["name"]       as string) ?? "",
            chunkType: (payloads[i]!["chunk_type"] as string) ?? "unknown",
            language:  (payloads[i]!["language"]   as string) ?? "unknown",
          });
          descriptions.push(desc);
        } else {
          descriptions.push("");
        }
      }

      const codeTexts = payloads.map((p, i) => buildEmbedCtx({ ...p, content: freshContents[i] }));
      const codeVecs  = await embedWithModel(toModel, codeTexts, 4000);

      const descVecs = descriptions.some(Boolean)
        ? await embedWithModel(toModel, descriptions.map((d) => d || " "), 3000)
        : null;

      await qd.upsert(dstCode, {
        wait:   true,
        points: batch.map((pt, i) => ({
          id:      pt.id,
          vector:  {
            code_vector: codeVecs[i]!,
            ...(descriptions[i] && descVecs ? { description_vector: descVecs[i]! } : {}),
          } as Record<string, number[]>,
          payload: { ...payloads[i], content: freshContents[i] },
        })),
      });
      codeProgress.tick(batch.length);
    }

    codeProgress.finish();
    process.stderr.write(`[migrate] code_chunks: done\n`);
  }

  process.stderr.write("[migrate] Done.\n");
}
