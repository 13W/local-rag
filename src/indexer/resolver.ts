/**
 * Import path resolver.
 *
 * Converts raw import strings (relative paths, tsconfig aliases, package names)
 * into normalised project-relative file paths (without extension normalisation —
 * just path resolution).
 *
 * Only relative paths and known aliases are resolved; node_modules stay as-is.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join, dirname, relative } from "node:path";

interface TsConfig {
  compilerOptions?: {
    paths?:   Record<string, string[]>;
    baseUrl?: string;
  };
}

interface ResolverOptions {
  /** Absolute path to the project root. */
  root:       string;
  /** Absolute path to tsconfig.json (optional). */
  tsconfigPath?: string;
}

export class ImportResolver {
  private readonly root:    string;
  private readonly aliases: Array<{ prefix: string; targets: string[] }>;
  private readonly baseUrl: string;

  constructor(opts: ResolverOptions) {
    this.root    = opts.root;
    this.aliases = [];
    this.baseUrl = opts.root;

    const tsPath = opts.tsconfigPath ?? join(opts.root, "tsconfig.json");
    if (existsSync(tsPath)) {
      const raw = readFileSync(tsPath, "utf8")
        .replace(/\/\/[^\n]*/g, "")           // strip // comments
        .replace(/\/\*[\s\S]*?\*\//g, "")     // strip /* */ comments
        .replace(/,(\s*[}\]])/g, "$1");        // strip trailing commas (JSONC)
      const tsconfig = JSON.parse(raw) as TsConfig;
      const opts2    = tsconfig.compilerOptions ?? {};
      if (opts2.baseUrl) {
        this.baseUrl = resolve(dirname(tsPath), opts2.baseUrl);
      }
      for (const [alias, targets] of Object.entries(opts2.paths ?? {})) {
        // Strip trailing /* from alias and targets
        const prefix = alias.replace(/\/\*$/, "");
        const resolvedTargets = targets.map((t) =>
          resolve(this.baseUrl, t.replace(/\/\*$/, ""))
        );
        this.aliases.push({ prefix, targets: resolvedTargets });
      }
    }
  }

  /**
   * Resolve a raw import string to a project-relative path.
   * Returns the raw string unchanged if it's a node_module (no leading dot or alias).
   */
  resolve(importPath: string, fromFile: string): string {
    if (!importPath) return importPath;

    // Relative import
    if (importPath.startsWith(".")) {
      const absFrom = resolve(this.root, dirname(fromFile));
      const absTarget = resolve(absFrom, importPath);
      return relative(this.root, absTarget).replace(/\\/g, "/");
    }

    // Alias import (e.g. @/foo, ~/foo, or tsconfig paths)
    for (const { prefix, targets } of this.aliases) {
      if (importPath === prefix || importPath.startsWith(prefix + "/")) {
        const rest        = importPath.slice(prefix.length);
        const firstTarget = targets[0];
        if (firstTarget !== undefined) {
          const absTarget = firstTarget + rest;
          return relative(this.root, absTarget).replace(/\\/g, "/");
        }
      }
    }

    // Common conventions for monorepos
    if (importPath.startsWith("@/") || importPath.startsWith("~/")) {
      const rest = importPath.slice(2);
      const absTarget = join(this.root, "src", rest);
      return relative(this.root, absTarget).replace(/\\/g, "/");
    }

    // node_modules — keep as-is
    return importPath;
  }

  /**
   * Resolve an array of raw import strings, returning only project-relative ones
   * (i.e. those that don't look like package names).
   */
  resolveAll(imports: string[], fromFile: string): string[] {
    return imports
      .map((imp) => this.resolve(imp, fromFile))
      .filter((p) => !p.startsWith("node_modules") && p.includes("/") && !p.startsWith("@"))
      .map((p) => p.startsWith("../") || p.startsWith("./") ? p : p);
  }
}
