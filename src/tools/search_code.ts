import { qd, CODE_VECTORS } from "../qdrant.js";
import { embedOne } from "../embedder.js";
import { cfg } from "../config.js";
import type { Schemas } from "@qdrant/js-client-rest";

export interface SearchCodeArgs {
  query:       string;
  file_path:   string;
  chunk_type:  string;
  limit:       number;
  search_mode: string;
}

type ScoredPoint = Schemas["ScoredPoint"];

export async function searchCodeTool(a: SearchCodeArgs): Promise<string> {
  const embedding = await embedOne(a.query);

  const must: Array<{ key: string; match: { value: string } }> = [
    { key: "project_id", match: { value: cfg.projectId } },
  ];
  if (a.file_path)  must.push({ key: "file_path",  match: { value: a.file_path  } });
  if (a.chunk_type) must.push({ key: "chunk_type", match: { value: a.chunk_type } });

  const filter = { must };
  const mode   = a.search_mode || "hybrid";

  let hits: ScoredPoint[];

  if (mode === "hybrid") {
    // Use Qdrant Query API with prefetch + Reciprocal Rank Fusion
    const result = await qd
      .query("code_chunks", {
        prefetch: [
          { query: embedding as unknown as number[], using: CODE_VECTORS.code,        limit: a.limit * 2 },
          { query: embedding as unknown as number[], using: CODE_VECTORS.description, limit: a.limit * 2 },
        ],
        query:        { fusion: "rrf" },
        filter,
        limit:        a.limit,
        with_payload: true,
      })
      .catch((err: unknown): null => {
        process.stderr.write(`[search_code] hybrid: ${String(err)}\n`);
        return null;
      });

    if (result === null) {
      // Fall back to code-only search on error (description_vector may not exist yet)
      hits = await qd
        .search("code_chunks", {
          vector:          { name: CODE_VECTORS.code, vector: embedding },
          filter,
          limit:           a.limit,
          with_payload:    true,
          score_threshold: 0.25,
        })
        .catch((): ScoredPoint[] => []);
    } else {
      hits = result.points;
    }
  } else {
    // Single-vector search
    const vectorName = mode === "semantic" ? CODE_VECTORS.description : CODE_VECTORS.code;

    hits = await qd
      .search("code_chunks", {
        vector:          { name: vectorName, vector: embedding },
        filter,
        limit:           a.limit,
        with_payload:    true,
        score_threshold: 0.25,
      })
      .catch((err: unknown): ScoredPoint[] => {
        process.stderr.write(`[search_code] ${mode}: ${String(err)}\n`);
        return [];
      });
  }

  if (hits.length === 0) return "nothing found in codebase.";

  const lines = [`Found ${hits.length} code chunks:\n`];
  for (const hit of hits) {
    const p = (hit.payload ?? {}) as Record<string, unknown>;
    lines.push(`--- [${hit.score.toFixed(2)}] ${p["chunk_type"] ?? "?"} ---`);
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
