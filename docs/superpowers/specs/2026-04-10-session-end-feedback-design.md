# SessionEnd Feedback — Design Spec

**Date:** 2026-04-10  
**Status:** Approved

---

## Overview

Add a `SessionEnd` hook that asks the AI to provide feedback on the usefulness of MCP tools used during the session. Feedback is collected via a new MCP tool `give_feedback` and stored in a dedicated Qdrant collection `feedback`.

The primary motivation: AI agents often receive valuable context from hooks (prior bugs, hypotheses, decisions) but ignore it and start from scratch. This feedback loop surfaces such patterns so the system can improve over time.

---

## Architecture

```
SessionEnd event (Claude Code / Gemini / Codex)
    │
    ▼
local-rag hook-session-end --project X --agent Y
    │  reads stdin: { session_id, transcript_path, cwd, hook_event_name }
    │
    ▼
POST /hooks/session-end?project=X&agent=Y
    │  stores session_id in SessionStore (in-memory Map, TTL 1h)
    │  returns { systemMessage }
    │
    ▼
systemMessage injected into AI
    │  contains: session_id + prompt to call give_feedback(...)
    │
    ▼
AI calls give_feedback(content="...", session_id="...")
    │  via MCP endpoint /mcp?project=X&agent=Y
    │
    ▼
give_feedback tool
    │  resolves session_id: args.session_id ?? SessionStore.get(project:agent)
    │  embeds content
    │  upserts into Qdrant "feedback" collection
```

---

## Components

### New files

| File | Purpose |
|------|---------|
| `src/hook-session-end.ts` | CLI entry point — mirrors `hook-remember.ts`, POSTs to `/hooks/session-end` |
| `src/tools/give_feedback.ts` | MCP tool handler — embeds content, writes to Qdrant `feedback` |
| `src/session-store.ts` | In-memory singleton `Map<"project:agent", { sessionId, expiresAt }>` with 1h TTL |

### Modified files

| File | Change |
|------|--------|
| `src/bin.ts` | Add `hook-session-end` branch |
| `src/qdrant.ts` | Add `"feedback"` to `COLLECTIONS`, create in `ensureCollections()` |
| `src/plugins/hooks.ts` | Add `POST /hooks/session-end` endpoint |
| `src/tools/registry.ts` | Add `give_feedback` to `TOOLS` + `dispatchTool()` |
| `src/init.ts` | Add `SessionEnd` hook (Claude), extend `AfterAgent` (Gemini) |

---

## Qdrant Collection: `feedback`

Created at server startup via `ensureCollections()`. Respects collection prefix (e.g. `gemma_feedback`).

```
vector:    size=embedDim, distance=Cosine
payload:
  content      string   — markdown feedback from AI (free-form, no restrictions)
  session_id   string   — from hook body or SessionStore fallback
  project_id   string   — keyword index
  agent_id     string   — keyword index
  agent_type   string   — "claude" | "gemini" | "codex" | "unknown"  (keyword index)
  hook_event   string   — "SessionEnd" | "AfterAgent"
  created_at   string   — ISO 8601
```

Payload indexes: `project_id`, `agent_id`, `agent_type`, `session_id`.

No TTL — feedback is permanent.

---

## MCP Tool: `give_feedback`

```typescript
{
  name: "give_feedback",
  description:
    "Record feedback about MCP tools and hooks used in this session.\n" +
    "Call at the end of a session to report:\n" +
    "- Which tools were helpful and which were not\n" +
    "- Whether hook-injected context was used or ignored\n" +
    "- Suggestions for improvement\n\n" +
    "Args:\n" +
    "  content: Markdown feedback (no restrictions on length or format)\n" +
    "  session_id: Session ID from the SessionEnd hook message (optional — server will use last known)",
  inputSchema: {
    type: "object",
    properties: {
      content:    { type: "string", description: "Markdown feedback" },
      session_id: { type: "string", description: "Session ID (optional)", default: "" },
    },
    required: ["content"],
  },
}
```

