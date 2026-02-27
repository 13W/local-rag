import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, extname, dirname, resolve }          from "node:path";
import { parseArgs }                                           from "node:util";
import { randomUUID }                                          from "node:crypto";
import { fileURLToPath }                                       from "node:url";
import { QdrantClient }                                        from "@qdrant/js-client-rest";
import type { Schemas }                                        from "@qdrant/js-client-rest";

type ScoredPoint = Schemas["ScoredPoint"];
import { cfg }                                                 from "../src/config.js";
import { parseFile, EXTENSIONS }                               from "../src/indexer/parser.js";
import { generateDescription }                                 from "../src/embedder.js";
import type { CodeChunk }                                      from "../src/types.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const BATCH_SIZE       = 32;
const DESC_CONCURRENCY = 5;

const MODELS: ModelSpec[] = [
  { name: "qwen3-embedding:0.6b", slug: "qwen3_0_6b" },
  { name: "qwen3-embedding:4b",   slug: "qwen3_4b"   },
  { name: "qwen3-embedding:8b",   slug: "qwen3_8b"   },
  { name: "embeddinggemma:300m",  slug: "gemma_300m"  },
  { name: "mxbai-embed-large",    slug: "mxbai_large" },
];

const MODEL_CONFIGS: Record<string, { maxChars: number }> = {
  "mxbai-embed-large":    { maxChars: 800   },
  "embeddinggemma:300m":  { maxChars: 3000  },
  "qwen3-embedding:0.6b": { maxChars: 24000 },
  "qwen3-embedding:4b":   { maxChars: 24000 },
  "qwen3-embedding:8b":   { maxChars: 24000 },
};

// ── Interfaces ─────────────────────────────────────────────────────────────────

interface TimingAccumulator {
  indexMs:       number;
  codeEmbedMs:   number;
  descGenMs:     number;
  descEmbedMs:   number;
  queryEmbedMs:  number;
  searchMs:      number;
  chunksIndexed: number;
}

interface EvalMetrics    { hit1: number; hit3: number; hit5: number; mrr: number; }
interface BenchQuery     { query: string; expectedFile: string; expectedName: string; }
interface ModelSpec      { name: string; slug: string; }
interface ModelResult    { model: string; slug: string; timing: TimingAccumulator; metrics: EvalMetrics; errors: string[]; }
interface BenchmarkReport { timestamp: string; projectDir: string; llmModel: string; results: ModelResult[]; }

// ── Ground-truth queries (49) ──────────────────────────────────────────────────

