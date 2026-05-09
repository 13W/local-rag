/**
 * re-embed — Re-generate vectors for all existing Qdrant records.
 *
 * Use when switching embedding models of the same dimension.
 * Does NOT delete or re-parse source files — only updates vectors in-place.
 *
 * Collections handled:
 *   • memory_*, memory, feedback  — single flat vector from `content`
 *   • code_chunks  — named vectors: code_vector from `content`,
 *                                   description_vector from `description`
 *
 * Skipped (dummy/config collections):
 *   • server_config, projects, request_logs
 */

import { bootstrap }                            from "./bootstrap.js";
import { qd }                                   from "./qdrant.js";
import { loadServerConfig, ensureConfigCollections } from "./server-config.js";
import { applyServerConfig }                    from "./config.js";
import { embedBatch, applyEmbedRateLimit }       from "./embedder.js";
import { CODE_VECTORS }                         from "./qdrant.js";

// Collections that use dummy vectors and must be skipped.
const SKIP_COLLECTIONS = new Set(["server_config", "projects", "request_logs"]);

// Collections that use named vectors (code_vector + description_vector).
const NAMED_VECTOR_COLLECTIONS = new Set(["code_chunks"]);

const SCROLL_LIMIT  = 100;   // points per scroll page
const EMBED_BATCH   = 32;    // texts per embedBatch() call
const UPDATE_BATCH  = 32;    // points per updateVectors() call

// ── helpers ────────────────────────────────────────────────────────────────────

function logProgress(col: string, done: number, total: number | null): void {
  const tot = total !== null ? `/${total}` : "";
  process.stderr.write(`\r[re-embed] ${col}: ${done}${tot} points  `);
}