**Resolution order for session_id:**
1. `args.session_id` if non-empty
2. `SessionStore.get("${projectId}:${agentId}")` if present and not expired
3. `"unknown"`

**agent_type detection:** inferred from `--agent-type` CLI flag passed by `init.ts` when generating hook commands. The flag is forwarded to the HTTP endpoint as a query param `agent_type`. Fallback: `"unknown"`.

`init.ts` generates:
- Claude: `local-rag hook-session-end --project X --agent Y --agent-type claude`
- Gemini: `local-rag hook-session-end --project X --agent Y --agent-type gemini`

---

## SessionStore

```typescript
// src/session-store.ts
interface SessionInfo {
  sessionId:  string;
  expiresAt:  number;  // Date.now() + 3_600_000
}

const store = new Map<string, SessionInfo>();

export function setSession(projectId: string, agentId: string, sessionId: string): void
export function getSession(projectId: string, agentId: string): string | undefined
```

`getSession` evicts expired entries on read. No background timer needed.

---

## HTTP Endpoint: POST /hooks/session-end

```typescript
// in src/plugins/hooks.ts
fastify.post("/hooks/session-end", async (req, reply) => {
  const { session_id, hook_event_name } = req.body;
  const { project, agent } = req.query;

  // 1. Store session_id for give_feedback fallback
  setSession(project, agent, session_id);

  // 2. Build systemMessage
  const systemMessage = buildSessionEndMessage(session_id);

  // 3. Persist to request_logs (TTL 7 days)
  await persistHookCall("session-end", session_id, project, { agent_id: agent, hook_event: hook_event_name ?? "SessionEnd" });

  // 4. Dashboard visibility
  record("hooks/session-end", "hook", bytesIn, bytesOut, ms, true);

  return reply.send({ systemMessage });
});
```

---

## systemMessage Template

```
## Session complete — please give feedback on MCP tools

**Session ID:** {session_id}

Call `give_feedback` with your honest assessment of this session:

\`\`\`
give_feedback(
  content="...",
  session_id="{session_id}"
)
\`\`\`

Suggested topics (write freely, no format required):
- Which MCP tools did you use, and were they helpful?
- Did you read and act on the context injected by `UserPromptSubmit` or `SessionStart` hooks?
  Or did you start from scratch and ignore it? Why?
- Were there moments where prior memory (recall/search_code) saved steps, or where you wished you had more context?
- What would make the system more useful in future sessions?
```

---

## init.ts Changes

### Claude Code (`settings.local.json`)

Add to `hooks`:
```json
"SessionEnd": [{
  "hooks": [{
    "type": "command",
    "command": "local-rag hook-session-end --project {projectId} --agent {agentId}"
  }]
}]
```

### Gemini CLI (`.gemini/settings.json`)

Extend `AfterAgent` — add a second hook entry alongside the existing `hook-remember`:
```json
"AfterAgent": [
  { "hooks": [{ "type": "command", "command": "local-rag hook-remember --project X --agent Y" }] },
  { "hooks": [{ "type": "command", "command": "local-rag hook-session-end --project X --agent Y" }] }
]
```

---

## CLI Entry Point

`src/hook-session-end.ts` — identical structure to `hook-remember.ts`:
- reads stdin
- parses `--project` / `--agent` / `--agent-type` args
- POSTs to `/hooks/session-end?project=X&agent=Y&agent_type=Z`
- writes response to stdout

`src/bin.ts` — add:
```typescript
} else if (cmd === "hook-session-end") {
  const { runHookSessionEnd } = await import("./hook-session-end.js");
  await runHookSessionEnd();
}
```

---

## Out of Scope

- No transcript parsing in SessionEnd (user explicitly chose not to pre-extract tool stats)
- No structured rating fields (free-form markdown only)
- No dashboard UI for feedback collection (future work)
- Codex support: hooks config not yet implemented in `init.ts` (Codex has no hook system yet)
