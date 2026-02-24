import { watch, existsSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import type { CodeIndexer } from "./indexer.js";
import { cfg } from "../config.js";

export function startWatcher(root: string, indexer: CodeIndexer): void {
  const absRoot = resolve(root);

  watch(absRoot, { recursive: true }, (event, filename) => {
    if (!filename) return;
    const absPath  = resolve(join(absRoot, filename));
    if (indexer.shouldSkip(absPath)) return;

    const pathBase = cfg.projectRoot ? resolve(cfg.projectRoot) : absRoot;
    const relPath  = relative(pathBase, absPath).replace(/\\/g, "/");

    if (existsSync(absPath)) {
      indexer
        .indexFile(absPath, absRoot)
        .then((n) => process.stderr.write(`[watcher] re-indexed ${relPath}: ${n} chunks\n`))
        .catch((err: unknown) =>
          process.stderr.write(`[watcher] error ${relPath}: ${String(err)}\n`)
        );
    } else {
      indexer
        .deleteFile(relPath)
        .then(() => process.stderr.write(`[watcher] deleted ${relPath}\n`))
        .catch((err: unknown) =>
          process.stderr.write(`[watcher] delete error ${relPath}: ${String(err)}\n`)
        );
    }
  });

  process.stderr.write(`[watcher] Watching ${absRoot}\n`);
}
