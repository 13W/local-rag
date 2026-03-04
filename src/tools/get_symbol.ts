import { qd, colName } from "../qdrant.js";

export interface GetSymbolArgs { symbol_id: string; }

export async function getSymbolTool(a: GetSymbolArgs): Promise<string> {
  const pts = await qd.retrieve(colName("code_chunks"), {
    ids: [a.symbol_id], with_payload: true, with_vector: false,
  }).catch((): never[] => []);

  if (pts.length === 0) return `Symbol '${a.symbol_id}' not found.`;

  const p = (pts[0].payload ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  lines.push(`id:   ${a.symbol_id}`);
  lines.push(`file: ${p["file_path"] ?? "?"}:${p["start_line"] ?? "?"}-${p["end_line"] ?? "?"}`);
  if (p["chunk_type"]) lines.push(`type: ${p["chunk_type"]}`);
  if (p["name"])       lines.push(`name: ${p["name"]}`);
  if (p["signature"])  lines.push(`sig:  ${p["signature"]}`);
  if (p["jsdoc"])      lines.push(`doc:  ${p["jsdoc"]}`);
  const code = String(p["content"] ?? "");
  lines.push(`\`\`\`\n${code}\n\`\`\``);
  return lines.join("\n");
}