const QUERIES: BenchQuery[] = [
  // embedder.ts (10)
  { query: "embed batch of text strings",                           expectedFile: "embedder",         expectedName: "embedBatch"          },
  { query: "embed single text string to vector",                    expectedFile: "embedder",         expectedName: "embedOne"            },
  { query: "call Ollama embed API and parse embeddings response",   expectedFile: "embedder",         expectedName: "embedOllama"         },
  { query: "call OpenAI embeddings API with bearer auth",           expectedFile: "embedder",         expectedName: "embedOpenAI"         },
  { query: "call Voyage AI embeddings API",                         expectedFile: "embedder",         expectedName: "embedVoyage"         },
  { query: "retry embedding request on failure with backoff",       expectedFile: "embedder",         expectedName: "embedBatchAttempt"   },
  { query: "generate 1-2 sentence LLM description for code chunk", expectedFile: "embedder",         expectedName: "generateDescription" },
  { query: "filter memory candidates by LLM relevance scoring",    expectedFile: "embedder",         expectedName: "llmFilter"           },
  { query: "call LLM via Ollama generate endpoint",                 expectedFile: "embedder",         expectedName: "callLlmOllama"       },
  { query: "resolve base URL for embedding provider",               expectedFile: "embedder",         expectedName: "resolveEmbedUrl"     },

  // search_code.ts (3)
  { query: "hybrid RRF search over code and description vectors",  expectedFile: "search_code",      expectedName: "searchCodeTool"      },
  { query: "semantic code search with file path substring filter", expectedFile: "search_code",      expectedName: "searchCodeTool"      },
  { query: "interface for search_code tool parameters",            expectedFile: "search_code",      expectedName: "SearchCodeArgs"      },

  // indexer/indexer.ts (5)
  { query: "index all source files in directory into Qdrant",      expectedFile: "indexer/indexer",  expectedName: "indexAll"            },
  { query: "index single file and upsert code chunks to Qdrant",   expectedFile: "indexer/indexer",  expectedName: "indexFile"           },
  { query: "build embed context string from code chunk fields",    expectedFile: "indexer/indexer",  expectedName: "buildEmbedContext"   },
  { query: "collect indexable files respecting gitignore rules",   expectedFile: "indexer/indexer",  expectedName: "collectFiles"        },
  { query: "code indexer class with Qdrant client and description generation", expectedFile: "indexer/indexer", expectedName: "CodeIndexer" },

  // indexer/parser.ts (6)
  { query: "parse TypeScript file into code chunks using tree-sitter", expectedFile: "indexer/parser", expectedName: "parseFile"        },
  { query: "walk AST and extract symbol nodes into CodeChunks",    expectedFile: "indexer/parser",   expectedName: "walkTree"            },
  { query: "extract JSDoc comment block preceding a code node",    expectedFile: "indexer/parser",   expectedName: "extractDoc"          },
  { query: "parse YAML file into document chunks",                 expectedFile: "indexer/parser",   expectedName: "parseYaml"           },
  { query: "parse JSON file into code chunks by top-level keys",   expectedFile: "indexer/parser",   expectedName: "parseJsonFile"       },
  { query: "extract import statements from source file AST",       expectedFile: "indexer/parser",   expectedName: "extractImports"      },

  // types.ts (2)
  { query: "interface for code chunk with filePath language and chunkType",    expectedFile: "types",   expectedName: "CodeChunk"          },
  { query: "Qdrant payload interface for indexed code chunk with description", expectedFile: "types",   expectedName: "CodeChunkPayload"   },

  // qdrant.ts (3)
  { query: "create code_chunks collection with named vectors code_vector and description_vector", expectedFile: "qdrant", expectedName: "ensureCodeChunks" },
  { query: "named vector constant identifiers for code and description",       expectedFile: "qdrant",  expectedName: "CODE_VECTORS"       },
  { query: "ensure all required Qdrant collections exist",                     expectedFile: "qdrant",  expectedName: "ensureCollections"  },

  // config.ts (1)
  { query: "frozen config object with Qdrant URL Ollama URL embed model",      expectedFile: "config",  expectedName: "cfg"                },

  // storage.ts (4)
  { query: "get direct import dependencies of a file from Qdrant",             expectedFile: "storage", expectedName: "getDeps"            },
  { query: "get reverse dependencies - files that import this file",           expectedFile: "storage", expectedName: "getReverseDeps"     },
  { query: "find memory entry metadata by ID across collections",              expectedFile: "storage", expectedName: "getMemoryMeta"      },
  { query: "top files ranked by number of reverse dependencies",               expectedFile: "storage", expectedName: "topFilesByRevDeps"  },

  // server.ts (2)
  { query: "dispatch MCP tool call by tool name to handler",                   expectedFile: "server",  expectedName: "dispatchTool"       },
  { query: "array of all registered MCP tool schema definitions",              expectedFile: "server",  expectedName: "TOOLS"              },

  // tools/* (7)
  { query: "store memory entry with type scope importance and TTL",            expectedFile: "remember",         expectedName: "rememberTool"       },
  { query: "semantic search across memory with time decay and LLM reranking",  expectedFile: "recall",           expectedName: "recallTool"         },
  { query: "read source file and return lines around named symbol",            expectedFile: "get_file_context", expectedName: "getFileContextTool" },
  { query: "get import and reverse dependency graph for a file",               expectedFile: "get_dependencies", expectedName: "getDependenciesTool"},
  { query: "generate project directory tree with language stats",              expectedFile: "project_overview", expectedName: "projectOverviewTool"},
  { query: "count points across all memory and code collections",              expectedFile: "stats",            expectedName: "statsTool"          },
  { query: "delete memory entry by ID from Qdrant collection",                 expectedFile: "forget",           expectedName: "forgetTool"         },

  // util.ts (2)
  { query: "store memory in Qdrant with content hash deduplication",           expectedFile: "util",    expectedName: "storeMemory"        },
  { query: "map memory type string to Qdrant collection name",                 expectedFile: "util",    expectedName: "colForType"         },

  // scoring.ts (2)
  { query: "combine cosine similarity time decay and importance into relevance score", expectedFile: "scoring", expectedName: "finalScore" },
  { query: "exponential time decay based on memory age and half-life",                 expectedFile: "scoring", expectedName: "timeDecay"  },

  // indexer/cli.ts (1)
  { query: "expand root paths and resolve project roots for indexing",         expectedFile: "indexer/cli", expectedName: "expandRoots"    },

  // bin.ts (1)
  { query: "top-level CLI entry point routing to serve init or index commands",expectedFile: "bin",     expectedName: ""                   },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Local copy of buildEmbedContext from indexer.ts (not exported).
 * Truncation is omitted here — embedWithModel applies per-model maxChars.
 */
function buildEmbedCtx(c: CodeChunk): string {
  let ctx = `File: ${c.filePath}\nType: ${c.chunkType}\nName: ${c.name}\n`;
  if (c.jsdoc)     ctx += `JSDoc: ${c.jsdoc}\n`;
  if (c.signature) ctx += `Sig: ${c.signature}\n`;
  ctx += `Code:\n${c.content}`;
  return ctx;
}

function embedWithModel(model: string, texts: string[], maxChars: number): Promise<number[][]> {
  const truncated = texts.map((t) => t.length > maxChars ? t.slice(0, maxChars) : t);
  return fetch(`${cfg.ollamaUrl}/api/embed`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ model, input: truncated }),
    signal:  AbortSignal.timeout(120_000),
  }).then((resp) => {
    if (!resp.ok) {
      return resp.text().catch((): string => "").then((body) =>
        Promise.reject(new Error(`Embed failed [${model}]: ${resp.status} ${resp.statusText} — ${body}`))
      );
    }
    return (resp.json() as Promise<{ embeddings: number[][] }>).then((d) => d.embeddings);
  });
}

