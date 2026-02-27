import { Component, computed, input } from "@angular/core";
import type { ToolStats } from "../../types";

@Component({
  selector: "app-stats-table",
  standalone: true,
  templateUrl: "./stats-table.component.html",
})
export class StatsTableComponent {
  readonly stats = input.required<Record<string, ToolStats>>();
  readonly rows  = computed(() =>
    Object.entries(this.stats()).sort(([a], [b]) => a.localeCompare(b))
  );
  fmtBytes(n: number): string {
    return n >= 1024 ? (n / 1024).toFixed(1) + "K" : String(n);
  }
}
