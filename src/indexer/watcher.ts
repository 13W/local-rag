import chokidar from "chokidar";
import { existsSync, readdirSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import type { CodeIndexer } from "./indexer.js";
import { GitignoreFilter } from "./gitignore.js";
import { cfg } from "../config.js";
import { recordIndex, broadcastBranchSwitch } from "../plugins/dashboard.js";
import {
  getCurrentBranch,
  getGitHeadPath,
  getGitWorktreesDir,
  isNamedBranch,
  listWorktreePaths,
  saveGitState,
} from "./git.js";
import { setCurrentBranch } from "../config.js";

// Directories that must never receive inotify watches (mirrors IGNORE_DIRS in indexer.ts)
const WATCH_IGNORED = [
  /[/\\]\.(git|svn|hg)([/\\]|$)/,
  /[/\\]node_modules([/\\]|$)/,
  /[/\\](dist|build|\.next|coverage|vendor|charts|testdata)([/\\]|$)/,
];

function buildGitignoreFilter(root: string, worktreeRoots: readonly string[]): GitignoreFilter {
  const filter = new GitignoreFilter();
  const isWorktree = (abs: string) =>
    worktreeRoots.some((wt) => abs === wt || abs.startsWith(wt + "/"));
  const walk = (dir: string) => {
    filter.addDir(dir);
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const abs = join(dir, entry.name);
        if (entry.name.startsWith(".")) continue;
        if (WATCH_IGNORED.some((r) => r.test(abs))) continue;
        if (isWorktree(abs)) continue;
        if (filter.isIgnored(abs)) continue;
        walk(abs);
      }
    } catch { /* skip unreadable dirs */ }
  };
  walk(root);
  return filter;
}

export interface WatcherOptions {
  ignoreInitial?: boolean;
  onReindex?: (relPath: string, chunks: number) => void;
  onRecordIndex?: (relPath: string, chunks: number, ms: number, ok: boolean, error?: string) => void;
  onReady?: () => void;
  getState?: () => "running" | "paused" | "stopped";
  enqueueEvent?: (absPath: string) => void;
}

export function startWatcher(
  root: string,
  indexer: CodeIndexer,
  options?: WatcherOptions
): void {
  const absRoot = resolve(root);

  let worktreePaths: string[] = listWorktreePaths(absRoot).map((p) => resolve(p));
  const isInWorktree = (absPath: string): boolean => {
    for (const wt of worktreePaths) {
      if (absPath === wt || absPath.startsWith(wt + "/")) return true;
    }
    return false;
  };
  if (worktreePaths.length > 0) {
    process.stderr.write(
      `[watcher] Ignoring ${worktreePaths.length} git worktree(s): ${worktreePaths.join(", ")}\n`,
    );
  }

  const gitFilter = buildGitignoreFilter(absRoot, worktreePaths);

  const watchPaths = [absRoot];
  if (indexer.includePaths.length > 0) {
    for (const p of indexer.includePaths) {
      const abs = resolve(absRoot, p);
      if (existsSync(abs)) watchPaths.push(abs);
    }
  }

  const watcher = chokidar.watch(Array.from(new Set(watchPaths)), {
    ignored: (absPath: string) =>
      WATCH_IGNORED.some((r) => r.test(absPath))
      || isInWorktree(absPath)
      || gitFilter.isIgnored(absPath),
    ignoreInitial: options?.ignoreInitial ?? false,
    persistent: false,
    usePolling: false,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  const doRecord = (relPath: string, chunks: number, ms: number, ok: boolean, error?: string) => {
    if (options?.onRecordIndex) options.onRecordIndex(relPath, chunks, ms, ok, error);
    else recordIndex(indexer.projectId, relPath, chunks, ms, ok, error);
  };

  const pendingEvents = new Map<string, ReturnType<typeof setTimeout>>();

  const handle = (absPath: string) => {
    if (indexer.shouldSkip(absPath)) return;
    
    // Deduplicate/debounce events for the same file
    if (pendingEvents.has(absPath)) {
      clearTimeout(pendingEvents.get(absPath));
    }

    const timer = setTimeout(() => {
      pendingEvents.delete(absPath);
      
      if (options?.getState && options.getState() === "paused") {
        if (options.enqueueEvent) options.enqueueEvent(absPath);
        return;
      }

      const pathBase = indexer.projectRoot ? resolve(indexer.projectRoot) : absRoot;
      const relPath  = relative(pathBase, absPath).replace(/\\/g, "/");

      if (existsSync(absPath)) {
        const t0 = Date.now();
        indexer
          .indexFileIncremental(absPath, absRoot)
          .then(([n, ms]) => {
            if (n === 0) return;
            process.stderr.write(`[watcher] re-indexed ${relPath}: ${n} chunks\n`);
            doRecord(relPath, n, ms, true);
            options?.onReindex?.(relPath, n);
          })
          .catch((err: unknown) => {
            process.stderr.write(`[watcher] error ${relPath}: ${String(err)}\n`);
            doRecord(relPath, 0, Date.now() - t0, false, String(err));
          });
      } else {
        const t1 = Date.now();
        indexer
          .untagFile(relPath, indexer.branch)
          .then(() => {
            process.stderr.write(`[watcher] untagged ${relPath}\n`);
            doRecord(relPath, 0, Date.now() - t1, true);
          })
          .catch((err: unknown) => {
            process.stderr.write(`[watcher] delete error ${relPath}: ${String(err)}\n`);
            doRecord(relPath, 0, Date.now() - t1, false, String(err));
          });
      }
    }, 100);

    pendingEvents.set(absPath, timer);
  };

  watcher.on("add", handle).on("change", handle).on("unlink", handle);
  watcher.once("ready", () => options?.onReady?.());

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

          // Skip indexing during detached HEAD (rebase, bisect, bare SHA checkout).
          // When rebase completes and HEAD returns to a named branch, this fires again.
          if (!isNamedBranch(root)) {
            process.stderr.write(
              `[watcher] Detached HEAD (${newBranch}) — skipping indexing\n`,
            );
            return;
          }

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

  // ── Worktree registration tracking via .git/worktrees/ ─────────────────────
  // `git worktree add` creates a directory under .git/worktrees/ (with a
  // `gitdir` file inside). Reload the ignore list so freshly-added worktrees
  // stop receiving index events without requiring a watcher restart.
  const worktreesDir = getGitWorktreesDir(root);
  if (worktreesDir) {
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        worktreePaths = listWorktreePaths(absRoot).map((p) => resolve(p));
        process.stderr.write(
          `[watcher] Worktree list refreshed: ${worktreePaths.length} worktree(s)\n`,
        );
      }, 200);
    };
    chokidar
      .watch(worktreesDir, {
        persistent: false,
        usePolling: false,
        depth: 2,
        ignoreInitial: true,
      })
      .on("addDir", refresh)
      .on("unlinkDir", refresh)
      .on("add", (p) => { if (p.endsWith("/gitdir")) refresh(); })
      .on("unlink", (p) => { if (p.endsWith("/gitdir")) refresh(); });

    process.stderr.write(`[watcher] Watching ${worktreesDir} for worktree changes\n`);
  }
}