function detectDimension(model: string): Promise<number> {
  return embedWithModel(model, ["test"], 100).then((vecs) => {
    const first = vecs[0];
    if (!first) return Promise.reject(new Error("Empty embedding result"));
    return first.length;
  });
}

async function ensureBenchCollection(qd: QdrantClient, slug: string, dim: number): Promise<void> {
  const name = `bench_${slug}`;
  const { collections } = await qd.getCollections();
  if (collections.find((c) => c.name === name)) return;

  await qd.createCollection(name, {
    vectors: {
      code_vector:        { size: dim, distance: "Cosine" },
      description_vector: { size: dim, distance: "Cosine" },
    },
  });
  for (const field of ["file_path", "chunk_type", "language", "name"]) {
    await qd.createPayloadIndex(name, { field_name: field, field_schema: "keyword", wait: true });
  }
  process.stderr.write(`[bench] Created collection: ${name} (dim=${dim})\n`);
}

/** Recursively collect all files under <root>/src/ that the parser can handle. */
function collectSrcFiles(root: string): string[] {
  const results: string[] = [];
  const stack = [join(root, "src")];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st   = statSync(full);
      if (st.isDirectory()) {
        stack.push(full);
      } else if (EXTENSIONS.has(extname(full))) {
        results.push(full);
      }
    }
  }
  return results;
}

async function batchGenerateDescriptions(
  chunks:  CodeChunk[],
  timing:  TimingAccumulator,
  noDescs: boolean,
): Promise<(string | null)[]> {
  if (noDescs) return new Array<string | null>(chunks.length).fill(null);

  const results: (string | null)[] = new Array<string | null>(chunks.length).fill(null);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < chunks.length) {
      const idx   = cursor++;
      const chunk = chunks[idx]!;
      if (chunk.chunkRole === "child") continue;

      const t0   = Date.now();
      const desc = await generateDescription(chunk).catch((): string => "");
      timing.descGenMs += Date.now() - t0;
      results[idx] = desc || null;
    }
  }

  await Promise.all(Array.from({ length: DESC_CONCURRENCY }, () => worker()));
  return results;
}

