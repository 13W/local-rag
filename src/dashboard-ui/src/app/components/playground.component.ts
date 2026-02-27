import { Component, computed, input, signal } from "@angular/core";
import type { PropSchema, ToolSchemaDef } from "../../types";

interface RunResult { ok: boolean; result?: string; error?: string; ms: number; }

@Component({
  selector: "app-playground",
  standalone: true,
  templateUrl: "./playground.component.html",
})
export class PlaygroundComponent {
  readonly schemas = input.required<ToolSchemaDef[]>();

  readonly selectedTool = signal("");
  readonly argValues    = signal<Record<string, string | boolean>>({});
  readonly running      = signal(false);
  readonly runStatus    = signal<{ text: string; ok: boolean } | null>(null);
  readonly output       = signal("");

  readonly schema   = computed(() => this.schemas().find(s => s.name === this.selectedTool()));
  readonly props    = computed(() => this.schema()?.inputSchema.properties ?? {});
  readonly required = computed(() => this.schema()?.inputSchema.required   ?? []);
  readonly propKeys = computed(() => Object.keys(this.props()));

  handleToolChange(name: string): void {
    this.selectedTool.set(name);
    this.argValues.set({});
    this.runStatus.set(null);
    this.output.set("");
  }

  getProp(key: string): PropSchema { return this.props()[key] as PropSchema; }
  isRequired(key: string): boolean { return this.required().includes(key); }
  getVal(key: string): string | boolean | undefined { return this.argValues()[key]; }
  setVal(key: string, value: string | boolean): void {
    this.argValues.update(prev => ({ ...prev, [key]: value }));
  }
  isChecked(key: string): boolean {
    const p = this.getProp(key); const v = this.getVal(key);
    return v === true || v === "true" || (v === undefined && p.default === true);
  }
  inputVal(key: string): string {
    const p = this.getProp(key); const v = this.getVal(key);
    return v !== undefined ? String(v) : (p.default !== undefined ? String(p.default) : "");
  }

  handleRun(): void {
    const schema = this.schema();
    if (!this.selectedTool() || !schema) return;
    const args: Record<string, unknown> = {};
    for (const key of this.propKeys()) {
      const p = this.getProp(key); const v = this.getVal(key);
      if (p.type === "boolean") {
        args[key] = v === true || v === "true";
      } else if (p.type === "number" || p.type === "integer") {
        if (v !== "" && v !== undefined) args[key] = Number(v);
      } else {
        if (v !== "" && v !== undefined) args[key] = v;
      }
    }
    this.running.set(true);
    this.runStatus.set({ text: "running…", ok: true });
    this.output.set("");
    fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: this.selectedTool(), args }),
    })
      .then(r => r.json() as Promise<RunResult>)
      .then(data => {
        this.running.set(false);
        this.runStatus.set({ text: `${data.ok ? "✓" : "✗"} ${data.ms}ms`, ok: data.ok });
        this.output.set(data.ok ? (data.result ?? "") : (data.error ?? ""));
      })
      .catch((err: unknown) => {
        this.running.set(false);
        this.runStatus.set({ text: "✗ error", ok: false });
        this.output.set(String(err));
      });
  }
}
