/**
 * gitignore / .ignore filter.
 *
 * Uses the `ignore` package for full gitignore-spec pattern matching.
 * Supports stacked contexts: each directory can contribute its own .gitignore
 * (and/or .ignore) file; patterns from each file only apply to paths that live
 * under the directory that contains that file.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import ignore, { type Ignore } from "ignore";

interface IgnoreCtx {
  /** Absolute path of the directory that owns this .gitignore/.ignore. */
  base: string;
  ig:   Ignore;
}

/** Read .gitignore and .ignore from `dir`. Returns null if neither exists. */
function loadCtx(dir: string): IgnoreCtx | null {
  const ig = ignore();
  let hasRules = false;
  for (const name of [".gitignore", ".ignore"]) {
    const p = join(dir, name);
    if (existsSync(p)) {
      ig.add(readFileSync(p, "utf8"));
      hasRules = true;
    }
  }
  return hasRules ? { base: dir, ig } : null;
}

/**
 * Accumulates gitignore rules as the indexer recurses through the file tree.
 *
 * Call `addDir(dir)` whenever you enter a new directory; any .gitignore/.ignore
 * found there will be recorded.  Then call `isIgnored(absPath)` to test a path.
 *
 * Because `relative(ctx.base, absPath)` is used for matching, rules from a
 * sub-directory's .gitignore never affect files outside that sub-directory.
 */
export class GitignoreFilter {
  private readonly ctxs: IgnoreCtx[] = [];

  /** Load ignore rules from `dir` (if .gitignore/.ignore is present). */
  addDir(dir: string): void {
    const ctx = loadCtx(dir);
    if (ctx) this.ctxs.push(ctx);
  }

  /**
   * Returns true if `absPath` is matched by any applicable ignore rule.
   * Works for both files and directories.
   */
  isIgnored(absPath: string): boolean {
    for (const ctx of this.ctxs) {
      const rel = relative(ctx.base, absPath).replace(/\\/g, "/");
      // Only check paths actually under this context's base directory.
      if (!rel || rel.startsWith("..")) continue;
      if (ctx.ig.ignores(rel)) return true;
    }
    return false;
  }
}
