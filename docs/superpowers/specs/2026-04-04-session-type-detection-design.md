# Session Type Detection — Design

**Date:** 2026-04-04  
**Status:** Approved  
**Scope:** Completing three gaps in the existing session-type detection implementation in `hook-remember.ts`

---

## Context

Most of the session type detection feature is already implemented:

- `detectSessionType()` correctly identifies all four types (`planning`, `editing`, `headless`, `multi_agent`)
- `session_type` is written to every Qdrant payload
- Per-type confidence thresholds are in place (`headless = 0.85`)
- `multi_agent` → `memory_agents` collection; `hook-recall` reads both

Three gaps remain, addressed by this design.

---

## Gap 1 — `agent_id` from `SubagentStop` event

### Problem
`processOp` always writes `cfg.agentId` (static config value), ignoring the actual subagent identity in `multi_agent` sessions.

### Solution
Change `detectSessionType` return type from `SessionType` to:

```ts
interface SessionDetection {
  sessionType: SessionType;
  agentId:     string;
}
```

When iterating transcript lines, if a line with `type === "SubagentStop"` is found, attempt to read `agent_id`, `subagent_id`, or `sub_agent_id` from:
1. The line itself (`line["agent_id"]`, etc.)
2. The nested `line["message"]` object

First non-empty string wins. Fall back to `cfg.agentId` if nothing found.

`processOp` signature gains an `agentId: string` parameter; `cfg.agentId` reference is replaced with it.

---

## Gap 2 — Headless decision log

### Problem
Headless sessions run without a user present; there is no visibility into what the router wrote or discarded.

### Solution
New function in `src/util.ts`:

```ts
export function logHeadlessDecision(
  cwd:     string,
  op:      RouterOp,
  written: boolean,
): void
```

Appends one line to `{cwd}/.memory-headless.log` via `appendFileSync`:

```
2026-04-04T15:00:00Z  written   conf=0.82  in_progress  "text of the op"
2026-04-04T15:00:01Z  skipped   conf=0.61  hypothesis   "text of the op"
```

Called from `processOp` (which receives `cwd` from `runHookRemember` via `input.cwd`) when `sessionType === "headless"`, after the write/skip decision.  
No rotation or size limit — the file is for manual review only.

---

## Gap 3 — `request_validation` via `systemMessage` (non-headless only)

### Problem
Borderline-confidence ops (between 0.5 and the per-type threshold) are currently silently discarded. In interactive sessions Claude could validate them.

### Solution

**Constants added to `hook-remember.ts`:**
```ts
const VALIDATION_MIN_CONFIDENCE = 0.5;
```

**Op classification in `runHookRemember`:**

| Confidence | Headless | Non-headless |
|---|---|---|
| `>= threshold` | write directly | write directly |
| `0.5 – threshold` | skip silently | collect as validation candidates |
| `< 0.5` | skip silently | skip silently |

**New function in `src/util.ts`:**
```ts
export function buildValidationRequests(ops: RouterOp[]): string | null
```

Returns a formatted string for `systemMessage`, or `null` if list is empty:

```
Memory router needs validation for the following entries.
Call request_validation for each:

1. text: "..." | status: in_progress | confidence: 0.71
2. text: "..." | status: hypothesis  | confidence: 0.63
```

**In `runHookRemember`:** after processing all ops, if `sessionType !== "headless"` and validation candidates exist, output `JSON.stringify({ systemMessage })` to stdout.

---

## Architecture

### Files changed
| File | Change |
|---|---|
| `src/hook-remember.ts` | Use `SessionDetection`, pass `agentId` + `cwd` to `processOp`, split ops into three groups, emit `systemMessage` |
| `src/util.ts` | Add `logHeadlessDecision`, `buildValidationRequests` |

### Files unchanged
`hook-recall.ts`, `router.ts`, `types.ts`, `server.ts`, `status-classifier.ts`, `qdrant.ts`

---

## Data flow

```
stdin (hook input)
  └─ detectSessionType(input, lines) → { sessionType, agentId }
       ├─ headless?  → threshold=0.85, log all decisions to .memory-headless.log
       ├─ multi_agent? → collection=memory_agents, agentId from SubagentStop
       └─ planning/editing → threshold=0.75, collection=memory

runRouter(window) → ops[]
  ├─ confidence >= threshold       → processOp() → Qdrant write
  ├─ 0.5 <= confidence < threshold → (non-headless) → validation candidates
  └─ confidence < 0.5              → silent discard

validation candidates (non-headless only)
  └─ buildValidationRequests(ops) → stdout { systemMessage }
                                     → Claude calls request_validation MCP tool
```

---

## Error handling

- `logHeadlessDecision`: wrapped in try/catch; failures write to stderr, do not throw
- `buildValidationRequests`: pure function, no I/O, no error surface
- `detectSessionType`: already handles malformed lines via `safeParseLines`; agent_id extraction is additive (falls back to `cfg.agentId`)
