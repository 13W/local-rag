import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestCtx {
  projectId: string;
}

const _store = new AsyncLocalStorage<RequestCtx>();

export const requestContext = _store;

export function runWithContext<T>(ctx: RequestCtx, fn: () => T): T {
  return _store.run(ctx, fn);
}

export function getProjectId(): string {
  return _store.getStore()?.projectId ?? "default";
}
