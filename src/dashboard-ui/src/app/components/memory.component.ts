import { Component, OnInit, signal, effect, inject, input } from "@angular/core";
import { SseService } from "../services/sse.service";
import type { MemoryEntry, OverviewData } from "../../types";

interface SearchResult {
  id:           string;
  text:         string;
  status:       string;
  confidence:   number;
  score:        number;
  session_type: string;
  updated_at:   string;
}

interface SessionEntry {
  session_id:    string;
  count:         number;
  dominant_type: string;
  latest:        string;
}

@Component({
  selector:    "app-memory",
  standalone:  true,
  templateUrl: "./memory.component.html",
})
export class MemoryComponent implements OnInit {
  private readonly sse = inject(SseService);

  readonly projectId = input<string>("");

  readonly overview        = signal<OverviewData | null>(null);
  readonly searchQuery     = signal("");
  readonly searchResults   = signal<SearchResult[]>([]);
  readonly searching       = signal(false);
  readonly loading         = signal(true);
  readonly selectedStatuses = signal<ReadonlySet<string>>(new Set());
  readonly filteredEntries  = signal<MemoryEntry[]>([]);
  readonly filterLoading    = signal(false);

  constructor() {
    effect(() => {
      const live = this.sse.memory();
      if (!live) return;
      this.overview.set(live);
      this.loading.set(false);
      if (this.selectedStatuses().size > 0) {
        this._fetchByStatus(this.selectedStatuses());
      }
    });

    effect(() => {
      const pid = this.projectId();
      if (pid !== undefined) {
        this.fetchOverview();
      }
    }, { allowSignalWrites: true });
  }

  ngOnInit(): void {
    // Initial fetch handled by effect
  }

  private fetchOverview(): void {
    this.loading.set(true);
    const pid = this.projectId();
    const url = `/api/memory/overview${pid ? `?project_id=${encodeURIComponent(pid)}` : ""}`;
    void fetch(url)
      .then(r => r.json() as Promise<OverviewData>)
      .then(data => {
        this.overview.set(data);
        this.loading.set(false);
      })
      .catch(() => { this.loading.set(false); });
  }

  toggleStatus(s: string): void {
    const next = new Set(this.selectedStatuses());
    if (next.has(s)) {
      next.delete(s);
    } else {
      next.add(s);
    }
    this.selectedStatuses.set(next);
    if (next.size > 0) {
      this._fetchByStatus(next);
    } else {
      this.filteredEntries.set([]);
    }
  }

  private _fetchByStatus(statuses: ReadonlySet<string>): void {
    this.filterLoading.set(true);
    const param = [...statuses].join(",");
    const pid = this.projectId();
    const url = `/api/memory/by-status?status=${encodeURIComponent(param)}${pid ? `&project_id=${encodeURIComponent(pid)}` : ""}`;
    void fetch(url)
      .then(r => r.json() as Promise<{ entries: MemoryEntry[] }>)
      .then(data => { this.filteredEntries.set(data.entries); this.filterLoading.set(false); })
      .catch(() => { this.filterLoading.set(false); });
  }

  entriesToShow(ov: OverviewData): MemoryEntry[] {
    return this.selectedStatuses().size > 0 ? this.filteredEntries() : ov.recent;
  }

  handleSearch(): void {
    const q = this.searchQuery().trim();
    if (!q) { this.searchResults.set([]); return; }
    this.searching.set(true);
    const pid = this.projectId();
    const url = `/api/memory/search?q=${encodeURIComponent(q)}${pid ? `&project_id=${encodeURIComponent(pid)}` : ""}`;
    void fetch(url)
      .then(r => r.json() as Promise<{ results: SearchResult[] }>)
      .then(data => { this.searchResults.set(data.results); this.searching.set(false); })
      .catch(() => { this.searching.set(false); });
  }

  handleSearchInput(value: string): void {
    this.searchQuery.set(value);
    if (!value.trim()) this.searchResults.set([]);
  }

  statusClass(status: string): string {
    switch (status) {
      case "resolved":      return "text-(--color-ok)    bg-(--color-ok)/10    border-(--color-ok)/30";
      case "in_progress":   return "text-(--color-amber)  bg-(--color-amber)/10  border-(--color-amber)/30";
      case "open_question": return "text-(--color-err)    bg-(--color-err)/10    border-(--color-err)/30";
      case "hypothesis":    return "text-(--color-sky)    bg-(--color-sky)/10    border-(--color-sky)/30";
      default:              return "text-(--color-muted)  bg-(--color-surface)   border-(--color-border)";
    }
  }

  statusSquareClass(s: string): string {
    const base = this.statusClass(s);
    const sel  = this.selectedStatuses().has(s);
    const any  = this.selectedStatuses().size > 0;
    if (sel)  return `${base} cursor-pointer ring-2 ring-current`;
    if (any)  return `${base} cursor-pointer opacity-40`;
    return          `${base} cursor-pointer`;
  }

  statusLabel(status: string): string {
    switch (status) {
      case "in_progress":   return "in_progress";
      case "open_question": return "open_question";
      case "hypothesis":    return "hypothesis";
      case "resolved":      return "resolved";
      default:              return status;
    }
  }

  sessionTypeClass(t: string): string {
    switch (t) {
      case "editing":     return "text-(--color-indigo)";
      case "planning":    return "text-(--color-sky)";
      case "headless":    return "text-(--color-amber)";
      case "multi_agent": return "text-(--color-emerald)";
      default:            return "text-(--color-muted)";
    }
  }

  fmtDate(iso: string): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return `${d.toLocaleDateString()} ${d.toTimeString().slice(0, 5)}`;
  }

  truncate(text: string, max = 120): string {
    return text.length > max ? text.slice(0, max) + "…" : text;
  }

  scoreBar(score: number): string {
    return `${Math.round(score * 100)}%`;
  }

  readonly statusOrder = ["in_progress", "open_question", "hypothesis", "resolved"];
}
