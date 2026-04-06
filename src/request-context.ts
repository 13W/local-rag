import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestCtx {
  projectId: string;
  agentId:   string;
}

const _store = new AsyncLocalStorage<RequestCtx>();

export const requestContext = _store;

/** Run fn with the given request context active. */
export function runWithContext<T>(ctx: RequestCtx, fn: () => T): T {
  return _store.run(ctx, fn);
}

/** Get current projectId, falling back to "default". */
export function getProjectId(): string {
  return _store.getStore()?.projectId ?? "default";
}

/** Get current agentId, falling back to "default". */
export function getAgentId(): string {
  return _store.getStore()?.agentId ?? "default";
}
