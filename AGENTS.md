<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Execution Kernel (missions)

Hermes plans, the kernel executes. Task-style chat messages are routed (no LLM,
`src/lib/missionRouter.ts`) into missions in `~/.agentic-os/missions/` (one JSON
+ one .log per mission; events in `~/.agentic-os/events.ndjson`). The launchd
daemon **ai.agentos.missiond** (`scripts/mission-dispatcher.mjs`) runs each task:
Scheduler.approve → executor plugin → verifier plugin. Never trust an executor's
exit code — only verifier checks mark a task `verified`.

- Departments are data: `~/.agentic-os/capabilities.json` (match keywords,
  planner/verifier plugin names, executor kind, scheduler pool, budget caps).
- Planners: `src/lib/planners/*.ts` (+ one line in `src/lib/missionPlanner.ts`).
- Executors/verifiers for the daemon: `scripts/kernel/*.mjs` (plain node —
  launchd can't run TS; the TS side and daemon share file formats, not code).
- UI: /missions tab (SSE live board, evidence, log tail, replay).
- After changing kernel TS: `npm run build` + `launchctl kickstart -k
  gui/$UID/ai.agentos.dashboard`. After changing scripts/kernel: `launchctl
  kickstart -k gui/$UID/ai.agentos.missiond`.
