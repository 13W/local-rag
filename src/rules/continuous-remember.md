# Continuous remember() — Mandatory Knowledge Capture

## Rule

Call `remember()` **immediately** every time you resolve an uncertainty, fix a problem, or discover something non-obvious. Do NOT batch remember calls — store knowledge the moment you gain it.

## Trigger Events (call remember() right after each)

- **Type error fixed** — record the root cause and the fix
- **Test failure diagnosed** — record what broke and why
- **Mock/stub pattern discovered** — record the correct usage pattern
- **API/method signature clarified** — record the actual signature and constraints
- **Build/tooling command learned** — record the exact command (e.g., `pnpm run build` or `make test`)
- **Runtime behavior surprise** — record what you expected vs what happened
- **Workaround applied** — record why the direct approach failed and what worked
- **Configuration/setup requirement found** — record the required setup steps
- **Code pattern that requires specific structure** — record the pattern with example
- **Error message decoded** — record what the error actually means and how to fix it

## Format

Each `remember()` call must be:
- **One fact per call** — never combine multiple findings
- **Actionable** — another agent reading this should know what to do
- **Tagged precisely** — use composable tags from the tagging convention (e.g., `test,mock,pattern`)
- **Appropriately typed** — `episodic` for bugs/events, `procedural` for patterns, `semantic` for facts
- **Importance-rated** — 0.6+ for things that cost you time to figure out

## Examples

```
# After fixing a type error in mock functions:
remember(
  content="createMockFn in libs/framework expects (...args: unknown[]) => unknown for the fn parameter. Using typed params like (action: string) causes TS2345. Always use (...args: unknown[]) and cast inside.",
  memory_type="procedural",
  tags="test,mock,typescript,pattern",
  importance=0.7
)

# After discovering a method's internal structure:
remember(
  content="UserService.findById() always calls normalizeUser() before returning — any test that expects raw DB shape will fail. Always assert on the normalized shape.",
  memory_type="procedural",
  tags="test,user,mock,pattern",
  importance=0.8
)

# After learning a tooling command:
remember(
  content="This project uses pnpm workspaces. Run scripts with: pnpm --filter <package-name> <script>. Example: pnpm --filter api run build",
  memory_type="semantic",
  tags="tooling,pnpm,build",
  importance=0.8
)
```

## Anti-patterns

- Waiting until the end of a task to remember everything at once — knowledge gets lost or summarized poorly
- Remembering only the final outcome but not the intermediate discoveries
- Skipping remember() for "small" findings — small findings are often the ones that waste the most time when rediscovered
- Combining multiple facts into one remember() call — makes retrieval less precise
