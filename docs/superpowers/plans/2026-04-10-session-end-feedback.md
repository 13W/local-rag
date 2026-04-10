# SessionEnd Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `SessionEnd` hook that prompts the AI to call a new `give_feedback` MCP tool, storing session feedback in a dedicated Qdrant `feedback` collection.

**Architecture:** A new CLI entry point `hook-session-end` mirrors the existing `hook-remember` pattern — it POSTs to a new `/hooks/session-end` HTTP endpoint that stores the session_id in an in-memory `SessionStore` and returns a `systemMessage` asking the AI to call `give_feedback`. The `give_feedback` MCP tool embeds the markdown content and upserts it into the `feedback` Qdrant collection.

**Tech Stack:** TypeScript, Fastify, Qdrant (`@qdrant/js-client-rest`), Vitest, existing `embedOne` / `colName` / `requestContext` utilities.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/session-store.ts` | In-memory map of `"project:agent"` → `{ sessionId, expiresAt }` with 1h TTL |
| Create | `src/tools/give_feedback.ts` | MCP tool: embeds content, writes to `feedback` collection |
| Create | `src/hook-session-end.ts` | CLI entry: reads stdin, POSTs to `/hooks/session-end`, writes response to stdout |
| Create | `src/session-store.test.ts` | Vitest unit tests for SessionStore |
| Modify | `src/qdrant.ts` | Add `"feedback"` to `COLLECTIONS`, create collection in `ensureCollections()` |
| Modify | `src/plugins/hooks.ts` | Add `POST /hooks/session-end` endpoint |
| Modify | `src/tools/registry.ts` | Add `give_feedback` tool definition + dispatch case |
| Modify | `src/bin.ts` | Add `"hook-session-end"` command branch |
| Modify | `src/init.ts` | Add `SessionEnd` hook (Claude), extend `AfterAgent` (Gemini) |

---

## Task 1: SessionStore — write test, implement, commit

**Files:**
- Create: `src/session-store.test.ts`
- Create: `src/session-store.ts`

- [ ] **Step 1: Write the failing test**

Create `src/session-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";

// Dynamic import so module state resets between test runs
async function freshStore() {
  // Bust module cache by appending a unique query string
  const mod = await import(`./session-store.js?t=${Date.now()}`);
  return mod as typeof import("./session-store.js");
}

