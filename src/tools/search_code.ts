import { qd } from "../qdrant.js";
import { embedOne } from "../embedder.js";

export interface SearchCodeArgs {
  query:      string;
  file_path:  string;
  chunk_type: string;
  limit:      number;
}

export async function searchCodeTool(a: SearchCodeArgs): Promise<string> {
  const embedding = await embedOne(a.query);

  const must: Array<{ key: string; match: { value: string } }> = [];
  if (a.file_path)  must.push({ key: "file_path",  match: { value: a.file_path } });
  if (a.chunk_type) must.push({ key: "chunk_type", match: { value: a.chunk_type } });

  const hits = await qd
    .search("code_chunks", {
      vector:          embedding,
      ...(must.length > 0 && { filter: { must } }),
      limit:           a.limit,
      with_payload:    true,
      score_threshold: 0.25,
    })
    .catch((err: unknown): null => {
      process.stderr.write(`[search_code] ${String(err)}\n`);
      return null;
    });

  if (hits === null) return "search error";
  if (hits.length === 0) return "nothing found in codebase.";

  const lines = [`Found ${hits.length} code chunks:\n`];
  for (const hit of hits) {
    const p = (hit.payload ?? {}) as Record<string, unknown>;
    lines.push(`--- [${hit.score.toFixed(2)}] ${p["chunk_type"] ?? "?"} ---`);
    lines.push(`file: ${p["file_path"] ?? "?"}:${p["start_line"] ?? "?"}-${p["end_line"] ?? "?"}`);
    if (p["name"])      lines.push(`name: ${p["name"]}`);
    if (p["signature"]) lines.push(`sig:  ${p["signature"]}`);
    const code = String(p["content"] ?? "");
    lines.push(`\`\`\`\n${code.length > 500 ? code.slice(0, 500) + "\n  ... (truncated)" : code}\n\`\`\`\n`);
  }
  return lines.join("\n");
}
