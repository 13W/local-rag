interface SessionInfo {
  sessionId: string;
  expiresAt: number;
}

const TTL_MS = 3_600_000; // 1 hour

const store = new Map<string, SessionInfo>();

function key(projectId: string, agentId: string): string {
  return `${projectId}:${agentId}`;
}

/**
 * Store a session_id for the given project/agent pair.
 * ttlMs overrides the default 1h TTL (useful for tests).
 */
export function setSession(
  projectId: string,
  agentId: string,
  sessionId: string,
  ttlMs = TTL_MS,
): void {
  store.set(key(projectId, agentId), {
    sessionId,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * Retrieve the stored session_id. Returns undefined if not found or expired.
 * Evicts expired entries on read.
 */
export function getSession(projectId: string, agentId: string): string | undefined {
  const k = key(projectId, agentId);
  const info = store.get(k);
  if (!info) return undefined;
  if (Date.now() > info.expiresAt) {
    store.delete(k);
    return undefined;
  }
  return info.sessionId;
}

/** Clear all stored sessions. For testing only. */
export function clearStore(): void {
  store.clear();
}
