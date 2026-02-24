import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { CodeIndexer } from "./indexer.js";
import { startWatcher } from "./watcher.js";
import { cfg } from "../config.js";

const USAGE = `
Usage:
  node dist/indexer/cli.js index  <root>        — index all files under <root>
  node dist/indexer/cli.js watch  <root>        — index then watch for changes
  node dist/indexer/cli.js clear                — remove all indexed chunks for this project
  node dist/indexer/cli.js stats                — show collection stats
  node dist/indexer/cli.js file   <abs> <root>  — index a single file
  node dist/indexer/cli.js migrate-imports <root>   — fix imports paths in existing index

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

if (cmd === "index") {
  const root = resolve(arg2 ?? ".");
  await indexer.indexAll(root);
  process.exit(0);

} else if (cmd === "watch") {
  const root = resolve(arg2 ?? ".");
  await indexer.indexAll(root);
  startWatcher(root, indexer);
  // keep process alive; Ctrl-C to stop
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

} else {
  process.stderr.write(`Unknown command: ${cmd}\n\n${USAGE}\n`);
  process.exit(1);
}
