import { cfg } from "../config.js";
import { getDeps, getReverseDeps, getTransitiveDeps } from "../storage.js";

export interface GetDependenciesArgs {
  file_path: string;
  direction: string;
  depth:     number;
}

export async function getDependenciesTool(a: GetDependenciesArgs): Promise<string> {
  const direction = (a.direction === "imports" || a.direction === "imported_by")
    ? a.direction
    : "both";
  const depth = Math.min(Math.max(a.depth > 0 ? a.depth : 1, 1), 5);

  const lines: string[] = [`Dependency graph for: ${a.file_path}\n`];

  if (direction === "imports" || direction === "both") {
    if (depth === 1) {
      const deps = await getDeps(cfg.projectId, a.file_path);
      lines.push(`Imports (${deps.length}):`);
      if (deps.length === 0) {
        lines.push("  (none)");
      } else {
        for (const d of deps) lines.push(`  → ${d}`);
      }
    } else {
      const depMap = await getTransitiveDeps(cfg.projectId, a.file_path, depth, "imports");
      lines.push(`Transitive imports (depth ≤${depth}, ${depMap.size} files):`);
      if (depMap.size === 0) {
        lines.push("  (none)");
      } else {
        for (const [fp, lvl] of [...depMap.entries()].sort((a2, b) => a2[1] - b[1])) {
          lines.push(`  ${"  ".repeat(lvl)}→ ${fp} (depth ${lvl})`);
        }
      }
    }
    lines.push("");
  }

  if (direction === "imported_by" || direction === "both") {
    if (depth === 1) {
      const revDeps = await getReverseDeps(cfg.projectId, a.file_path);
      lines.push(`Imported by (${revDeps.length}):`);
      if (revDeps.length === 0) {
        lines.push("  (none)");
      } else {
        for (const d of revDeps) lines.push(`  ← ${d}`);
      }
    } else {
      const depMap = await getTransitiveDeps(cfg.projectId, a.file_path, depth, "imported_by");
      lines.push(`Transitive importers (depth ≤${depth}, ${depMap.size} files):`);
      if (depMap.size === 0) {
        lines.push("  (none)");
      } else {
        for (const [fp, lvl] of [...depMap.entries()].sort((a2, b) => a2[1] - b[1])) {
          lines.push(`  ${"  ".repeat(lvl)}← ${fp} (depth ${lvl})`);
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