// ── Indexing ───────────────────────────────────────────────────────────────────

async function indexForModel(
  qd:      QdrantClient,
  model:   ModelSpec,
  srcRoot: string,
  timing:  TimingAccumulator,
  noDescs: boolean,
): Promise<void> {
  const t0Start  = Date.now();
  const maxChars = MODEL_CONFIGS[model.name]?.maxChars ?? 800;
  const colName  = `bench_${model.slug}`;

  // 1. Collect + parse all source files
  const absFiles = collectSrcFiles(srcRoot);
  process.stderr.write(`[bench:${model.name}] ${absFiles.length} files to index\n`);

  const allChunks: CodeChunk[] = [];
  for (const absPath of absFiles) {
    const relPath = relative(srcRoot, absPath).replace(/\\/g, "/");
    const source  = readFileSync(absPath, "utf8");
    const chunks  = await parseFile(relPath, source).catch((err: unknown): CodeChunk[] => {
      process.stderr.write(`[bench:${model.name}] parse error ${relPath}: ${String(err)}\n`);
      return [];
    });
    allChunks.push(...chunks);
  }
  process.stderr.write(`[bench:${model.name}] ${allChunks.length} chunks parsed\n`);

  // 2. Embed code in batches
  const codeTexts = allChunks.map(buildEmbedCtx);
  const t0Code    = Date.now();
  const codeEmbeds: (number[] | null)[] = [];

  for (let i = 0; i < codeTexts.length; i += BATCH_SIZE) {
    const slice = codeTexts.slice(i, i + BATCH_SIZE);
    const batch = await embedWithModel(model.name, slice, maxChars).catch((): null => null);
    if (batch) {
      codeEmbeds.push(...batch);
    } else {
      const individual = await Promise.all(
        slice.map((t) =>
          embedWithModel(model.name, [t], maxChars)
            .then((r): number[] | null => r[0] ?? null)
            .catch((): null => null)
        )
      );
      codeEmbeds.push(...individual);
    }
  }
  timing.codeEmbedMs += Date.now() - t0Code;

  // 3. Generate descriptions (concurrent, respecting child/parent logic)
  const descTexts = await batchGenerateDescriptions(allChunks, timing, noDescs);

  // 4. Embed descriptions in batches
  const descEmbeds: (number[] | null)[] = new Array<number[] | null>(allChunks.length).fill(null);
  const toEmbed: Array<{ idx: number; text: string }> = [];
  for (let i = 0; i < allChunks.length; i++) {
    const d = descTexts[i];
    if (d) toEmbed.push({ idx: i, text: d });
  }

  if (toEmbed.length > 0) {
    const t0Desc = Date.now();
    const dTexts = toEmbed.map((d) => d.text);
    for (let i = 0; i < dTexts.length; i += BATCH_SIZE) {
      const slice = dTexts.slice(i, i + BATCH_SIZE);
      const batch = await embedWithModel(model.name, slice, maxChars).catch((): null => null);
      if (batch) {
        for (let j = 0; j < batch.length; j++) {
          descEmbeds[toEmbed[i + j]!.idx] = batch[j] ?? null;
        }
      }
    }
    timing.descEmbedMs += Date.now() - t0Desc;
  }

  // 5. Assign UUIDs and build parent/child maps
  const chunkIds: string[] = allChunks.map(() => randomUUID());

  const parentKeyToId = new Map<string, string>();
  for (let i = 0; i < allChunks.length; i++) {
    const c = allChunks[i]!;
    if (c.chunkRole === "parent") {
      parentKeyToId.set(`${c.filePath}:${c.startLine}`, chunkIds[i]!);
    }
  }

  const parentToChildren = new Map<string, string[]>();
  for (let i = 0; i < allChunks.length; i++) {
    const c = allChunks[i]!;
    if (c.parentKey) {
      const pid = parentKeyToId.get(c.parentKey);
      if (pid) {
        const arr = parentToChildren.get(pid) ?? [];
        arr.push(chunkIds[i]!);
        parentToChildren.set(pid, arr);
      }
    }
  }

  // 6. Build Qdrant points
  const points: Array<{
    id:      string;
    vector:  Record<string, number[]>;
    payload: Record<string, unknown>;
  }> = [];

  for (let i = 0; i < allChunks.length; i++) {
    const chunk   = allChunks[i]!;
    const id      = chunkIds[i]!;
    const codeVec = codeEmbeds[i];
    const descVec = descEmbeds[i];

    const isParent = chunk.chunkRole === "parent";
    const isChild  = chunk.chunkRole === "child";

    const vector: Record<string, number[]> = {};
    if (!isParent && codeVec) vector["code_vector"]        = codeVec;
    if (!isChild  && descVec) vector["description_vector"] = descVec;
    if (Object.keys(vector).length === 0) continue;

    const parentId    = chunk.parentKey ? parentKeyToId.get(chunk.parentKey) : undefined;
    const childrenIds = parentToChildren.get(id);

    const payload: Record<string, unknown> = {
      content:    chunk.content,
      file_path:  chunk.filePath,
      chunk_type: chunk.chunkType,
      name:       chunk.name,
      signature:  chunk.signature,
      start_line: chunk.startLine,
      end_line:   chunk.endLine,
      language:   chunk.language,
      jsdoc:      chunk.jsdoc,
    };
    if (descTexts[i]) payload["description"]  = descTexts[i];
    if (isParent)     payload["is_parent"]     = true;
    if (parentId)     payload["parent_id"]     = parentId;
    if (childrenIds)  payload["children_ids"]  = childrenIds;

    points.push({ id, vector, payload });
  }

  // 7. Upsert in batches of 100
  for (let i = 0; i < points.length; i += 100) {
    await qd.upsert(colName, { points: points.slice(i, i + 100) });
  }

  timing.chunksIndexed += points.length;
  timing.indexMs        = Date.now() - t0Start;
  process.stderr.write(`[bench:${model.name}] Indexed ${points.length} points (${timing.indexMs}ms)\n`);
}