describe("SessionStore", () => {
  it("returns undefined when nothing stored", async () => {
    const { getSession } = await freshStore();
    expect(getSession("proj", "agent")).toBeUndefined();
  });

  it("stores and retrieves session_id", async () => {
    const { setSession, getSession } = await freshStore();
    setSession("proj", "agent", "sess-123");
    expect(getSession("proj", "agent")).toBe("sess-123");
  });

  it("overwrites previous session_id", async () => {
    const { setSession, getSession } = await freshStore();
    setSession("proj", "agent", "old");
    setSession("proj", "agent", "new");
    expect(getSession("proj", "agent")).toBe("new");
  });

  it("returns undefined for expired entries", async () => {
    const { setSession, getSession } = await freshStore();
    // Set with a TTL of 0ms — already expired
    setSession("proj", "agent", "expired", -1);
    expect(getSession("proj", "agent")).toBeUndefined();
  });

  it("different project/agent keys are independent", async () => {
    const { setSession, getSession } = await freshStore();
    setSession("proj-a", "agent", "sess-a");
    setSession("proj-b", "agent", "sess-b");
    expect(getSession("proj-a", "agent")).toBe("sess-a");
    expect(getSession("proj-b", "agent")).toBe("sess-b");
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /opt/node/local-rag && pnpm test src/session-store.test.ts
```

Expected: error — `Cannot find module './session-store.js'`

- [ ] **Step 3: Implement SessionStore**

Create `src/session-store.ts`:

```typescript
interface SessionInfo {
  sessionId:  string;
  expiresAt:  number;
}

const TTL_MS = 3_600_000; // 1 hour

const store = new Map<string, SessionInfo>();

function key(projectId: string, agentId: string): string {
  return `${projectId}:${agentId}`;
}

/**
 * Store a session_id for the given project/agent pair.
 * ttlMs overrides the default 1h TTL (useful for tests).
 */
export function setSession(
  projectId: string,
  agentId:   string,
  sessionId: string,
  ttlMs     = TTL_MS,
): void {
  store.set(key(projectId, agentId), {
    sessionId,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * Retrieve the stored session_id. Returns undefined if not found or expired.
 * Evicts expired entries on read.
 */
export function getSession(projectId: string, agentId: string): string | undefined {
  const k    = key(projectId, agentId);
  const info = store.get(k);
  if (!info) return undefined;
  if (Date.now() > info.expiresAt) {
    store.delete(k);
    return undefined;
  }
  return info.sessionId;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /opt/node/local-rag && pnpm test src/session-store.test.ts
```

Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /opt/node/local-rag && git add src/session-store.ts src/session-store.test.ts
git commit -m "feat: add SessionStore for session_id tracking"
```

---

## Task 2: `feedback` Qdrant collection

**Files:**
- Modify: `src/qdrant.ts`

- [ ] **Step 1: Add `"feedback"` to COLLECTIONS constant**

In `src/qdrant.ts`, find:

```typescript
export const COLLECTIONS = [
  "memory_episodic",
  "memory_semantic",
  "memory_procedural",
  "memory",
  "memory_agents",
  "code_chunks",
] as const;
```

Replace with:

```typescript
export const COLLECTIONS = [
  "memory_episodic",
  "memory_semantic",
  "memory_procedural",
  "memory",
  "memory_agents",
  "code_chunks",
  "feedback",
] as const;
```

- [ ] **Step 2: Create the feedback collection in `ensureCollections()`**

In `src/qdrant.ts`, find the line:

```typescript
  // request_logs — payload-only collection (vector size 1, dummy float)
```

Insert before it:

```typescript
  // feedback — session-end feedback from AI about MCP tool usefulness
  if (!existing.has(colName("feedback"))) {
    await qd.createCollection(colName("feedback"), {
      vectors: { size: _embedDim, distance: "Cosine" },
    });
    for (const field of ["project_id", "agent_id", "agent_type", "session_id"]) {
      await qd.createPayloadIndex(colName("feedback"), {
        field_name:   field,
        field_schema: "keyword",
        wait:         true,
      });
    }
    process.stderr.write(`[qdrant] Created collection: ${colName("feedback")}\n`);
  }

```

- [ ] **Step 3: Build to check for type errors**

```bash
cd /opt/node/local-rag && npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
cd /opt/node/local-rag && git add src/qdrant.ts
git commit -m "feat: add feedback Qdrant collection"
```

---

## Task 3: `give_feedback` MCP tool

**Files:**
- Create: `src/tools/give_feedback.ts`
- Modify: `src/tools/registry.ts`

- [ ] **Step 1: Create the tool handler**

Create `src/tools/give_feedback.ts`:

```typescript
import { qd, colName }           from "../qdrant.js";
import { embedOne }              from "../embedder.js";
import { getProjectId, getAgentId } from "../request-context.js";
import { getSession }            from "../session-store.js";
import { nowIso, contentHash }   from "../util.js";

export interface GiveFeedbackArgs {
  content:    string;
  session_id: string;  // optional — empty string means "use SessionStore"
  agent_type: string;  // optional — forwarded from hook CLI arg
}

export async function giveFeedbackTool(a: GiveFeedbackArgs): Promise<string> {
  const projectId = getProjectId();
  const agentId   = getAgentId();

  // Resolve session_id
  const sessionId = a.session_id || getSession(projectId, agentId) || "unknown";

  const id        = crypto.randomUUID();
  const now       = nowIso();
  const embedding = await embedOne(a.content);

  await qd.upsert(colName("feedback"), {
    points: [{
      id,
      vector: embedding,
      payload: {
        content:    a.content,
        session_id: sessionId,
        project_id: projectId,
        agent_id:   agentId,
        agent_type: a.agent_type || "unknown",
        hook_event: "SessionEnd",
        created_at: now,
        content_hash: contentHash(a.content),
      },
    }],
  });

  return `feedback stored: ${id} (session=${sessionId})`;
}
```

- [ ] **Step 2: Add tool definition to registry**

In `src/tools/registry.ts`, add this import at the top with the others:

```typescript
import { giveFeedbackTool }      from "./give_feedback.js";
```

In the `TOOLS` array, add after the last entry (before the closing `]`):

```typescript
  {
    name: "give_feedback",
    description:
      "Record feedback about MCP tools and hooks used in this session.\n\n" +
      "Call at the end of a session with your honest assessment:\n" +
      "- Which tools did you use, and were they helpful?\n" +
      "- Did you read and act on context injected by UserPromptSubmit / SessionStart hooks?\n" +
      "  Or did you ignore it and start from scratch? Why?\n" +
      "- What would make the system more useful in future sessions?\n\n" +
      "Args:\n" +
      "  content: Markdown feedback — no restrictions on length or format\n" +
      "  session_id: Session ID from the SessionEnd hook message (optional)",
    inputSchema: {
      type: "object" as const,
      properties: {
        content:    { type: "string", description: "Markdown feedback (no restrictions)" },
        session_id: { type: "string", description: "Session ID (optional)", default: "" },
        agent_type: { type: "string", description: "Agent type hint (optional)", default: "" },
      },
      required: ["content"],
    },
  },
```

In `dispatchTool()`, add before the final `return \`unknown tool: ${name}\``:

```typescript
  if (name === "give_feedback") {
    return giveFeedbackTool({
      content:    str(a["content"]),
      session_id: str(a["session_id"], ""),
      agent_type: str(a["agent_type"], ""),
    });
  }
```

- [ ] **Step 3: Build to check for type errors**

```bash
cd /opt/node/local-rag && npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 4: Run all tests to make sure nothing broke**

```bash
cd /opt/node/local-rag && pnpm test
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
cd /opt/node/local-rag && git add src/tools/give_feedback.ts src/tools/registry.ts
git commit -m "feat: add give_feedback MCP tool"
```

---

## Task 4: `/hooks/session-end` HTTP endpoint

**Files:**
- Modify: `src/plugins/hooks.ts`

- [ ] **Step 1: Add the import for SessionStore**

At the top of `src/plugins/hooks.ts`, add after the existing imports:

```typescript
import { setSession }            from "../session-store.js";
```

- [ ] **Step 2: Add the `buildSessionEndMessage` helper**

In `src/plugins/hooks.ts`, after the `detectSessionType` function (around line 131), add:

```typescript
function buildSessionEndMessage(sessionId: string): string {
  return [
    "## Session complete — please give feedback on MCP tools",
    "",
    `**Session ID:** ${sessionId}`,
    "",
    "Call `give_feedback` with your honest assessment of this session:",
    "",
    "```",
    `give_feedback(content="...", session_id="${sessionId}")`,
    "```",
    "",
    "Suggested topics (write freely, no format required):",
    "- Which MCP tools did you use, and were they helpful?",
    "- Did you read and act on context injected by `UserPromptSubmit` or `SessionStart` hooks?",
    "  Or did you start from scratch and ignore it? Why?",
    "- Were there moments where prior memory (`recall`/`search_code`) saved steps,",
    "  or where you wished you had more context?",
    "- What would make the system more useful in future sessions?",
  ].join("\n");
}
```

- [ ] **Step 3: Add the POST /hooks/session-end route**

In `src/plugins/hooks.ts`, inside `hooksPlugin()`, after the closing brace of the `/hooks/remember` route (around line 278), add:

```typescript
  // ── POST /hooks/session-end ──────────────────────────────────────────────────

  fastify.post<{ Body: HookBody; Querystring: { project?: string; agent?: string; agent_type?: string } }>("/hooks/session-end", async (req, reply) => {
    const t0        = Date.now();
    const body      = req.body ?? {} as HookBody;
    const bytesIn   = JSON.stringify(body).length;
    const projectId = req.query.project    || "default";
    const agentId   = req.query.agent      || projectId;
    const agentType = req.query.agent_type || "unknown";

    const sessionId = body.session_id ?? "unknown";

    return runWithContext({ projectId, agentId }, async () => {
      debugLog("hooks/session-end", `session=${sessionId} agent_type=${agentType}`);

      // Store session_id so give_feedback tool can use it as fallback
      setSession(projectId, agentId, sessionId);

      const systemMessage = buildSessionEndMessage(sessionId);

      const ms       = Date.now() - t0;
      const bytesOut = JSON.stringify({ systemMessage }).length;
      record("hooks/session-end", "hook", bytesIn, bytesOut, ms, true);

      await persistHookCall("session-end" as "recall" | "remember", sessionId, projectId, {
        agent_id:   agentId,
        agent_type: agentType,
        hook_event: body.hook_event_name ?? "SessionEnd",
      });

      return reply.send({ systemMessage });
    });
  });
```

- [ ] **Step 4: Build to check for type errors**

```bash
cd /opt/node/local-rag && npx tsc --noEmit
```

Expected: no errors. Note: `"session-end" as "recall" | "remember"` will cause a TS error — if so, update the `persistHookCall` signature. See fix below.

**If you get a TS error on `persistHookCall`**, update its signature in `hooks.ts` (around line 50):

```typescript
async function persistHookCall(
  hookType: "recall" | "remember" | "session-end",
  ...
```

- [ ] **Step 5: Run all tests**

```bash
cd /opt/node/local-rag && pnpm test
```

Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
cd /opt/node/local-rag && git add src/plugins/hooks.ts
git commit -m "feat: add /hooks/session-end HTTP endpoint"
```

---

## Task 5: `hook-session-end` CLI entry point

**Files:**
- Create: `src/hook-session-end.ts`
- Modify: `src/bin.ts`

- [ ] **Step 1: Create the CLI hook file**

Create `src/hook-session-end.ts`:

```typescript
import { readLocalConfig, defaultLocalConfigPath } from "./local-config.js";

export async function runHookSessionEnd(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) { process.stdout.write("{}"); return; }

  // Parse CLI args: --project <id> [--agent <id>] [--agent-type <type>]
  let projectId = "default";
  let agentId   = "";
  let agentType = "unknown";

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) {
      projectId = args[i + 1]!;
      i++;
    } else if (args[i] === "--agent" && args[i + 1]) {
      agentId = args[i + 1]!;
      i++;
    } else if (args[i] === "--agent-type" && args[i + 1]) {
      agentType = args[i + 1]!;
      i++;
    }
  }
  if (!agentId) agentId = projectId;

  const localCfg = await readLocalConfig(defaultLocalConfigPath()).catch(() => null);
  const port      = localCfg?.port ?? 7531;
  const serverUrl = process.env["MEMORY_SERVER_URL"] ?? `http://127.0.0.1:${port}`;

  const url = new URL(`${serverUrl}/hooks/session-end`);
  url.searchParams.set("project",    projectId);
  url.searchParams.set("agent",      agentId);
  url.searchParams.set("agent_type", agentType);

  try {
    const res = await fetch(url.toString(), {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal:  AbortSignal.timeout(30_000),
    });
    if (!res.ok) { process.stdout.write("{}"); return; }
    const data = await res.text();
    process.stdout.write(data);
  } catch {
    process.stdout.write("{}");
  }
}
```

- [ ] **Step 2: Register the command in bin.ts**

In `src/bin.ts`, find:

```typescript
} else if (cmd === "hook-session-start") {
  const { runHookSessionStart } = await import("./hook-session-start.js");
  await runHookSessionStart();
} else {
```

Replace with:

```typescript
} else if (cmd === "hook-session-start") {
  const { runHookSessionStart } = await import("./hook-session-start.js");
  await runHookSessionStart();
} else if (cmd === "hook-session-end") {
  const { runHookSessionEnd } = await import("./hook-session-end.js");
  await runHookSessionEnd();
} else {
```

- [ ] **Step 3: Build**

```bash
cd /opt/node/local-rag && npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
cd /opt/node/local-rag && git add src/hook-session-end.ts src/bin.ts
git commit -m "feat: add hook-session-end CLI entry point"
```

---

## Task 6: Wire up hooks in init.ts

**Files:**
- Modify: `src/init.ts`

- [ ] **Step 1: Add SessionEnd to Claude Code hooks**

In `src/init.ts`, inside `configureClaudeHooks()`, find:

```typescript
  hooks["SessionStart"]     = [{ hooks: [{ type: "command", command: `local-rag hook-session-start --project ${projectId} --agent ${agentId}` }] }];
  hooks["UserPromptSubmit"] = [{ matcher: ".*", hooks: [{ type: "command", command: `local-rag hook-recall --project ${projectId} --agent ${agentId}` }] }];
  hooks["Stop"]             = [{ hooks: [{ type: "command", command: `local-rag hook-remember --project ${projectId} --agent ${agentId}` }] }];
```

Replace with:

```typescript
  hooks["SessionStart"]     = [{ hooks: [{ type: "command", command: `local-rag hook-session-start --project ${projectId} --agent ${agentId}` }] }];
  hooks["UserPromptSubmit"] = [{ matcher: ".*", hooks: [{ type: "command", command: `local-rag hook-recall --project ${projectId} --agent ${agentId}` }] }];
  hooks["Stop"]             = [{ hooks: [{ type: "command", command: `local-rag hook-remember --project ${projectId} --agent ${agentId}` }] }];
  hooks["SessionEnd"]       = [{ hooks: [{ type: "command", command: `local-rag hook-session-end --project ${projectId} --agent ${agentId} --agent-type claude` }] }];
```

- [ ] **Step 2: Add session-end to Gemini AfterAgent**

In `src/init.ts`, inside `configureGeminiHooks()`, find:

```typescript
  hooks["BeforeAgent"] = [{ matcher: ".*", hooks: [{ type: "command", command: `local-rag hook-recall --project ${projectId} --agent ${agentId}` }] }];
  hooks["AfterAgent"]  = [{ hooks: [{ type: "command", command: `local-rag hook-remember --project ${projectId} --agent ${agentId}` }] }];
```

Replace with:

```typescript
  hooks["BeforeAgent"] = [{ matcher: ".*", hooks: [{ type: "command", command: `local-rag hook-recall --project ${projectId} --agent ${agentId}` }] }];
  hooks["AfterAgent"]  = [
    { hooks: [{ type: "command", command: `local-rag hook-remember --project ${projectId} --agent ${agentId}` }] },
    { hooks: [{ type: "command", command: `local-rag hook-session-end --project ${projectId} --agent ${agentId} --agent-type gemini` }] },
  ];
```

- [ ] **Step 3: Build**

```bash
cd /opt/node/local-rag && npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 4: Run all tests**

```bash
cd /opt/node/local-rag && pnpm test
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
cd /opt/node/local-rag && git add src/init.ts
git commit -m "feat: wire SessionEnd hook in init for Claude and Gemini"
```

---

## Task 7: Full build and smoke test

- [ ] **Step 1: Full build**

```bash
cd /opt/node/local-rag && pnpm build
```

Expected: builds without errors, `dist/` updated

- [ ] **Step 2: Run all tests**

```bash
cd /opt/node/local-rag && pnpm test
```

Expected: all tests PASS

- [ ] **Step 3: Verify the tool appears in the MCP tool list**

With the server running (`local-rag serve`), inspect that `give_feedback` appears:

```bash
curl -s -X POST http://localhost:7531/mcp?project=test \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | grep give_feedback
```

Expected: output contains `"give_feedback"`

- [ ] **Step 4: Verify the feedback collection is created**

```bash
curl -s http://localhost:6333/collections | grep feedback
```

Expected: output contains `"feedback"` (or `"gemma_feedback"` if prefix is set)

- [ ] **Step 5: Final commit (if any loose files)**

```bash
cd /opt/node/local-rag && git status
```

If clean — done. If any modified files remain, stage and commit them.
