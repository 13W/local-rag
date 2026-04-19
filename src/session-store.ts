interface SessionInfo {
  sessionId: string;
  expiresAt: number;
}

const TTL_MS = 3_600_000;

const store = new Map<string, SessionInfo>();

export function setSession(projectId: string, sessionId: string, ttlMs = TTL_MS): void {
  store.set(projectId, { sessionId, expiresAt: Date.now() + ttlMs });
}

export function getSession(projectId: string): string | undefined {
  const info = store.get(projectId);
  if (!info) return undefined;
  if (Date.now() > info.expiresAt) {
    store.delete(projectId);
    return undefined;
  }
  return info.sessionId;
}

export function clearStore(): void {
  store.clear();
}
