/**
 * hooks.ts — HTTP endpoints for Claude Code hooks.
 *
 * POST /hooks/recall   — runs the archivist, returns { systemMessage }
 * POST /hooks/remember — runs the memory router, stores memories, returns { systemMessage }
 *
 * Both endpoints:
 *   - persist a hook_calls entry in Qdrant (payload-only, vector=[0], TTL 7 days)
 *   - call record() for dashboard visibility
 */

import { FastifyInstance } from "fastify";
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { getProjectId } from "../config.js";
import { qd, colName } from "../qdrant.js";
import { runArchivist } from "../archivist.js";
import { runRouter, type RouterOp } from "../router.js";
import { runWithContext } from "../request-context.js";
import {
  buildTranscriptContext,
  buildValidationRequests,
  nowIso,
  debugLog,
  storeMemory,
  safeParseLines,
  type JsonLine,
} from "../util.js";
import { record, recordAgentDisconnect } from "./dashboard.js";
import { setSession }            from "../session-store.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const CONTEXT_CHARS       = 2_000;
const HOOK_CALL_TTL_DAYS  = 7;
const VALIDATION_MIN_CONF = 0.5;
const CONFIDENCE_THRESH   = 0.75; // default confidence for HTTP hook requests

// ── Types ─────────────────────────────────────────────────────────────────────