// ── Evaluation ─────────────────────────────────────────────────────────────────

async function evaluateModel(
  qd:      QdrantClient,
  model:   ModelSpec,
  queries: BenchQuery[],
  timing:  TimingAccumulator,
): Promise<EvalMetrics> {
  const maxChars = MODEL_CONFIGS[model.name]?.maxChars ?? 800;
  const colName  = `bench_${model.slug}`;

  let hit1 = 0, hit3 = 0, hit5 = 0, mrr = 0;

  for (const q of queries) {
    // Embed the query
    const t0Embed = Date.now();
    const vecs    = await embedWithModel(model.name, [q.query], maxChars).catch((): null => null);
    timing.queryEmbedMs += Date.now() - t0Embed;
    if (!vecs || !vecs[0]) continue;
    const vec = vecs[0];

    // Hybrid RRF search (same pattern as search_code.ts)
    const t0Search = Date.now();
    const result   = await qd.query(colName, {
      prefetch: [
        { query: vec as unknown as number[], using: "code_vector",        limit: 10 },
        { query: vec as unknown as number[], using: "description_vector", limit: 10 },
      ] as unknown as Parameters<typeof qd.query>[1]["prefetch"],
      query:        { fusion: "rrf" },
      limit:        5,
      with_payload: true,
    }).catch((): null => null);
    timing.searchMs += Date.now() - t0Search;

    let hits: ScoredPoint[];
    if (result === null) {
      // Fall back to code-only search (description_vector may not exist)
      hits = await qd.search(colName, {
        vector:       { name: "code_vector", vector: vec },
        limit:        5,
        with_payload: true,
      }).catch((): ScoredPoint[] => []);
    } else {
      hits = result.points;
    }

    // Score: find the rank of the expected chunk
    let rank = -1;
    for (let r = 0; r < hits.length; r++) {
      const p         = (hits[r]!.payload ?? {}) as Record<string, unknown>;
      const filePath  = String(p["file_path"] ?? "");
      const name      = String(p["name"] ?? "");
      const fileMatch = filePath.includes(q.expectedFile);
      const nameMatch = q.expectedName === "" || name.includes(q.expectedName);
      if (fileMatch && nameMatch) { rank = r + 1; break; }
    }

    if (rank === 1)              hit1++;
    if (rank >= 1 && rank <= 3)  hit3++;
    if (rank >= 1 && rank <= 5)  hit5++;
    if (rank >= 1)               mrr += 1 / rank;
  }

  const n = queries.length;
  return { hit1: hit1 / n, hit3: hit3 / n, hit5: hit5 / n, mrr: mrr / n };
}

