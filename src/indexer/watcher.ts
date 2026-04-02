import chokidar from "chokidar";
import { existsSync, readdirSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import type { CodeIndexer } from "./indexer.js";
import { GitignoreFilter } from "./gitignore.js";
import { cfg } from "../config.js";
import { recordIndex, broadcastBranchSwitch } from "../dashboard.js";
import { getCurrentBranch, getGitHeadPath, saveGitState } from "./git.js";
import { setCurrentBranch } from "../config.js";

// Directories that must never receive inotify watches (mirrors IGNORE_DIRS in indexer.ts)
const WATCH_IGNORED = [
  /[/\\]\.(git|svn|hg)([/\\]|$)/,
  /[/\\]node_modules([/\\]|$)/,
  /[/\\](dist|build|\.next|coverage|vendor|charts|testdata)([/\\]|$)/,
];

function buildGitignoreFilter(root: string): GitignoreFilter {
  const filter = new GitignoreFilter();
  const walk = (dir: string) => {
    filter.addDir(dir);
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const abs = join(dir, entry.name);
        if (entry.name.startsWith(".")) continue;
        if (WATCH_IGNORED.some((r) => r.test(abs))) continue;
        if (filter.isIgnored(abs)) continue;
        walk(abs);
      }
    } catch { /* skip unreadable dirs */ }
  };
  walk(root);
  return filter;
}

export function startWatcher(
  root: string,
  indexer: CodeIndexer,
  onReindex?: (relPath: string, chunks: number) => void,
  onReady?: () => void,
  ignoreInitial = false,
): void {
  const absRoot = resolve(root);
  const gitFilter = buildGitignoreFilter(absRoot);

  const watcher = chokidar.watch(absRoot, {
    ignored: (absPath: string) =>
      WATCH_IGNORED.some((r) => r.test(absPath)) || gitFilter.isIgnored(absPath),
    ignoreInitial,
    persistent: false,
    usePolling: false,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  const handle = (absPath: string) => {
    if (indexer.shouldSkip(absPath)) return;
    const pathBase = cfg.projectRoot ? resolve(cfg.projectRoot) : absRoot;
    const relPath  = relative(pathBase, absPath).replace(/\\/g, "/");

    if (existsSync(absPath)) {
      const t0 = Date.now();
      indexer
        .indexFileIncremental(absPath, absRoot)
        .then(([n, ms]) => {
          if (n === 0) return;
          process.stderr.write(`[watcher] re-indexed ${relPath}: ${n} chunks\n`);
          recordIndex(relPath, n, ms, true);
          onReindex?.(relPath, n);
        })
        .catch((err: unknown) => {
          process.stderr.write(`[watcher] error ${relPath}: ${String(err)}\n`);
          recordIndex(relPath, 0, Date.now() - t0, false);
        });
    } else {
      const t1 = Date.now();
      indexer
        .untagFile(relPath, indexer.branch)
        .then(() => {
          process.stderr.write(`[watcher] untagged ${relPath}\n`);
          recordIndex(relPath, 0, Date.now() - t1, true);
        })
        .catch((err: unknown) => {
          process.stderr.write(`[watcher] delete error ${relPath}: ${String(err)}\n`);
          recordIndex(relPath, 0, Date.now() - t1, false);
        });
    }
  };

  watcher.on("add", handle).on("change", handle).on("unlink", handle);
  watcher.once("ready", () => onReady?.());

  process.stderr.write(`[watcher] Watching ${absRoot}\n`);

  // ── Branch switch detection via .git/HEAD ──────────────────────────────────
  const gitHeadPath = getGitHeadPath(root);
  if (gitHeadPath) {
    let switchInProgress = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    chokidar
      .watch(gitHeadPath, {
        persistent: false,
        usePolling: false,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      })
      .on("change", () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          if (switchInProgress) return;
          const newBranch = getCurrentBranch(root);
          if (newBranch === indexer.branch) return;

          switchInProgress = true;
          const oldBranch = indexer.branch;
          process.stderr.write(`[watcher] Branch switch detected: ${oldBranch} → ${newBranch}\n`);

          try {
            await indexer.switchBranch(root, oldBranch, newBranch);
            setCurrentBranch(newBranch);
            broadcastBranchSwitch(newBranch);
            await saveGitState({
              lastBranch: newBranch,
              lastIndexTimestamp: Date.now(),
            }).catch(() => undefined);
          } catch (err: unknown) {
            process.stderr.write(`[watcher] Branch switch error: ${String(err)}\n`);
          } finally {
            switchInProgress = false;
          }
        }, 500);
      });

    process.stderr.write(`[watcher] Watching .git/HEAD for branch switches\n`);
  }
}
