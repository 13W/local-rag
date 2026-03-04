import { qd, colName, CODE_VECTORS } from "../qdrant.js";
import { embedOne } from "../embedder.js";
import { cfg } from "../config.js";
import type { Schemas } from "@qdrant/js-client-rest";

type ScoredPoint = Schemas["ScoredPoint"];

export interface FindUsagesArgs { symbol_id: string; limit: number; }

export async function findUsagesTool(a: FindUsagesArgs): Promise<string> {
  const limit = Math.min(a.limit > 0 ? a.limit : 20, 50);

  // 1. Retrieve target symbol
  const pts = await qd.retrieve(colName("code_chunks"), {
    ids: [a.symbol_id], with_payload: true, with_vector: false,
  }).catch((): never[] => []);
  if (pts.length === 0) return `Symbol '${a.symbol_id}' not found.`;

  const p         = (pts[0].payload ?? {}) as Record<string, unknown>;
  const name      = String(p["name"]      ?? "");
  const signature = String(p["signature"] ?? name);
  const filePath  = String(p["file_path"] ?? "");
  if (!name) return `Symbol '${a.symbol_id}' has no name.`;

  const projectFilter = { must: [{ key: "project_id", match: { value: cfg.projectId } }] };
  const textCondition = {
    should: [
      { key: "name",    match: { text: name } },
      { key: "content", match: { text: name } },
    ],
  };
  const lexFilter = { must: [...projectFilter.must, textCondition] };

  const embedding = await embedOne(signature);

  // 2. Lexical + semantic in parallel
  const [lexHits, semHits] = await Promise.all([
    qd.search(colName("code_chunks"), {
      vector: { name: CODE_VECTORS.code, vector: embedding },
      filter: lexFilter, limit, with_payload: true,
    }).catch((): ScoredPoint[] => []),
    qd.search(colName("code_chunks"), {
      vector: { name: CODE_VECTORS.description, vector: embedding },
      filter: projectFilter, limit, with_payload: true, score_threshold: 0.45,
    }).catch((): ScoredPoint[] => []),
  ]);

  // 3. Merge (lexical first), dedup, exclude self
  const seen = new Set<string | number>([a.symbol_id]);
  const merged: ScoredPoint[] = [];
  for (const hit of [...lexHits, ...semHits]) {
    if (!seen.has(hit.id)) { seen.add(hit.id); merged.push(hit); }
  }
  const lexIds = new Set(lexHits.map(h => h.id));

  if (merged.length === 0) return `No usages found for '${name}' (${filePath}).`;

  const lines: string[] = [`Usages of '${name}' (${filePath}): ${merged.length} result(s)\n`];
  for (const hit of merged.slice(0, limit)) {
    const hp  = (hit.payload ?? {}) as Record<string, unknown>;
    const leg = lexIds.has(hit.id) ? "lexical" : "semantic";
    lines.push(`--- [${leg}] ${hp["chunk_type"] ?? "?"} ---`);
    lines.push(`id:   ${hit.id}`);
    lines.push(`file: ${hp["file_path"] ?? "?"}:${hp["start_line"] ?? "?"}-${hp["end_line"] ?? "?"}`);
    if (hp["name"])      lines.push(`name: ${hp["name"]}`);
    if (hp["signature"]) lines.push(`sig:  ${hp["signature"]}`);
    const code = String(hp["content"] ?? "");
    lines.push(`\`\`\`\n${code.length > 400 ? code.slice(0, 400) + "\n  ... (truncated)" : code}\n\`\`\`\n`);
  }
  return lines.join("\n");
}
