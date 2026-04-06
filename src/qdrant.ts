import { QdrantClient } from "@qdrant/js-client-rest";

// Initialized lazily via initQdrant() during server bootstrap.
// Do NOT use qd before initQdrant() is called.
export let qd: QdrantClient = null as unknown as QdrantClient;

export function initQdrant(url: string, apiKey?: string): void {
  qd = new QdrantClient({ url, apiKey: apiKey || undefined, timeout: 30_000 });
}

let _collectionPrefix = "";
export function setCollectionPrefix(prefix: string): void { _collectionPrefix = prefix; }

let _embedDim = 384;
export function setEmbedDim(dim: number): void { _embedDim = dim; }

export const COLLECTIONS = [
  "memory_episodic",
  "memory_semantic",
  "memory_procedural",
  "memory",
  "memory_agents",
  "code_chunks",
] as const;

/** Prepend the configured collection prefix (if any) to a base collection name. */
export function colName(base: string): string {
  return _collectionPrefix ? `${_collectionPrefix}_${base}` : base;
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
      // Idempotent: ensure all indexes (keyword + text) exist on existing collection.
      for (const field of ["imports", "branches"]) {
        await qd.createPayloadIndex(col, { field_name: field, field_schema: "keyword", wait: true })
          .catch(() => undefined);
      }
      // Migrate name index from word → prefix tokenizer (needed for name_pattern substring search).
      // Delete first so the schema change takes effect; createPayloadIndex is a no-op if schema matches.
      await qd.deletePayloadIndex(col, "name").catch(() => undefined);
      await qd.createPayloadIndex(col, {
        field_name: "name", field_schema: { type: "text", tokenizer: "prefix", min_token_len: 2, lowercase: true }, wait: true,
      }).catch(() => undefined);
      await qd.createPayloadIndex(col, {
        field_name: "content", field_schema: { type: "text", tokenizer: "word", min_token_len: 2, lowercase: true }, wait: true,
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
      [CODE_VECTORS.code]:        { size: _embedDim, distance: "Cosine" },
      [CODE_VECTORS.description]: { size: _embedDim, distance: "Cosine" },
    },
  });

  for (const field of ["file_path", "chunk_type", "language", "project_id", "parent_id", "imports", "branches"]) {
    await qd.createPayloadIndex(col, {
      field_name:   field,
      field_schema: "keyword",
      wait:         true,
    });
  }

  for (const [field, schema] of [
    ["name",    { type: "text", tokenizer: "prefix", min_token_len: 2, lowercase: true }],
    ["content", { type: "text", tokenizer: "word",   min_token_len: 2, lowercase: true }],
  ] as const) {
    await qd.createPayloadIndex(col, { field_name: field, field_schema: schema, wait: true });
  }

  process.stderr.write(`[qdrant] Created collection: ${col} (named vectors)\n`);
}

const NEW_MEMORY_COLLECTIONS = ["memory", "memory_agents"] as const;
const NEW_MEMORY_INDEXES = [
  "project_id", "agent_id", "status", "session_id",
  "session_type", "content_hash", "source",
] as const;

async function ensureNewMemoryCollections(existing: Set<string>): Promise<void> {
  for (const name of NEW_MEMORY_COLLECTIONS) {
    const col = colName(name);
    if (existing.has(col)) continue;
    await qd.createCollection(col, { vectors: { size: _embedDim, distance: "Cosine" } });
    for (const field of NEW_MEMORY_INDEXES) {
      await qd.createPayloadIndex(col, { field_name: field, field_schema: "keyword", wait: true });
    }
    process.stderr.write(`[qdrant] Created collection: ${col}\n`);
  }
}

export async function ensureCollections(): Promise<void> {
  const { collections } = await qd.getCollections();
  const existing = new Set(collections.map((c) => c.name));

  for (const name of MEMORY_COLLECTIONS) {
    const col = colName(name);
    if (existing.has(col)) continue;

    await qd.createCollection(col, {
      vectors: { size: _embedDim, distance: "Cosine" },
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

  await ensureNewMemoryCollections(existing);
  await ensureCodeChunks();

  // hook_calls — payload-only collection (vector size 1, dummy float)
  if (!existing.has(colName("hook_calls"))) {
    await qd.createCollection(colName("hook_calls"), { vectors: { size: 1, distance: "Cosine" } });
    process.stderr.write(`[qdrant] Created collection: ${colName("hook_calls")}\n`);
  }
}
