import { Component, input } from "@angular/core";
import type { RequestEntry } from "../../types";

@Component({
  selector: "app-request-log",
  standalone: true,
  templateUrl: "./request-log.component.html",
})
export class RequestLogComponent {
  readonly entries = input.required<RequestEntry[]>();
  fmtBytes(n: number): string { return n >= 1024 ? (n / 1024).toFixed(1) + "K" : String(n); }
  fmtTime(ts: number): string { return new Date(ts).toTimeString().slice(0, 8); }
  srcClass(e: RequestEntry): string {
    return e.source === "mcp" ? "badge-mcp" : e.source === "playground" ? "badge-pg" : "badge-watch";
  }
  srcLabel(e: RequestEntry): string {
    return e.source === "playground" ? "pg" : e.source === "watcher" ? "watch" : e.source;
  }
  outVal(e: RequestEntry): string {
    return e.source === "watcher"
      ? (e.chunks != null ? `${e.chunks}\u00a0ch` : "—")
      : this.fmtBytes(e.bytesOut);
  }
}
