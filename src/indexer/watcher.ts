import { watch, existsSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import type { CodeIndexer } from "./indexer.js";
import { cfg } from "../config.js";
import { recordIndex } from "../dashboard.js";

export function startWatcher(root: string, indexer: CodeIndexer): void {
  const absRoot = resolve(root);

  const watcher = watch(absRoot, { recursive: true }, (event, filename) => {
    if (!filename) return;
    const absPath  = resolve(join(absRoot, filename));
    if (indexer.shouldSkip(absPath)) return;

    const pathBase = cfg.projectRoot ? resolve(cfg.projectRoot) : absRoot;
    const relPath  = relative(pathBase, absPath).replace(/\\/g, "/");

    if (existsSync(absPath)) {
      const t0 = Date.now();
      indexer
        .indexFile(absPath, absRoot)
        .then((n) => {
          process.stderr.write(`[watcher] re-indexed ${relPath}: ${n} chunks\n`);
          recordIndex(relPath, n, Date.now() - t0, true);
        })
        .catch((err: unknown) => {
          process.stderr.write(`[watcher] error ${relPath}: ${String(err)}\n`);
          recordIndex(relPath, 0, Date.now() - t0, false);
        });
    } else {
      const t1 = Date.now();
      indexer
        .deleteFile(relPath)
        .then(() => {
          process.stderr.write(`[watcher] deleted ${relPath}\n`);
          recordIndex(relPath, 0, Date.now() - t1, true);
        })
        .catch((err: unknown) => {
          process.stderr.write(`[watcher] delete error ${relPath}: ${String(err)}\n`);
          recordIndex(relPath, 0, Date.now() - t1, false);
        });
    }
  });

  // Allow the process to exit naturally when the MCP transport closes.
  // Without unref(), fs.watch keeps the event loop alive indefinitely.
  watcher.unref();

  process.stderr.write(`[watcher] Watching ${absRoot}\n`);
}
