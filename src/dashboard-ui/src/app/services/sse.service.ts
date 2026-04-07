import { Injectable, OnDestroy, signal } from "@angular/core";
import type { InitData, ProcessError, ReindexProgress, RequestEntry, ServerInfo, ToolStats, OverviewData, ProjectConfigData } from "../../types";

const LOG_MAX = 500;

@Injectable({ providedIn: "root" })
export class SseService implements OnDestroy {
  readonly status     = signal<"connecting" | "connected" | "disconnected">("connecting");
  readonly stats      = signal<Record<string, ToolStats>>({});
  readonly log        = signal<RequestEntry[]>([]);
  readonly errors     = signal<ProcessError[]>([]);
  readonly reindex    = signal<ReindexProgress | null>(null);
  readonly serverInfo = signal<ServerInfo | null>(null);
  readonly memory     = signal<OverviewData | null>(null);
  readonly projects   = signal<ProjectConfigData[]>([]);

  private es: EventSource | null = null;

  connect(init: InitData): void {
    this.stats.set(init.stats);
    this.log.set([...init.log].reverse());
    this.serverInfo.set(init.serverInfo);
    this.projects.set(init.projects);

    this.es = new EventSource("/events");
    this.es.onmessage = ({ data }: MessageEvent<string>) => {
      const msg = JSON.parse(data) as
        | { type: "init";     stats: Record<string, ToolStats>; log: RequestEntry[] }
        | { type: "entry";    stats: Record<string, ToolStats>; entry: RequestEntry }
        | { type: "reindex";  progress: ReindexProgress }
        | { type: "branch";   branch: string }
        | { type: "memory";   overview: OverviewData }
        | { type: "error";    message: string; stack: string; ts: number }
        | { type: "shutdown" };
      if (msg.type === "init") {
        this.status.set("connected");
        this.stats.set(msg.stats);
        this.log.set([...msg.log].reverse());
        const initMsg = msg as typeof msg & { reindex?: ReindexProgress | null; projects?: ProjectConfigData[] };
        this.reindex.set(initMsg.reindex ?? null);
        if (initMsg.projects) this.projects.set(initMsg.projects);
      }
      if (msg.type === "entry") {
        this.stats.set(msg.stats);
        this.log.update(prev => [msg.entry, ...prev].slice(0, LOG_MAX));
      }
      if (msg.type === "reindex") {
        const p = msg.progress;
        // Clear when done (done === total and total > 0)
        this.reindex.set(p.total > 0 && p.done >= p.total ? null : p);
      }
      if (msg.type === "branch") {
        this.serverInfo.update(prev => prev ? { ...prev, branch: msg.branch } : prev);
      }
      if (msg.type === "memory") {
        this.memory.set(msg.overview);
      }
      if (msg.type === "error") {
        this.errors.update(prev => [{ message: msg.message, stack: msg.stack, ts: msg.ts }, ...prev]);
      }
      if (msg.type === "shutdown") { window.close(); }
    };
    this.es.onerror = () => {
      this.status.set("disconnected");
      document.title = "disconnected";
    };
  }

  clearErrors(): void { this.errors.set([]); }

  ngOnDestroy(): void { this.es?.close(); }
}
