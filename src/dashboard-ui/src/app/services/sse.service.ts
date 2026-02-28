import { Injectable, OnDestroy, signal } from "@angular/core";
import type { InitData, ProcessError, RequestEntry, ToolStats } from "../../types";

const LOG_MAX = 500;

@Injectable({ providedIn: "root" })
export class SseService implements OnDestroy {
  readonly status = signal<"connecting" | "connected" | "disconnected">("connecting");
  readonly stats  = signal<Record<string, ToolStats>>({});
  readonly log    = signal<RequestEntry[]>([]);
  readonly errors = signal<ProcessError[]>([]);

  private es: EventSource | null = null;

  connect(init: InitData): void {
    this.stats.set(init.stats);
    this.log.set([...init.log].reverse());

    this.es = new EventSource("/events");
    this.es.onmessage = ({ data }: MessageEvent<string>) => {
      const msg = JSON.parse(data) as
        | { type: "init";     stats: Record<string, ToolStats>; log: RequestEntry[] }
        | { type: "entry";    stats: Record<string, ToolStats>; entry: RequestEntry }
        | { type: "error";    message: string; stack: string; ts: number }
        | { type: "shutdown" };
      if (msg.type === "init") {
        this.status.set("connected");
        this.stats.set(msg.stats);
        this.log.set([...msg.log].reverse());
      }
      if (msg.type === "entry") {
        this.stats.set(msg.stats);
        this.log.update(prev => [msg.entry, ...prev].slice(0, LOG_MAX));
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