// ── Orchestrator ───────────────────────────────────────────────────────────────

async function runModelBenchmark(
  model:     ModelSpec,
  srcRoot:   string,
  queries:   BenchQuery[],
  skipIndex: boolean,
  noDescs:   boolean,
): Promise<ModelResult> {
  const qd      = new QdrantClient({ url: cfg.qdrantUrl });
  const errors: string[] = [];
  const timing: TimingAccumulator = {
    indexMs: 0, codeEmbedMs: 0, descGenMs: 0, descEmbedMs: 0,
    queryEmbedMs: 0, searchMs: 0, chunksIndexed: 0,
  };

  process.stderr.write(`\n[bench] ═══ ${model.name} ═══\n`);

  const dim = await detectDimension(model.name).catch((err: unknown): number => {
    errors.push(`detectDimension: ${String(err)}`);
    return 0;
  });

  if (dim === 0) {
    process.stderr.write(`[bench:${model.name}] SKIP — could not detect embedding dimension\n`);
    return { model: model.name, slug: model.slug, timing, metrics: { hit1: 0, hit3: 0, hit5: 0, mrr: 0 }, errors };
  }
  process.stderr.write(`[bench:${model.name}] dim=${dim}\n`);

  await ensureBenchCollection(qd, model.slug, dim).catch((err: unknown) => {
    errors.push(`ensureBenchCollection: ${String(err)}`);
  });

  // When --skip-index is set, only skip if the collection already has points.
  // If the collection is empty or missing, fall back to full indexing.
  const existingCount = skipIndex
    ? (await qd.getCollection(`bench_${model.slug}`).catch((): null => null))?.points_count ?? 0
    : 0;

  if (skipIndex && existingCount > 0) {
    process.stderr.write(`[bench:${model.name}] Skipping indexing (${existingCount} points already indexed)\n`);
    timing.chunksIndexed = existingCount;
  } else {
    if (skipIndex) {
      process.stderr.write(`[bench:${model.name}] Collection empty — running indexing anyway\n`);
    }
    await indexForModel(qd, model, srcRoot, timing, noDescs).catch((err: unknown) => {
      errors.push(`indexForModel: ${String(err)}`);
    });
  }

  const metrics = await evaluateModel(qd, model, queries, timing).catch((err: unknown): EvalMetrics => {
    errors.push(`evaluateModel: ${String(err)}`);
    return { hit1: 0, hit3: 0, hit5: 0, mrr: 0 };
  });

  return { model: model.name, slug: model.slug, timing, metrics, errors };
}

// ── Output ─────────────────────────────────────────────────────────────────────

function writeJsonResults(report: BenchmarkReport): void {
  writeFileSync("benchmark_results.json", JSON.stringify(report, null, 2), "utf8");
  process.stdout.write("Wrote benchmark_results.json\n");
}