interface HookBody {
  session_id:        string;
  transcript_path:   string;
  cwd:               string;
  hook_event_name?:  string;
  prompt?:           string;
  stop_hook_active?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function persistHookCall(
  hookType: "recall" | "remember" | "session-end",
  sessionId: string,
  projectId: string,
  extraPayload: Record<string, unknown> = {},
): Promise<void> {
  const id         = crypto.randomUUID();
  const now        = nowIso();
  const expiresAt  = new Date(Date.now() + HOOK_CALL_TTL_DAYS * 86_400_000).toISOString();

  await qd.upsert(colName("request_logs"), {
    points: [{
      id,
      vector: [0],
      payload: {
        hook_type:  hookType,
        session_id: sessionId,
        project_id: projectId,
        created_at: now,
        expires_at: expiresAt,
        ...extraPayload,
      },
    }],
  }).catch((err: unknown) => {
    process.stderr.write(`[hooks] request_logs upsert failed: ${String(err)}\n`);
  });
}

type SessionType = "headless" | "multi-agent" | "editing" | "planning";

interface SessionDetection {
  type: SessionType;
  threshold: number;
}

function detectSessionType(body: HookBody, lines: JsonLine[]): SessionDetection {
  if (body.stop_hook_active) {
    return { type: "headless", threshold: 0.85 };
  }

  // Check for multi-agent
  for (const line of lines) {
    if (line["type"] === "SubagentStop") {
      const agentId = String(line["agent_id"] ?? line["subagent_id"] ?? "");
      if (agentId) {
        return { type: "multi-agent", threshold: 0.80 };
      }
    }
  }

  // Check for editing
  const editTools = [
    "replace",
    "write_file",
    "edit_file",
    "patch_file",
    "insert_text",
    "run_shell_command",
  ];
  for (const line of lines) {
    const role = String(line["role"] ?? line["type"] ?? "");
    if (role === "tool_use" || role === "tool_call") {
      const name = String(
        line["name"] ?? (line["functionCall"] as JsonLine)?.["name"] ?? "",
      );
      if (editTools.includes(name)) {
        return { type: "editing", threshold: 0.75 };
      }
    }
    const content = line["content"];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block["type"] === "tool_use" && editTools.includes(block["name"])) {
          return { type: "editing", threshold: 0.75 };
        }
      }
    }
  }

  return { type: "planning", threshold: 0.75 };
}

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

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function hooksPlugin(fastify: FastifyInstance): Promise<void> {

  // ── POST /hooks/recall ───────────────────────────────────────────────────────

  fastify.post<{ Body: HookBody; Querystring: { project_dir?: string } }>("/hooks/recall", async (req, reply) => {
    const t0        = Date.now();
    const body      = req.body ?? {} as HookBody;
    const bytesIn   = JSON.stringify(body).length;
    const projectId = req.query.project_dir ? basename(req.query.project_dir) : "default";

    const prompt          = (body.prompt ?? "").trim();
    const transcriptPath  = body.transcript_path ?? "";
    const sessionId       = body.session_id ?? "unknown";

    return runWithContext({ projectId }, async () => {
      debugLog("hooks/recall", `session=${sessionId} prompt="${prompt.slice(0, 80)}"`);

      let systemMessage = "";

      try {
        if (prompt) {
          const transcriptCtx = buildTranscriptContext(transcriptPath, CONTEXT_CHARS);
          const archivistInput = transcriptCtx
            ? `${transcriptCtx}\n\nCurrent message: ${prompt}`
            : prompt;

          systemMessage = await runArchivist(archivistInput);
        }

        // UserPromptSubmit: inject archivist output via hookSpecificOutput.additionalContext
        // so it actually lands in the model's context. The top-level `systemMessage` field
        // is a UI-only message (shown to the user, not the model) per Claude Code hook spec.
        const contextWithHeader = systemMessage
          ? `[local-rag memory context]\n${systemMessage}\n[/local-rag memory context]`
          : "";
        const response = {
          hookSpecificOutput: {
            hookEventName:     "UserPromptSubmit" as const,
            additionalContext: contextWithHeader,
          },
        };

        const ms       = Date.now() - t0;
        const bytesOut = JSON.stringify(response).length;
        record("hooks/recall", "hook", bytesIn, bytesOut, ms, true);

        await persistHookCall("recall", sessionId, projectId, {
          prompt_chars: prompt.length,
          result_chars: systemMessage.length,
        });

        return reply.send(response);
      } catch (err: unknown) {
        const ms = Date.now() - t0;
        record("hooks/recall", "hook", bytesIn, 0, ms, false, String(err));
        debugLog("hooks/recall", `error: ${String(err)}`);
        return reply.code(500).send({ error: String(err) });
      }
    });
  });

  // ── POST /hooks/remember ─────────────────────────────────────────────────────

  fastify.post<{ Body: HookBody; Querystring: { project_dir?: string } }>("/hooks/remember", async (req, reply) => {
    const t0        = Date.now();
    const body      = req.body ?? {} as HookBody;
    const bytesIn   = JSON.stringify(body).length;
    const projectId = req.query.project_dir ? basename(req.query.project_dir) : "default";

    const transcriptPath  = body.transcript_path ?? "";
    const sessionId       = body.session_id       ?? "unknown";

    // Detect session type
    const raw = (transcriptPath && existsSync(transcriptPath))
      ? readFileSync(transcriptPath, "utf8")
      : "";
    const lines = safeParseLines(raw);
    const { type: sessionType, threshold } = detectSessionType(body, lines);

    return runWithContext({ projectId }, async () => {
      debugLog("hooks/remember", `session=${sessionId} type=${sessionType} transcript="${transcriptPath}"`);

      let systemMessage = "";

      try {
        const window = buildTranscriptContext(transcriptPath, 8_000);
        if (!window.trim()) {
          const ms = Date.now() - t0;
          record("hooks/remember", "hook", bytesIn, 2, ms, true);
          return reply.send({ systemMessage: "" });
        }

        const ops: RouterOp[] = await runRouter(window);
        debugLog("hooks/remember", `router ops=${ops.length} (threshold=${threshold})`);

        const directOps:     RouterOp[] = [];
        const validationOps: RouterOp[] = [];

        for (const op of ops) {
          if (op.confidence >= threshold) {
            directOps.push(op);
            debugLog("hooks/remember", `op band=direct conf=${op.confidence.toFixed(2)} text="${op.text.slice(0, 100)}"`);
          } else if (op.confidence >= VALIDATION_MIN_CONF) {
            validationOps.push(op);
            debugLog("hooks/remember", `op band=validation conf=${op.confidence.toFixed(2)} text="${op.text.slice(0, 100)}"`);
          } else {
            debugLog("hooks/remember", `op band=skip conf=${op.confidence.toFixed(2)} text="${op.text.slice(0, 100)}"`);
          }
        }

        const memType = sessionType === "multi-agent" ? "memory_agents" : "memory";

        for (const op of directOps) {
          const result = await storeMemory({
            content:    op.text,
            status:     op.status,
            memoryType: memType,
            scope:      "project",
            tags:       "",
            importance: op.confidence,
            ttlHours:   0,
            sessionId:  sessionId,
            sessionType: sessionType,
          });
          debugLog("hooks/remember", `op written [${memType}] status=${op.status} conf=${op.confidence.toFixed(2)} result=${result}`);
        }

        const validationMsg = buildValidationRequests(validationOps);
        if (validationMsg) {
          systemMessage = validationMsg;
        }

        const ms       = Date.now() - t0;
        const bytesOut = JSON.stringify({ systemMessage }).length;
        record("hooks/remember", "hook", bytesIn, bytesOut, ms, true);

        await persistHookCall("remember", sessionId, projectId, {
          ops_total:      ops.length,
          ops_direct:     directOps.length,
          ops_validation: validationOps.length,
        });

        return reply.send({ systemMessage });
      } catch (err: unknown) {
        const ms = Date.now() - t0;
        record("hooks/remember", "hook", bytesIn, 0, ms, false, String(err));
        debugLog("hooks/remember", `error: ${String(err)}`);
        return reply.code(500).send({ error: String(err) });
      }
    });
  });

  // ── POST /hooks/session-end ──────────────────────────────────────────────────

  fastify.post<{ Body: HookBody; Querystring: { project_dir?: string } }>("/hooks/session-end", async (req, reply) => {
    const t0        = Date.now();
    const body      = req.body ?? {} as HookBody;
    const bytesIn   = JSON.stringify(body).length;
    const projectId = req.query.project_dir ? basename(req.query.project_dir) : "default";

    const sessionId = body.session_id ?? "unknown";

    return runWithContext({ projectId }, async () => {
      debugLog("hooks/session-end", `session=${sessionId}`);

      // Store session_id so give_feedback tool can use it as fallback
      setSession(projectId, sessionId);

      // Clear agent connection status on dashboard
      recordAgentDisconnect(projectId);

      const systemMessage = buildSessionEndMessage(sessionId);

      const ms       = Date.now() - t0;
      const bytesOut = JSON.stringify({ systemMessage }).length;
      record("hooks/session-end", "hook", bytesIn, bytesOut, ms, true);

      await persistHookCall("session-end", sessionId, projectId, {
        hook_event: body.hook_event_name ?? "SessionEnd",
      });

      return reply.send({ systemMessage });
    });
  });
}
