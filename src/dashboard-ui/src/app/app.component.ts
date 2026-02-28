import { Component, OnInit, signal } from "@angular/core";
import { SseService }          from "./services/sse.service";
import { ServerInfoComponent } from "./components/server-info.component";
import { StatsTableComponent } from "./components/stats-table.component";
import { RequestLogComponent } from "./components/request-log.component";
import { PlaygroundComponent } from "./components/playground.component";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [ServerInfoComponent, StatsTableComponent, RequestLogComponent, PlaygroundComponent],
  templateUrl: "./app.component.html",
})
export class AppComponent implements OnInit {
  readonly init = window.__INIT__;
  readonly tab  = signal<'dashboard' | 'playground'>('dashboard');
  constructor(readonly sse: SseService) {}
  ngOnInit(): void { this.sse.connect(this.init); }
}
