/**
 * Git utility module — reads git metadata directly from .git/ files.
 * No git binary dependency.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { qd, colName } from "../qdrant.js";
import { cfg } from "../config.js";

const COLLECTION = colName("code_chunks");

// ── Git metadata (file-based, no git binary) ────────────────────────────────

/** Locate the .git directory, handling worktrees (where .git is a file pointing elsewhere). */
function findGitDir(root: string): string | null {
  const dotGit = join(root, ".git");
  if (!existsSync(dotGit)) return null;
  const st = statSync(dotGit, { throwIfNoEntry: false });
  if (!st) return null;
  if (st.isDirectory()) return dotGit;
  // Worktree: .git is a file with "gitdir: <path>"
  const content = readFileSync(dotGit, "utf8").trim();
  const m = content.match(/^gitdir:\s*(.+)$/);
  if (m) {
    const target = resolve(root, m[1]!);
    return existsSync(target) ? target : null;
  }
  return null;
}

/**
 * Read `.git/HEAD` → parse `ref: refs/heads/<branch>` → return branch name.
 * If detached HEAD, return the commit SHA (first 12 chars).
 * Returns "default" if not a git repo.
 */
export function getCurrentBranch(root: string): string {
  const gitDir = findGitDir(root);
  if (!gitDir) return "default";
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const refMatch = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (refMatch) return refMatch[1]!;
    // Detached HEAD — return short SHA
    return head.slice(0, 12);
  } catch {
    return "default";
  }
}

/**
 * Read current commit SHA from .git/refs or packed-refs.
 * Returns null if not a git repo or unresolvable.
 */
export function getCurrentCommit(root: string): string | null {
  const gitDir = findGitDir(root);
  if (!gitDir) return null;
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const refMatch = head.match(/^ref:\s*(.+)$/);
    if (!refMatch) {
      // Detached HEAD — HEAD is the commit SHA itself
      return /^[0-9a-f]{40}$/.test(head) ? head : null;
    }
    const refPath = refMatch[1]!;
    // Try loose ref first
    const looseRef = join(gitDir, refPath);
    if (existsSync(looseRef)) {
      return readFileSync(looseRef, "utf8").trim();
    }
    // Fallback to packed-refs
    return readPackedRef(gitDir, refPath);
  } catch {
    return null;
  }
}

/** Parse `.git/packed-refs` for a given ref path. */
function readPackedRef(gitDir: string, refPath: string): string | null {
  const packedRefsPath = join(gitDir, "packed-refs");
  if (!existsSync(packedRefsPath)) return null;
  try {
    const content = readFileSync(packedRefsPath, "utf8");
    for (const line of content.split("\n")) {
      if (line.startsWith("#") || line.startsWith("^")) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1] === refPath) {
        return parts[0]!;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * List all local branch names by reading `.git/refs/heads/` + packed-refs.
 */
export function getLocalBranches(root: string): string[] {
  const gitDir = findGitDir(root);
  if (!gitDir) return [];
  const branches = new Set<string>();

  // Loose refs
  const headsDir = join(gitDir, "refs", "heads");
  if (existsSync(headsDir)) {
    readBranchesRecursive(headsDir, "", branches);
  }

  // Packed refs
  const packedRefsPath = join(gitDir, "packed-refs");
  if (existsSync(packedRefsPath)) {
    try {
      const content = readFileSync(packedRefsPath, "utf8");
      const prefix = "refs/heads/";
      for (const line of content.split("\n")) {
        if (line.startsWith("#") || line.startsWith("^")) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[1]!.startsWith(prefix)) {
          branches.add(parts[1]!.slice(prefix.length));
        }
      }
    } catch { /* ignore */ }
  }

  return [...branches];
}

function readBranchesRecursive(dir: string, prefix: string, out: Set<string>): void {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        readBranchesRecursive(join(dir, entry.name), name, out);
      } else {
        out.add(name);
      }
    }
  } catch { /* ignore */ }
}

/**
 * Check whether the root appears to be inside a git repository.
 */
export function isGitRepo(root: string): boolean {
  return findGitDir(root) !== null;
}

/** Path to .git/HEAD file (for watcher). Returns null if not a git repo. */
export function getGitHeadPath(root: string): string | null {
  const gitDir = findGitDir(root);
  return gitDir ? join(gitDir, "HEAD") : null;
}

// ── GitState persistence (Qdrant point with chunk_type: "git_state") ─────────

/** Deterministic UUID for the git_state point, derived from projectId. */
function gitStateId(): string {
  const hash = createHash("sha256").update(`git_state:${cfg.projectId}`).digest("hex");
  // Format as UUID v4-like
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

export interface GitState {
  lastBranch: string;
  lastIndexTimestamp: number;
  lastGcTimestamp?: number;
}

export async function loadGitState(): Promise<GitState | null> {
  try {
    const points = await qd.retrieve(COLLECTION, {
      ids: [gitStateId()],
      with_payload: true,
      with_vector: false,
    });
    const point = points[0];
    if (!point?.payload) return null;
    const p = point.payload as Record<string, unknown>;
    if (p["chunk_type"] !== "git_state") return null;
    return {
      lastBranch: String(p["last_branch"] ?? ""),
      lastIndexTimestamp: Number(p["last_index_timestamp"] ?? 0),
      lastGcTimestamp: p["last_gc_timestamp"] ? Number(p["last_gc_timestamp"]) : undefined,
    };
  } catch {
    return null;
  }
}

export async function saveGitState(state: GitState): Promise<void> {
  const id = gitStateId();
  await qd.upsert(COLLECTION, {
    points: [{
      id,
      vector: {},
      payload: {
        chunk_type: "git_state",
        project_id: cfg.projectId,
        last_branch: state.lastBranch,
        last_index_timestamp: state.lastIndexTimestamp,
        ...(state.lastGcTimestamp !== undefined && { last_gc_timestamp: state.lastGcTimestamp }),
      },
    }],
  });
}

// ── Branch manifest persistence ──────────────────────────────────────────────

/** Deterministic UUID for a branch manifest point. */
function manifestId(branch: string): string {
  const hash = createHash("sha256").update(`manifest:${cfg.projectId}:${branch}`).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

export type FileManifest = Record<string, string>; // { file_path: file_hash }

export async function loadManifest(branch: string): Promise<FileManifest | null> {
  try {
    const points = await qd.retrieve(COLLECTION, {
      ids: [manifestId(branch)],
      with_payload: true,
      with_vector: false,
    });
    const point = points[0];
    if (!point?.payload) return null;
    const p = point.payload as Record<string, unknown>;
    if (p["chunk_type"] !== "branch_manifest") return null;
    return JSON.parse(String(p["manifest"] ?? "{}")) as FileManifest;
  } catch {
    return null;
  }
}

export async function saveManifest(branch: string, manifest: FileManifest): Promise<void> {
  await qd.upsert(COLLECTION, {
    points: [{
      id: manifestId(branch),
      vector: {},
      payload: {
        chunk_type: "branch_manifest",
        project_id: cfg.projectId,
        branch,
        manifest: JSON.stringify(manifest),
      },
    }],
  });
}

export async function deleteManifest(branch: string): Promise<void> {
  try {
    await qd.delete(COLLECTION, { points: [manifestId(branch)] });
  } catch { /* ignore */ }
}