/** Split array into chunks of at most `size`. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── flat-vector collection ─────────────────────────────────────────────────────

async function reEmbedFlat(col: string): Promise<void> {
  process.stderr.write(`\n[re-embed] ${col} (flat vector)\n`);

  let offset: string | number | undefined;
  let done = 0;

  for (;;) {
    const page = await qd.scroll(col, {
      limit:        SCROLL_LIMIT,
      with_payload: ["content"],
      with_vector:  false,
      ...(offset !== undefined && { offset }),
    });

    const pts = page.points.filter(
      (p) => typeof (p.payload as Record<string, unknown> | null | undefined)?.["content"] === "string"
    );

    if (pts.length > 0) {
      // Embed in batches of EMBED_BATCH, then update in batches of UPDATE_BATCH.
      const texts = pts.map((p) => (p.payload as Record<string, string>)["content"]!);
      const allVecs: number[][] = [];

      for (const batch of chunk(texts, EMBED_BATCH)) {
        const vecs = await embedBatch(batch);
        allVecs.push(...vecs);
      }

      for (let b = 0; b < pts.length; b += UPDATE_BATCH) {
        const batchPts = pts.slice(b, b + UPDATE_BATCH);
        await qd.updateVectors(col, {
          points: batchPts.map((p, i) => ({ id: p.id, vector: allVecs[b + i]! })),
          wait:   true,
        } as never);
      }
    }

    done += page.points.length;
    logProgress(col, done, null);

    const next = (page as { next_page_offset?: string | number | null }).next_page_offset;
    if (!next) break;
    offset = next;
  }

  process.stderr.write(`\n[re-embed] ${col}: done (${done} points)\n`);
}

// ── named-vector collection (code_chunks) ─────────────────────────────────────

async function reEmbedNamed(col: string): Promise<void> {
  process.stderr.write(`\n[re-embed] ${col} (named vectors)\n`);

  let offset: string | number | undefined;
  let done = 0;

  for (;;) {
    const page = await qd.scroll(col, {
      limit:        SCROLL_LIMIT,
      with_payload: ["content", "description", "is_parent"],
      with_vector:  false,
      ...(offset !== undefined && { offset }),
    });

    if (page.points.length > 0) {
      // Build two embedding jobs separately:
      // • code_vector  — all non-parent chunks that have `content`
      // • desc_vector  — all non-child chunks that have `description`

      type Job = { id: string | number; text: string; role: "code" | "desc" };
      const jobs: Job[] = [];

      for (const p of page.points) {
        const pl       = (p.payload ?? {}) as Record<string, unknown>;
        const isParent = pl["is_parent"] === true;
        const content  = typeof pl["content"]     === "string" ? pl["content"]     : null;
        const desc     = typeof pl["description"] === "string" ? pl["description"] : null;

        if (!isParent && content) jobs.push({ id: p.id, text: content, role: "code" });
        if (desc)                 jobs.push({ id: p.id, text: desc,    role: "desc" });
      }

      // Embed all texts in one pass (batched).
      const texts   = jobs.map((j) => j.text);
      const allVecs: number[][] = [];
      for (const batch of chunk(texts, EMBED_BATCH)) {
        allVecs.push(...await embedBatch(batch));
      }

      // Group vectors back by point id.
      const byId = new Map<string | number, { code?: number[]; desc?: number[] }>();
      for (let i = 0; i < jobs.length; i++) {
        const j   = jobs[i]!;
        const rec = byId.get(j.id) ?? {};
        if (j.role === "code") rec.code = allVecs[i];
        else                   rec.desc = allVecs[i];
        byId.set(j.id, rec);
      }

      // Write updates.
      const updates = [...byId.entries()]
        .map(([id, v]) => {
          const vector: Record<string, number[]> = {};
          if (v.code) vector[CODE_VECTORS.code]        = v.code;
          if (v.desc) vector[CODE_VECTORS.description] = v.desc;
          return { id, vector };
        })
        .filter((u) => Object.keys(u.vector).length > 0);

      for (const batch of chunk(updates, UPDATE_BATCH)) {
        process.stderr.write(
          `[re-embed] updateVectors ${col}: ${batch.length} points, ` +
          `first id=${String(batch[0]?.id)}, ` +
          `vector keys=${Object.keys(batch[0]?.vector ?? {}).join(",")}, ` +
          `dim=${batch[0]?.vector[CODE_VECTORS.code]?.length ?? batch[0]?.vector[CODE_VECTORS.description]?.length}\n`
        );
        await qd.updateVectors(col, { points: batch, wait: true } as never);
      }
    }

    done += page.points.length;
    logProgress(col, done, null);

    const next = (page as { next_page_offset?: string | number | null }).next_page_offset;
    if (!next) break;
    offset = next;
  }

  process.stderr.write(`\n[re-embed] ${col}: done (${done} points)\n`);
}

// ── entry point ───────────────────────────────────────────────────────────────

export async function runReEmbed(): Promise<void> {
  // 1. Connect to Qdrant.
  await bootstrap();

  // 2. Load embed config so embedBatch() uses the right model.
  await ensureConfigCollections(qd);
  const serverCfg = await loadServerConfig(qd);
  applyServerConfig(serverCfg);

  // Apply embed-specific rate limit for Gemini (90 RPM by default).
  // Check if a custom limit is configured under the embed model name.
  const embedRl = serverCfg.rate_limits?.[serverCfg.embed.model];
  if (embedRl) {
    applyEmbedRateLimit(embedRl.size, embedRl.window);
  }

  process.stderr.write(
    `[re-embed] provider=${serverCfg.embed.provider} model=${serverCfg.embed.model} dim=${serverCfg.embed.dim}\n`
  );

  // 3. Get all collections.
  const { collections } = await qd.getCollections();

  for (const { name } of collections) {
    // Strip collection prefix to get base name for matching.
    const baseName = name.replace(/^[^_]+_/, "");   // e.g. "myprefix_code_chunks" → "code_chunks"
    const isSkip   = SKIP_COLLECTIONS.has(name) || SKIP_COLLECTIONS.has(baseName);
    if (isSkip) {
      process.stderr.write(`[re-embed] skipping ${name}\n`);
      continue;
    }

    const isNamed = NAMED_VECTOR_COLLECTIONS.has(name) || NAMED_VECTOR_COLLECTIONS.has(baseName);

    try {
      if (isNamed) {
        await reEmbedNamed(name);
      } else {
        await reEmbedFlat(name);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\n[re-embed] ERROR in ${name}: ${msg}\n`);
    }
  }

  process.stderr.write("[re-embed] All collections re-embedded.\n");
}
