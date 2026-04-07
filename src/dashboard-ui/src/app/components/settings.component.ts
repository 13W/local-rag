import { Component, OnInit, signal } from "@angular/core";
import { CommonModule }              from "@angular/common";
import type { ServerConfigData, ProjectConfigData } from "../../types";

@Component({
  selector: "app-settings",
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="settings overflow-y-auto h-full p-4">
      <h2 class="text-[0.9rem] font-semibold uppercase tracking-[0.07em] text-(--color-indigo) mb-3">Server Settings</h2>
      @if (serverCfg()) {
        <div class="flex flex-col gap-2 mb-6">
          <h3 class="text-xs font-semibold text-(--color-muted) uppercase tracking-wider mt-2">Embed</h3>
          <label class="flex gap-2 items-center text-xs">
            <span class="w-28 text-(--color-muted)">Provider</span>
            <input class="flex-1 bg-(--color-surface) border border-(--color-border) rounded px-2 py-1 text-xs font-mono text-(--color-text)"
              [value]="serverCfg()!.embed.provider"
              (input)="patchEmbed('provider', $any($event.target).value)" />
          </label>
          <label class="flex gap-2 items-center text-xs">
            <span class="w-28 text-(--color-muted)">Model</span>
            <input class="flex-1 bg-(--color-surface) border border-(--color-border) rounded px-2 py-1 text-xs font-mono text-(--color-text)"
              [value]="serverCfg()!.embed.model"
              (input)="patchEmbed('model', $any($event.target).value)" />
          </label>
          <label class="flex gap-2 items-center text-xs">
            <span class="w-28 text-(--color-muted)">API Key</span>
            <input class="flex-1 bg-(--color-surface) border border-(--color-border) rounded px-2 py-1 text-xs font-mono text-(--color-text)"
              type="password" [value]="serverCfg()!.embed.api_key"
              (input)="patchEmbed('api_key', $any($event.target).value)" />
          </label>
          <label class="flex gap-2 items-center text-xs">
            <span class="w-28 text-(--color-muted)">Dim</span>
            <input class="flex-1 bg-(--color-surface) border border-(--color-border) rounded px-2 py-1 text-xs font-mono text-(--color-text)"
              type="number" [value]="serverCfg()!.embed.dim"
              (input)="patchEmbed('dim', +$any($event.target).value)" />
          </label>

          <h3 class="text-xs font-semibold text-(--color-muted) uppercase tracking-wider mt-2">LLM</h3>
          <label class="flex gap-2 items-center text-xs">
            <span class="w-28 text-(--color-muted)">Provider</span>
            <input class="flex-1 bg-(--color-surface) border border-(--color-border) rounded px-2 py-1 text-xs font-mono text-(--color-text)"
              [value]="serverCfg()!.llm.provider"
              (input)="patchLlm('provider', $any($event.target).value)" />
          </label>
          <label class="flex gap-2 items-center text-xs">
            <span class="w-28 text-(--color-muted)">Model</span>
            <input class="flex-1 bg-(--color-surface) border border-(--color-border) rounded px-2 py-1 text-xs font-mono text-(--color-text)"
              [value]="serverCfg()!.llm.model"
              (input)="patchLlm('model', $any($event.target).value)" />
          </label>
          <label class="flex gap-2 items-center text-xs">
            <span class="w-28 text-(--color-muted)">API Key</span>
            <input class="flex-1 bg-(--color-surface) border border-(--color-border) rounded px-2 py-1 text-xs font-mono text-(--color-text)"
              type="password" [value]="serverCfg()!.llm.api_key"
              (input)="patchLlm('api_key', $any($event.target).value)" />
          </label>

          <h3 class="text-xs font-semibold text-(--color-muted) uppercase tracking-wider mt-2">Router</h3>
          <label class="flex gap-2 items-center text-xs">
            <span class="w-28 text-(--color-muted)">Provider</span>
            <input class="flex-1 bg-(--color-surface) border border-(--color-border) rounded px-2 py-1 text-xs font-mono text-(--color-text)"
              [value]="serverCfg()!.router.provider"
              (input)="patchRouter('provider', $any($event.target).value)" />
          </label>
          <label class="flex gap-2 items-center text-xs">
            <span class="w-28 text-(--color-muted)">Model</span>
            <input class="flex-1 bg-(--color-surface) border border-(--color-border) rounded px-2 py-1 text-xs font-mono text-(--color-text)"
              [value]="serverCfg()!.router.model"
              (input)="patchRouter('model', $any($event.target).value)" />
          </label>
          <label class="flex gap-2 items-center text-xs">
            <span class="w-28 text-(--color-muted)">API Key</span>
            <input class="flex-1 bg-(--color-surface) border border-(--color-border) rounded px-2 py-1 text-xs font-mono text-(--color-text)"
              type="password" [value]="serverCfg()!.router.api_key"
              (input)="patchRouter('api_key', $any($event.target).value)" />
          </label>

          <h3 class="text-xs font-semibold text-(--color-muted) uppercase tracking-wider mt-2">General</h3>
          <label class="flex gap-2 items-center text-xs">
            <span class="w-28 text-(--color-muted)">Collection prefix</span>
            <input class="flex-1 bg-(--color-surface) border border-(--color-border) rounded px-2 py-1 text-xs font-mono text-(--color-text)"
              [value]="serverCfg()!.collection_prefix"
              (input)="patchServer('collection_prefix', $any($event.target).value)" />
          </label>
          <label class="flex gap-2 items-center text-xs">
            <span class="w-28 text-(--color-muted)">Port (restart)</span>
            <input class="flex-1 bg-(--color-surface) border border-(--color-border) rounded px-2 py-1 text-xs font-mono text-(--color-text)"
              type="number" [value]="serverCfg()!.port"
              (input)="patchServer('port', +$any($event.target).value)" />
          </label>

          <button
            class="mt-2 self-start px-3 py-1 text-xs font-mono bg-(--color-indigo) text-white rounded cursor-pointer border-none"
            (click)="saveServer()">Save Server Settings</button>
        </div>
      }

      <h2 class="text-[0.9rem] font-semibold uppercase tracking-[0.07em] text-(--color-indigo) mb-3">Project Settings</h2>
      @if (projectCfg()) {
        <div class="flex flex-col gap-2 mb-6">
          <label class="flex gap-2 items-center text-xs">
            <span class="w-28 text-(--color-muted)">Display name</span>
            <input class="flex-1 bg-(--color-surface) border border-(--color-border) rounded px-2 py-1 text-xs font-mono text-(--color-text)"
              [value]="projectCfg()!.display_name"
              (input)="patchProject('display_name', $any($event.target).value)" />
          </label>
          <label class="flex gap-2 items-center text-xs">
            <span class="w-28 text-(--color-muted)">Agent name</span>
            <input class="flex-1 bg-(--color-surface) border border-(--color-border) rounded px-2 py-1 text-xs font-mono text-(--color-text)"
              [value]="projectCfg()!.agent_id"
              (input)="patchProject('agent_id', $any($event.target).value)" />
          </label>
          <label class="flex gap-2 items-center text-xs">
            <span class="w-28 text-(--color-muted)">Project root</span>
            <input class="flex-1 bg-(--color-surface) border border-(--color-border) rounded px-2 py-1 text-xs font-mono text-(--color-text)"
              [value]="projectCfg()!.project_root"
              (input)="patchProject('project_root', $any($event.target).value)" />
          </label>
          <label class="flex gap-2 items-start text-xs">
            <span class="w-28 text-(--color-muted) mt-1">Include paths</span>
            <textarea class="flex-1 bg-(--color-surface) border border-(--color-border) rounded px-2 py-1 text-xs font-mono text-(--color-text) min-h-[80px] resize-y"
              [value]="projectCfg()!.include_paths.join('\\n')"
              (input)="onIncludePathsInput($any($event.target).value)"></textarea>
          </label>

          <h3 class="text-xs font-semibold text-(--color-muted) uppercase tracking-wider mt-2">Indexer</h3>
          <div class="flex gap-2 items-center">
            <button class="px-3 py-1 text-xs font-mono bg-(--color-surface) border border-(--color-border) rounded cursor-pointer"
              (click)="setIndexerState('running')">Start</button>
            <button class="px-3 py-1 text-xs font-mono bg-(--color-surface) border border-(--color-border) rounded cursor-pointer"
              (click)="setIndexerState('paused')">Pause</button>
            <button class="px-3 py-1 text-xs font-mono bg-(--color-surface) border border-(--color-border) rounded cursor-pointer"
              (click)="setIndexerState('stopped')">Stop</button>
            <span class="text-xs text-(--color-muted)">Current: {{ projectCfg()!.indexer_state }}</span>
          </div>

          <button
            class="mt-2 self-start px-3 py-1 text-xs font-mono bg-(--color-indigo) text-white rounded cursor-pointer border-none"
            (click)="saveProject()">Save Project Settings</button>
        </div>
      }

      @if (saved()) {
        <div class="fixed bottom-4 right-4 bg-(--color-surface) border border-(--color-indigo) text-(--color-indigo) text-xs font-mono px-3 py-1.5 rounded">
          Saved
        </div>
      }
    </div>
  `,
})
export class SettingsComponent implements OnInit {
  readonly serverCfg  = signal<ServerConfigData | null>(null);
  readonly projectCfg = signal<ProjectConfigData | null>(null);
  readonly saved      = signal(false);

  ngOnInit(): void {
    void fetch("/api/config/server")
      .then(r => r.json() as Promise<ServerConfigData>)
      .then(d => this.serverCfg.set(d));

    const projectId = new URLSearchParams(window.location.search).get("project") ?? "default";
    void fetch(`/api/projects/${projectId}`)
      .then(r => r.ok ? r.json() as Promise<ProjectConfigData> : null)
      .then(d => { if (d) this.projectCfg.set(d); });
  }

  patchServer(key: keyof ServerConfigData, value: unknown): void {
    const cur = this.serverCfg();
    if (cur) this.serverCfg.set({ ...cur, [key]: value });
  }

  patchEmbed(key: string, value: unknown): void {
    const cur = this.serverCfg();
    if (cur) this.serverCfg.set({ ...cur, embed: { ...cur.embed, [key]: value } });
  }

  patchLlm(key: string, value: unknown): void {
    const cur = this.serverCfg();
    if (cur) this.serverCfg.set({ ...cur, llm: { ...cur.llm, [key]: value } });
  }

  patchRouter(key: string, value: unknown): void {
    const cur = this.serverCfg();
    if (cur) this.serverCfg.set({ ...cur, router: { ...cur.router, [key]: value } });
  }

  patchProject(key: keyof ProjectConfigData, value: unknown): void {
    const cur = this.projectCfg();
    if (cur) this.projectCfg.set({ ...cur, [key]: value });
  }

  onIncludePathsInput(value: string): void {
    this.patchProject("include_paths", value.split("\n").map(s => s.trim()).filter(Boolean));
  }

  saveServer(): void {
    void fetch("/api/config/server", {
      method:  "PUT",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(this.serverCfg()),
    }).then(() => this.flash());
  }

  saveProject(): void {
    const cfg = this.projectCfg();
    if (!cfg) return;
    void fetch(`/api/projects/${cfg.project_id}`, {
      method:  "PUT",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(cfg),
    }).then(() => this.flash());
  }

  setIndexerState(state: "running" | "paused" | "stopped"): void {
    this.patchProject("indexer_state", state);
    this.saveProject();
  }

  private flash(): void {
    this.saved.set(true);
    setTimeout(() => this.saved.set(false), 2000);
  }
}
