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

import type { FastifyInstance } from "fastify";
import { getProjectId } from "../config.js";
import { qd, colName } from "../qdrant.js";
import { runArchivist } from "../archivist.js";
import { runRouter, type RouterOp } from "../router.js";
import {
  buildTranscriptContext,
  buildValidationRequests,
  nowIso,
  debugLog,
  storeMemory,
} from "../util.js";
import { record } from "./dashboard.js";

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
  hookType: "recall" | "remember",
  sessionId: string,
  projectId: string,
  extraPayload: Record<string, unknown> = {},
): Promise<void> {
  const id         = crypto.randomUUID();
  const now        = nowIso();
  const expiresAt  = new Date(Date.now() + HOOK_CALL_TTL_DAYS * 86_400_000).toISOString();

  await qd.upsert(colName("hook_calls"), {
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
    process.stderr.write(`[hooks] hook_calls upsert failed: ${String(err)}\n`);
  });
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function hooksPlugin(fastify: FastifyInstance): Promise<void> {

  // ── POST /hooks/recall ───────────────────────────────────────────────────────

  fastify.post<{ Body: HookBody }>("/hooks/recall", async (req, reply) => {
    const t0        = Date.now();
    const body      = req.body ?? {} as HookBody;
    const bytesIn   = JSON.stringify(body).length;
    const projectId = getProjectId();

    const prompt          = (body.prompt ?? "").trim();
    const transcriptPath  = body.transcript_path ?? "";
    const sessionId       = body.session_id ?? "unknown";

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

      const ms       = Date.now() - t0;
      const bytesOut = JSON.stringify({ systemMessage }).length;
      record("hooks/recall", "hook", bytesIn, bytesOut, ms, true);

      await persistHookCall("recall", sessionId, projectId, {
        prompt_chars: prompt.length,
        result_chars: systemMessage.length,
      });

      return reply.send({ systemMessage });
    } catch (err: unknown) {
      const ms = Date.now() - t0;
      record("hooks/recall", "hook", bytesIn, 0, ms, false, String(err));
      debugLog("hooks/recall", `error: ${String(err)}`);
      return reply.code(500).send({ error: String(err) });
    }
  });

  // ── POST /hooks/remember ─────────────────────────────────────────────────────

  fastify.post<{ Body: HookBody }>("/hooks/remember", async (req, reply) => {
    const t0        = Date.now();
    const body      = req.body ?? {} as HookBody;
    const bytesIn   = JSON.stringify(body).length;
    const projectId = getProjectId();

    const transcriptPath  = body.transcript_path ?? "";
    const sessionId       = body.session_id       ?? "unknown";

    debugLog("hooks/remember", `session=${sessionId} transcript="${transcriptPath}"`);

    let systemMessage = "";

    try {
      const window = buildTranscriptContext(transcriptPath, 8_000);
      if (!window.trim()) {
        const ms = Date.now() - t0;
        record("hooks/remember", "hook", bytesIn, 2, ms, true);
        return reply.send({ systemMessage: "" });
      }

      const ops: RouterOp[] = await runRouter(window);
      debugLog("hooks/remember", `router ops=${ops.length}`);

      const directOps:     RouterOp[] = [];
      const validationOps: RouterOp[] = [];

      for (const op of ops) {
        if (op.confidence >= CONFIDENCE_THRESH) {
          directOps.push(op);
        } else if (op.confidence >= VALIDATION_MIN_CONF) {
          validationOps.push(op);
        }
      }

      // Store high-confidence ops as memories
      for (const op of directOps) {
        await storeMemory({
          content:    op.text,
          memoryType: "episodic",
          scope:      "project",
          tags:       "",
          importance: op.confidence,
          ttlHours:   0,
        }).catch((err: unknown) => {
          process.stderr.write(`[hooks/remember] storeMemory failed: ${String(err)}\n`);
        });
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
}
