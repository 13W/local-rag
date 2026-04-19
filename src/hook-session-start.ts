const SESSION_START_MESSAGE = `Memory system active (local-rag). See MCP server instructions for the full protocol.`;

export async function runHookSessionStart(): Promise<void> {
  // Read stdin (Claude Code sends hook body) but we don't need it — just inject the static message.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);

  // Use hookSpecificOutput.additionalContext — that's the field Claude Code injects into
  // the model's context for SessionStart. The top-level `systemMessage` is a UI-only banner
  // (shown to the user) and is *not* seen by the model — which is why prior session-start
  // messages appeared to be ignored by the agent.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName:     "SessionStart",
      additionalContext: SESSION_START_MESSAGE,
    },
  }));
}