function writeMarkdownReport(report: BenchmarkReport): void {
  const lines = [
    "# Embedding Model Benchmark Report",
    "",
    `**Date:** ${report.timestamp}`,
    `**Project:** ${report.projectDir}`,
    `**LLM:** ${report.llmModel}`,
    "",
    "## Quality Metrics",
    "",
    "| Model | Chunks | Hit@1 | Hit@3 | Hit@5 | MRR | IndexMs | QEmbedMs | SearchMs |",
    "|----------------------|-------:|------:|------:|------:|-----:|--------:|---------:|---------:|",
  ];

  for (const r of report.results) {
    const m = r.metrics;
    const t = r.timing;
    lines.push(
      `| ${r.model} | ${t.chunksIndexed} | ${m.hit1.toFixed(2)} | ${m.hit3.toFixed(2)} | ${m.hit5.toFixed(2)} | ${m.mrr.toFixed(2)} | ${t.indexMs} | ${t.queryEmbedMs} | ${t.searchMs} |`
    );
  }

  lines.push("", "## Timing Breakdown", "");
  lines.push("| Model | CodeEmbedMs | DescGenMs | DescEmbedMs |");
  lines.push("|----------------------|------------:|----------:|------------:|");
  for (const r of report.results) {
    const t = r.timing;
    lines.push(`| ${r.model} | ${t.codeEmbedMs} | ${t.descGenMs} | ${t.descEmbedMs} |`);
  }

  const errored = report.results.filter((r) => r.errors.length > 0);
  if (errored.length > 0) {
    lines.push("", "## Errors", "");
    for (const r of errored) {
      lines.push(`### ${r.model}`);
      for (const e of r.errors) lines.push(`- ${e}`);
      lines.push("");
    }
  }

  writeFileSync("benchmark_report.md", lines.join("\n") + "\n", "utf8");
  process.stdout.write("Wrote benchmark_report.md\n");
}

// ── Entry point ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values: cliArgs } = parseArgs({
    args:    process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      "models":       { type: "string"  },
      "skip-index":   { type: "boolean" },
      "descriptions": { type: "boolean" },  // --no-descriptions → false
    },
    allowPositionals: false,
    strict:           false,
  });

  const skipIndex = cliArgs["skip-index"]   === true;
  const noDescs   = cliArgs["descriptions"] === false;
  const modelsArg = cliArgs["models"] as string | undefined;

  let modelsToRun = MODELS;
  if (modelsArg) {
    const names = modelsArg.split(",").map((m) => m.trim());
    modelsToRun = MODELS.filter((m) => names.includes(m.name));
    if (modelsToRun.length === 0) {
      process.stderr.write(`[bench] No matching models for: ${modelsArg}\n`);
      process.stderr.write(`[bench] Available: ${MODELS.map((m) => m.name).join(", ")}\n`);
      return;
    }
  }

  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  process.stdout.write(`[bench] Project root : ${projectRoot}\n`);
  process.stdout.write(`[bench] Models       : ${modelsToRun.map((m) => m.name).join(", ")}\n`);
  process.stdout.write(`[bench] skipIndex    : ${skipIndex}\n`);
  process.stdout.write(`[bench] noDescs      : ${noDescs}\n`);
  process.stdout.write(`[bench] Queries      : ${QUERIES.length}\n`);

  const results: ModelResult[] = [];

  for (const model of modelsToRun) {
    const result = await runModelBenchmark(model, projectRoot, QUERIES, skipIndex, noDescs);
    results.push(result);

    const m = result.metrics;
    process.stdout.write(
      `[bench] ${model.name}: hit@1=${m.hit1.toFixed(2)} hit@3=${m.hit3.toFixed(2)} hit@5=${m.hit5.toFixed(2)} mrr=${m.mrr.toFixed(2)}\n`
    );
    if (result.errors.length > 0) {
      process.stdout.write(`[bench] ${model.name}: ${result.errors.length} error(s)\n`);
      for (const e of result.errors) process.stderr.write(`  - ${e}\n`);
    }
  }

  const report: BenchmarkReport = {
    timestamp:  new Date().toISOString(),
    projectDir: projectRoot,
    llmModel:   cfg.llmModel,
    results,
  };

  writeJsonResults(report);
  writeMarkdownReport(report);
  process.stdout.write("\n[bench] Done.\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`[bench] Fatal: ${String(err)}\n`);
  process.exit(1);
});
