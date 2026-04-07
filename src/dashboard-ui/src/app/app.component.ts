import { Component, OnInit, signal, effect } from "@angular/core";
import { SseService }          from "./services/sse.service";
import { ServerInfoComponent } from "./components/server-info.component";
import { StatsTableComponent } from "./components/stats-table.component";
import { RequestLogComponent } from "./components/request-log.component";
import { PlaygroundComponent } from "./components/playground.component";
import { MemoryComponent }     from "./components/memory.component";
import { SettingsComponent }   from "./components/settings.component";
import { FormsModule }         from "@angular/forms";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [ServerInfoComponent, StatsTableComponent, RequestLogComponent, PlaygroundComponent, MemoryComponent, SettingsComponent, FormsModule],
  templateUrl: "./app.component.html",
})
export class AppComponent implements OnInit {
  readonly init = window.__INIT__;
  readonly tab  = signal<'dashboard' | 'playground' | 'memory' | 'settings'>('dashboard');
  readonly selectedProject = signal<string>("");

  constructor(readonly sse: SseService) {
    effect(() => {
      const proj = this.selectedProject();
      const url = new URL(window.location.href);
      if (proj) {
        url.searchParams.set("project", proj);
      } else {
        url.searchParams.delete("project");
      }
      window.history.replaceState({}, "", url.toString());
    });
  }

  ngOnInit(): void {
    const url = new URL(window.location.href);
    const proj = url.searchParams.get("project") || this.init.serverInfo.projectId;
    this.selectedProject.set(proj);

    this.sse.connect(this.init);
  }

  fmtTime(ts: number): string { return new Date(ts).toTimeString().slice(0, 8); }
}
