import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { glob, lstat } from "node:fs/promises";
import { CodeIndexer } from "./indexer.js";
import { startWatcher } from "./watcher.js";
import { cfg } from "../config.js";
import { migrateMeta } from "../storage.js";

const USAGE = `
Usage:
  local-rag index  <root>        — index all files under <root>
  local-rag watch  <root>        — index then watch for changes
  local-rag clear                — remove all indexed chunks for this project
  local-rag stats                — show collection stats
  local-rag file   <abs> <root>  — index a single file
  local-rag migrate-imports <root>   — fix imports paths in existing index
  local-rag migrate-meta             — add missing payload fields to memory points (no re-embedding)

Options:
  -c, --config <file>         Load options from a JSON config file
  --generate-descriptions     Generate LLM descriptions for code chunks (slow, uses --llm-model)
`.trim();

const { positionals } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    "config": { type: "string", short: "c" },
  },
  allowPositionals: true,
  strict: false,
});
const [cmd, arg2, arg3] = positionals;

if (!cmd) {
  process.stderr.write(USAGE + "\n");
  process.exit(1);
}

const indexer = new CodeIndexer({ generateDescriptions: cfg.generateDescriptions });
await indexer.ensureCollection();

async function expandRoots(root: string): Promise<string[]> {
  if (!cfg.includePaths.length) return [root];
  const base = cfg.projectRoot ? resolve(cfg.projectRoot) : root;
  const results: string[] = [];
  for await (const match of glob(cfg.includePaths, { cwd: base })) {
    const abs = join(base, match);
    const s = await lstat(abs);
    if (s.isDirectory()) results.push(abs);
  }
  if (!results.length) {
    process.stderr.write(`[cli] Warning: include-paths matched no directories under ${base}\n`);
  }
  return results;
}

if (cmd === "index") {
  const root  = resolve(arg2 ?? ".");
  const roots = await expandRoots(root);
  for (const r of roots) await indexer.indexAll(r);
  process.exit(0);

} else if (cmd === "watch") {
  const root  = resolve(arg2 ?? ".");
  const roots = await expandRoots(root);
  for (const r of roots) {
    await indexer.indexAll(r);
    startWatcher(r, indexer);
  }
  process.on("SIGINT",  () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

} else if (cmd === "clear") {
  await indexer.clear();
  process.exit(0);

} else if (cmd === "stats") {
  await indexer.stats();
  process.exit(0);

} else if (cmd === "file") {
  if (!arg2) { process.stderr.write("Usage: cli.js file <abs-path> [root]\n"); process.exit(1); }
  const absPath = resolve(arg2);
  const root    = resolve(arg3 ?? ".");
  const n = await indexer.indexFile(absPath, root);
  process.stdout.write(`${n} chunks indexed\n`);
  process.exit(0);

} else if (cmd === "migrate-imports") {
  const root = resolve(arg2 ?? ".");
  await indexer.migrateImports(root);
  process.exit(0);

} else if (cmd === "migrate-meta") {
  const { updated, total } = await migrateMeta(cfg.projectId);
  process.stdout.write(`[migrate-meta] ${updated} of ${total} memory points updated\n`);
  process.exit(0);

} else {
  process.stderr.write(`Unknown command: ${cmd}\n\n${USAGE}\n`);
  process.exit(1);
}
