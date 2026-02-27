import { QdrantClient } from "@qdrant/js-client-rest";
import { cfg } from "./config.js";

export const qd = new QdrantClient({ url: cfg.qdrantUrl });

export const COLLECTIONS = [
  "memory_episodic",
  "memory_semantic",
  "memory_procedural",
  "code_chunks",
] as const;

/** Prepend the configured collection prefix (if any) to a base collection name. */
export function colName(base: string): string {
  return cfg.collectionPrefix ? `${cfg.collectionPrefix}_${base}` : base;
}

const MEMORY_COLLECTIONS = ["memory_episodic", "memory_semantic", "memory_procedural"] as const;

/** Named vectors used by the code_chunks collection. */
export const CODE_VECTORS = {
  code:        "code_vector",
  description: "description_vector",
} as const;

async function ensureCodeChunks(): Promise<void> {
  const col = colName("code_chunks");
  // Check if collection exists with the correct named-vector schema.
  // If it exists with the old single-vector schema, delete and recreate.
  const { collections } = await qd.getCollections();
  const existing = collections.find((c) => c.name === col);

  if (existing) {
    const info = await qd.getCollection(col);
    const vectors = info.config?.params?.vectors as Record<string, unknown> | undefined;
    // Named vectors: the object will have "code_vector" key.
    // Old single vector: it has a "size" key directly.
    const hasNamedVectors = vectors !== undefined && CODE_VECTORS.code in vectors;
    if (hasNamedVectors) {
      // Ensure the imports keyword index exists on the existing collection (idempotent).
      await qd.createPayloadIndex(col, {
        field_name:   "imports",
        field_schema: "keyword",
        wait:         true,
      }).catch(() => undefined);
      return;
    }

    // Delete old collection and re-create below.
    process.stderr.write(
      `[qdrant] Migrating ${col} to named vectors (existing index will be cleared)\n`
    );
    await qd.deleteCollection(col);
  }

  await qd.createCollection(col, {
    vectors: {
      [CODE_VECTORS.code]:        { size: cfg.embedDim, distance: "Cosine" },
      [CODE_VECTORS.description]: { size: cfg.embedDim, distance: "Cosine" },
    },
  });

  for (const field of ["file_path", "chunk_type", "language", "project_id", "parent_id", "imports"]) {
    await qd.createPayloadIndex(col, {
      field_name:   field,
      field_schema: "keyword",
      wait:         true,
    });
  }

  process.stderr.write(`[qdrant] Created collection: ${col} (named vectors)\n`);
}

export async function ensureCollections(): Promise<void> {
  const { collections } = await qd.getCollections();
  const existing = new Set(collections.map((c) => c.name));

  for (const name of MEMORY_COLLECTIONS) {
    const col = colName(name);
    if (existing.has(col)) continue;

    await qd.createCollection(col, {
      vectors: { size: cfg.embedDim, distance: "Cosine" },
    });

    for (const field of ["project_id", "agent_id", "scope", "content_hash"]) {
      await qd.createPayloadIndex(col, {
        field_name: field,
        field_schema: "keyword",
        wait: true,
      });
    }

    process.stderr.write(`[qdrant] Created collection: ${col}\n`);
  }

  await ensureCodeChunks();
}
