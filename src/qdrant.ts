import { QdrantClient } from "@qdrant/js-client-rest";
import { cfg } from "./config.js";

export const qd = new QdrantClient({ url: cfg.qdrantUrl });

export const COLLECTIONS = [
  "memory_episodic",
  "memory_semantic",
  "memory_procedural",
  "code_chunks",
] as const;

const MEMORY_COLLECTIONS = ["memory_episodic", "memory_semantic", "memory_procedural"] as const;

/** Named vectors used by the code_chunks collection. */
export const CODE_VECTORS = {
  code:        "code_vector",
  description: "description_vector",
} as const;

async function ensureCodeChunks(): Promise<void> {
  // Check if collection exists with the correct named-vector schema.
  // If it exists with the old single-vector schema, delete and recreate.
  const { collections } = await qd.getCollections();
  const existing = collections.find((c) => c.name === "code_chunks");

  if (existing) {
    const info = await qd.getCollection("code_chunks");
    const vectors = info.config?.params?.vectors as Record<string, unknown> | undefined;
    // Named vectors: the object will have "code_vector" key.
    // Old single vector: it has a "size" key directly.
    const hasNamedVectors = vectors !== undefined && CODE_VECTORS.code in vectors;
    if (hasNamedVectors) {
      // Ensure the imports keyword index exists on the existing collection (idempotent).
      await qd.createPayloadIndex("code_chunks", {
        field_name:   "imports",
        field_schema: "keyword",
        wait:         true,
      }).catch(() => undefined);
      return;
    }

    // Delete old collection and re-create below.
    process.stderr.write(
      "[qdrant] Migrating code_chunks to named vectors (existing index will be cleared)\n"
    );
    await qd.deleteCollection("code_chunks");
  }

  await qd.createCollection("code_chunks", {
    vectors: {
      [CODE_VECTORS.code]:        { size: cfg.embedDim, distance: "Cosine" },
      [CODE_VECTORS.description]: { size: cfg.embedDim, distance: "Cosine" },
    },
  });

  for (const field of ["file_path", "chunk_type", "language", "project_id", "parent_id", "imports"]) {
    await qd.createPayloadIndex("code_chunks", {
      field_name:   field,
      field_schema: "keyword",
      wait:         true,
    });
  }

  process.stderr.write("[qdrant] Created collection: code_chunks (named vectors)\n");
}

export async function ensureCollections(): Promise<void> {
  const { collections } = await qd.getCollections();
  const existing = new Set(collections.map((c) => c.name));

  for (const name of MEMORY_COLLECTIONS) {
    if (existing.has(name)) continue;

    await qd.createCollection(name, {
      vectors: { size: cfg.embedDim, distance: "Cosine" },
    });

    for (const field of ["project_id", "agent_id", "scope", "content_hash"]) {
      await qd.createPayloadIndex(name, {
        field_name: field,
        field_schema: "keyword",
        wait: true,
      });
    }

    process.stderr.write(`[qdrant] Created collection: ${name}\n`);
  }

  await ensureCodeChunks();
}
