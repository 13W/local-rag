import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { cfg } from "../config.js";
import { qd, colName } from "../qdrant.js";
import { topFilesByRevDeps } from "../storage.js";

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage",
  "__tests__", "vendor", "charts", "testdata", "__pycache__",
]);

interface DirTree {
  name: string;
  type: "dir" | "file";
  children?: DirTree[];
}

function buildDirTree(absDir: string, depth: number, maxDepth: number): DirTree[] {
  if (depth >= maxDepth) return [];
  const entries: DirTree[] = [];
  const items = readdirSync(absDir).sort();
  for (const item of items) {
    if (item.startsWith(".")) continue;
    const abs = join(absDir, item);
    const st  = statSync(abs);
    if (st.isDirectory()) {
      if (IGNORE_DIRS.has(item)) continue;
      entries.push({
        name:     item,
        type:     "dir",
        children: buildDirTree(abs, depth + 1, maxDepth),
      });
    } else {
      entries.push({ name: item, type: "file" });
    }
  }
  return entries;
}

function renderTree(tree: DirTree[], prefix = ""): string[] {
  const lines: string[] = [];
  for (let i = 0; i < tree.length; i++) {
    const node      = tree[i]!;
    const isLast    = i === tree.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const childPfx  = isLast ? "    " : "│   ";
    lines.push(`${prefix}${connector}${node.name}${node.type === "dir" ? "/" : ""}`);
    if (node.children && node.children.length > 0) {
      lines.push(...renderTree(node.children, prefix + childPfx));
    }
  }
  return lines;
}

function readEntryPoints(root: string): string[] {
  const pts: string[] = [];

  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    const scripts = pkg["scripts"] as Record<string, string> | undefined;
    if (typeof pkg["main"]  === "string") pts.push(`main: ${pkg["main"]}`);
    if (typeof pkg["bin"]   === "string") pts.push(`bin: ${pkg["bin"]}`);
    if (typeof pkg["bin"]   === "object" && pkg["bin"] !== null) {
      for (const [k, v] of Object.entries(pkg["bin"] as Record<string, string>)) {
        pts.push(`bin[${k}]: ${v}`);
      }
    }
    if (scripts) {
      for (const [k, v] of Object.entries(scripts).slice(0, 6)) {
        pts.push(`script[${k}]: ${v}`);
      }
    }
    return pts;
  }

  const cargoPath = join(root, "Cargo.toml");
  if (existsSync(cargoPath)) {
    pts.push("Rust project (Cargo.toml)");
    const src = join(root, "src", "main.rs");
    if (existsSync(src)) pts.push("entry: src/main.rs");
    const lib = join(root, "src", "lib.rs");
    if (existsSync(lib)) pts.push("entry: src/lib.rs");
    return pts;
  }

  const gomod = join(root, "go.mod");
  if (existsSync(gomod)) {
    const mod = readFileSync(gomod, "utf8").split("\n")[0] ?? "";
    pts.push(`Go module: ${mod.replace("module ", "").trim()}`);
    return pts;
  }

  return pts;
}

async function getLanguageStats(root: string): Promise<Record<string, number>> {
  const extLang: Record<string, string> = {
    ".ts": "TypeScript", ".tsx": "TypeScript",
    ".js": "JavaScript", ".jsx": "JavaScript",
    ".rs": "Rust", ".go": "Go",
    ".py": "Python", ".rb": "Ruby",
    ".java": "Java", ".kt": "Kotlin",
    ".yaml": "YAML", ".yml": "YAML",
    ".json": "JSON", ".toml": "TOML",
  };
  const counts: Record<string, number> = {};

  function walk(dir: string): void {
    for (const item of readdirSync(dir)) {
      if (item.startsWith(".")) continue;
      const abs = join(dir, item);
      const st  = statSync(abs);
      if (st.isDirectory()) {
        if (!IGNORE_DIRS.has(item)) walk(abs);
      } else {
        const ext  = item.slice(item.lastIndexOf("."));
        const lang = extLang[ext];
        if (lang) counts[lang] = (counts[lang] ?? 0) + 1;
      }
    }
  }
  walk(root);
  return counts;
}

async function getAllIndexedFilePaths(): Promise<string[]> {
  // Scroll through Qdrant to find all unique file_paths for this project
  const seen = new Set<string>();
  let offset: string | number | undefined;

  while (true) {
    const result = await qd
      .scroll(colName("code_chunks"), {
        filter: { must: [{ key: "project_id", match: { value: cfg.projectId } }] },
        limit:        500,
        with_payload: ["file_path"],
        with_vector:  false,
        ...(offset !== undefined && { offset }),
      })
      .catch((): { points: []; next_page_offset: undefined } => ({ points: [], next_page_offset: undefined }));

    for (const p of result.points) {
      const fp = (p.payload as Record<string, unknown> | null | undefined)?.["file_path"];
      if (typeof fp === "string") seen.add(fp);
    }

    const next = (result as { next_page_offset?: string | number | null }).next_page_offset;
    if (!next) break;
    offset = next;
  }

  return [...seen].sort();
}

export async function projectOverviewTool(): Promise<string> {
  const root = resolve(cfg.projectRoot || process.cwd());

  const [tree, entryPoints, langStats, allFiles, collectionInfo] = await Promise.all([
    Promise.resolve(buildDirTree(root, 0, 3)),
    Promise.resolve(readEntryPoints(root)),
    getLanguageStats(root),
    getAllIndexedFilePaths(),
    qd.getCollection(colName("code_chunks")).catch(() => null),
  ]);

  // Top files by reverse-dep count
  const topFiles = await topFilesByRevDeps(cfg.projectId, allFiles, 10).catch(() => []);

  const lines: string[] = [
    `# Project Overview: ${root}`,
    "",
    "## Directory Structure (top 3 levels)",
    "```",
    `.`,
    ...renderTree(tree),
    "```",
    "",
  ];

  if (entryPoints.length > 0) {
    lines.push("## Entry Points");
    for (const ep of entryPoints) lines.push(`  ${ep}`);
    lines.push("");
  }

  lines.push("## Language Distribution");
  for (const [lang, count] of Object.entries(langStats).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${lang.padEnd(14)}: ${count} files`);
  }
  lines.push("");

  if (collectionInfo) {
    lines.push(`## Code Index`);
    lines.push(`  ${collectionInfo.points_count ?? 0} chunks indexed`);
    lines.push(`  ${allFiles.length} files indexed`);
    lines.push("");
  }

  if (topFiles.length > 0) {
    lines.push("## Core Modules (most imported)");
    for (const { filePath, count } of topFiles) {
      lines.push(`  ${filePath}  (${count} importers)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
