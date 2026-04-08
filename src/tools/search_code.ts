import { qd, CODE_VECTORS, colName } from "../qdrant.js";
import { embedOne } from "../embedder.js";
import { cfg, getProjectId, getCurrentBranchCached } from "../config.js";
import { rerank as rerankHits } from "../reranker.js";
import type { Schemas } from "@qdrant/js-client-rest";
import { callLlmSimple, defaultRouterSpec } from "../llm-client.js";
import { debugLog } from "../util.js";

export interface SearchCodeArgs {
  query:        string;
  file_path:    string;
  chunk_type:   string;
  limit:        number;
  search_mode:  "hybrid" | "lexical" | "semantic" | "code";
  rerank:       boolean; // default false
  rerank_k:     number;  // ANN candidates before reranking, default 50
  top:          number;  // results to return after reranking, default = limit
  name_pattern: string;  // filter by symbol name substring, default ""
  branch?:      string;  // override branch filter, default = currentBranch
}

type ScoredPoint = Schemas["ScoredPoint"];

export async function searchCodeTool(a: SearchCodeArgs): Promise<string> {
  let searchQuery = a.query;

  // Translation layer: if query is not in English, translate it to improve semantic search
  // against English descriptions and code.
  if (/[а-яА-Я]/.test(a.query)) {
    const translationPrompt = 
      "Translate the following technical search query to English. " +
      "Preserve code identifiers and technical terms as is. " +
      "Output ONLY the translated text.\\n\\n" +
      `Query: ${a.query}`;
    
    try {
      const spec = cfg.routerConfig ?? defaultRouterSpec();
      const translated = await callLlmSimple(translationPrompt, spec);
      if (translated && translated.trim()) {
        debugLog("search_code", `Translated query: "${a.query}" -> "${translated.trim()}"`);
        searchQuery = translated.trim();
      }
    } catch (err) {
      debugLog("search_code", `Translation failed: ${String(err)}`);
    }
  }

  const embedding = await embedOne(searchQuery);

  const branchFilter = a.branch || getCurrentBranchCached();
  const must: Array<{ key: string; match: { value: string } | { text: string } }> = [
    { key: "project_id", match: { value: getProjectId() } },
    { key: "branches",   match: { value: branchFilter  } },
  ];
  // match: { text } without a full-text index performs exact substring matching in Qdrant
  if (a.file_path)    must.push({ key: "file_path",  match: { text:  a.file_path    } });
  if (a.chunk_type)   must.push({ key: "chunk_type", match: { value: a.chunk_type   } });
  if (a.name_pattern) must.push({ key: "name",       match: { text:  a.name_pattern } });

  const filter = { must };
  const mode   = a.search_mode || "hybrid";

  // Fetch more candidates when reranking so the cross-encoder has a good pool to score
  const annLimit = a.rerank ? (a.rerank_k ?? 50) : a.limit;

  const textCondition = {
    should: [
      { key: "name",    match: { text: a.query } },
      { key: "content", match: { text: a.query } },
      { key: "name",    match: { text: searchQuery } },
      { key: "content", match: { text: searchQuery } },
    ],
  };

  let hits: ScoredPoint[];

  if (mode === "hybrid") {
    // Use Qdrant Query API with prefetch + Reciprocal Rank Fusion (3-way: code, description, lexical)
    const result = await qd
      .query(colName("code_chunks"), {
        prefetch: [
          { query: embedding as unknown as number[], using: CODE_VECTORS.code,        limit: annLimit * 2, score_threshold: 0.25 },
          { query: embedding as unknown as number[], using: CODE_VECTORS.description, limit: annLimit * 2, score_threshold: 0.25 },
          { query: embedding as unknown as number[], using: CODE_VECTORS.code, filter: { must: [...must, textCondition] }, limit: annLimit * 2 },
        ] as unknown as Parameters<typeof qd.query>[1]["prefetch"],
        query:        { fusion: "rrf" },
        filter,
        limit:        annLimit,
        with_payload: true,
      })
      .catch((err: unknown): null => {
        process.stderr.write(`[search_code] hybrid: ${String(err)}\n`);
        return null;
      });

    if (result === null) {
      // Fall back to code-only search on error (description_vector may not exist yet)
      hits = await qd
        .search(colName("code_chunks"), {
          vector:          { name: CODE_VECTORS.code, vector: embedding },
          filter,
          limit:           annLimit,
          with_payload:    true,
          score_threshold: 0.25,
        })
        .catch((): ScoredPoint[] => []);
    } else {
      hits = result.points;
    }
  } else if (mode === "lexical") {
    // Text-filtered search: only docs where name or content matches the query terms.
    // Ranked by code_vector similarity among matching docs.
    const lexFilter = { must: [...must, textCondition] };
    hits = await qd
      .search(colName("code_chunks"), {
        vector:       { name: CODE_VECTORS.code, vector: embedding },
        filter:       lexFilter,
        limit:        annLimit,
        with_payload: true,
      })
      .catch((err: unknown): ScoredPoint[] => {
        process.stderr.write(`[search_code] lexical: ${String(err)}\n`);
        return [];
      });
  } else {
    // Single-vector search
    const vectorName = mode === "semantic" ? CODE_VECTORS.description : CODE_VECTORS.code;

    hits = await qd
      .search(colName("code_chunks"), {
        vector:          { name: vectorName, vector: embedding },
        filter,
        limit:           annLimit,
        with_payload:    true,
        score_threshold: 0.25,
      })
      .catch((err: unknown): ScoredPoint[] => {
        process.stderr.write(`[search_code] ${mode}: ${String(err)}\n`);
        return [];
      });
  }

  if (a.rerank && hits.length > 0) {
    hits = await rerankHits(searchQuery, hits, a.top ?? a.limit);
  }

  if (hits.length === 0) return "nothing found in codebase.";

  const lines = [`Found ${hits.length} code chunks: [mode=${mode}${a.rerank ? "+rerank" : ""}]\n`];
  for (const hit of hits) {
    const p = (hit.payload ?? {}) as Record<string, unknown>;
    lines.push(`--- [${hit.score.toFixed(2)}] ${p["chunk_type"] ?? "?"} ---`);
    lines.push(`id:   ${hit.id}`);
    lines.push(`file: ${p["file_path"] ?? "?"}:${p["start_line"] ?? "?"}-${p["end_line"] ?? "?"}`);
    if (p["name"])        lines.push(`name: ${p["name"]}`);
    if (p["signature"])   lines.push(`sig:  ${p["signature"]}`);
    if (p["description"]) lines.push(`desc: ${String(p["description"]).slice(0, 200)}`);
    if (p["parent_id"])   lines.push(`parent: ${p["parent_id"]}`);
    const code = String(p["content"] ?? "");
    lines.push(`\`\`\`\n${code.length > 500 ? code.slice(0, 500) + "\n  ... (truncated)" : code}\n\`\`\`\n`);
  }
  return lines.join("\n");
}
