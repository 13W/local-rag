import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { qd, colName } from "../qdrant.js";
import { cfg } from "../config.js";

export interface GetFileContextArgs {
  file_path:     string;
  symbol_name:   string;
  start_line:    number;
  end_line:      number;
  context_lines: number;
}

const MAX_LINES = 500;

export async function getFileContextTool(a: GetFileContextArgs): Promise<string> {
  const projectRoot = cfg.projectRoot || process.cwd();
  const absPath     = resolve(join(projectRoot, a.file_path));

  // Read the file
  const source = await readFile(absPath, "utf8").catch((err: unknown) =>
    Promise.reject(new Error(`Cannot read '${a.file_path}': ${String(err)}`))
  );
  const allLines = source.split("\n");

  // Fetch all chunks for this file from Qdrant (for metadata)
  const scrollResult = await qd
    .scroll(colName("code_chunks"), {
      filter: {
        must: [
          { key: "file_path",  match: { value: a.file_path   } },
          { key: "project_id", match: { value: cfg.projectId } },
        ],
      },
      limit:        200,
      with_payload: ["name", "chunk_type", "start_line", "end_line", "signature", "parent_id", "is_parent"],
      with_vector:  false,
    })
    .catch((): { points: [] } => ({ points: [] }));

  const symbols = scrollResult.points.map((p) => {
    const pl = (p.payload ?? {}) as Record<string, unknown>;
    return {
      id:         String(p.id),
      name:       String(pl["name"]      ?? ""),
      chunkType:  String(pl["chunk_type"]?? ""),
      startLine:  Number(pl["start_line"] ?? 0),
      endLine:    Number(pl["end_line"]   ?? 0),
      signature:  String(pl["signature"] ?? ""),
      isParent:   Boolean(pl["is_parent"]),
      parentId:   pl["parent_id"] ? String(pl["parent_id"]) : undefined,
    };
  });

  // Determine line range to return
  let startLine: number;
  let endLine:   number;
  const ctxLines = a.context_lines > 0 ? a.context_lines : 10;

  if (a.symbol_name) {
    // Find symbol in Qdrant payload
    const sym = symbols.find(
      (s) => s.name.toLowerCase() === a.symbol_name.toLowerCase()
    );
    if (!sym) {
      return `Symbol '${a.symbol_name}' not found in indexed chunks for '${a.file_path}'.`;
    }
    startLine = Math.max(1, sym.startLine - ctxLines);
    endLine   = Math.min(allLines.length, sym.endLine + ctxLines);
  } else if (a.start_line > 0 || a.end_line > 0) {
    startLine = Math.max(1, a.start_line > 0 ? a.start_line : 1);
    endLine   = a.end_line > 0
      ? Math.min(allLines.length, a.end_line)
      : Math.min(allLines.length, startLine + MAX_LINES - 1);
  } else {
    // Return entire file (up to MAX_LINES)
    startLine = 1;
    endLine   = Math.min(allLines.length, MAX_LINES);
  }

  const selectedLines = allLines.slice(startLine - 1, endLine);
  const truncated     = endLine < allLines.length && !a.symbol_name && !a.start_line && !a.end_line;

  const lines: string[] = [
    `File: ${a.file_path} (lines ${startLine}–${endLine} of ${allLines.length})`,
    "",
    "```",
    ...selectedLines.map((l, i) => `${String(startLine + i).padStart(4, " ")} | ${l}`),
    "```",
  ];

  if (truncated) {
    lines.push(`\n⚠ File truncated at ${MAX_LINES} lines. Use start_line/end_line or symbol_name for more.`);
  }

  // Append symbol metadata for this file
  if (symbols.length > 0) {
    lines.push("\n--- Indexed symbols in this file ---");
    for (const s of symbols) {
      const parentNote = s.parentId ? ` [child]` : s.isParent ? ` [parent]` : "";
      lines.push(`  ${s.chunkType.padEnd(14)} ${s.name}  (lines ${s.startLine}–${s.endLine})${parentNote}`);
    }
  }

  return lines.join("\n");
}
