# Optriva OS

**An execution kernel for AI agents — not another chatbot.**

Optriva OS is the internal platform that runs [Optriva](https://optriva.co.uk), an AI-automation business. It started as a dashboard for chatting with a few CLI agents and grew into a real operating system for autonomous work: a sub-2ms intent router, a data-driven capability registry, a scheduler with concurrency and budget caps, and — the part that actually matters — a verification layer that never trusts an agent's word.

> **The core idea:** an AI agent claiming "done" is worth nothing. Only independent, evidence-based verification — a git commit that actually moved, a build that actually compiles, a live API response that actually came back — earns the label "verified." Every layer described below is built around that one rule.

---

## Why this exists

Most "AI agent" projects stop at "the agent said it worked." That's not good enough to run a real business on. Agents fail in ways that look identical to success from the outside: they can exit 0 having done nothing, get stuck in a dead loop calling a tool that doesn't exist, or have their process silently killed by an unrelated network timeout mid-task with no error surfaced anywhere. Every one of those has actually happened while building this system.

So the architecture is built backwards from that failure mode: **assume every agent claim is unverified until proven otherwise**, and design every layer — routing, dispatch, execution, verification — to make that provable, not just plausible.

---

## Architecture

```
Chat message
     │
     ▼
┌─────────────────────┐   Code-based router. No LLM call. Requires an
│  Hermes intent       │   imperative verb + a real capability match +
│  router (<2ms)        │   a confidence score above threshold — a bare
└─────────┬────────────┘   noun match ("website" mentioned anywhere) is
          │                 NOT enough; below threshold → normal chat.
          ▼
┌─────────────────────┐
│  Mission Store        │   One JSON file + one log per mission.
│  (task graph)         │   Dependency-aware: tasks run in parallel
└─────────┬────────────┘   once their deps are verified.
          │
          ▼
┌─────────────────────┐   Data, not code. Adding a department is one
│  Capability Registry  │   JSON entry (match keywords, executor kind,
│  (JSON, hot-reload)   │   verifier, scheduler pool, feature flag).
└─────────┬────────────┘
          │
          ▼
┌─────────────────────┐   Concurrency caps per pool, daily budget caps,
│  Scheduler            │   free-memory / load-average gates. Every
└─────────┬────────────┘   "wait" emits a reason — always answerable.
          │
          ▼
┌─────────────────────┐
│  Executor plugin      │   shell / hermes-cron / hermes-oneshot /
│  (does the real work) │   openclaw / n8n / scrapling / …
└─────────┬────────────┘
          │
          ▼
┌─────────────────────┐   THE part that matters. Exit code 0 means
│  Verifier plugin      │   nothing on its own. Checks real evidence:
│  (proves it happened) │   git HEAD actually moved, build artifact
└─────────┬────────────┘   actually exists, API actually responds.
          │
    verified / rejected / retry / escalate
```

Every state transition is an event on an append-only bus (`~/.agentic-os/events.ndjson`), which drives a live SSE-powered Missions dashboard — task graph, verifier evidence, log tail, and a full event-replay timeline for stepping through exactly what happened and why, after the fact.

### 1. The intent router — deciding what's actually a task

The router (`missionRouter.ts`) never calls a model. It runs three checks, in order, and any failure falls through to normal conversational chat:

1. **Imperative-verb gate.** The message must start with (or immediately follow a greeting with) a real action verb — `build`, `fix`, `research`, `redesign`, etc. "How do I build a website?" fails this gate immediately; it's a question, not a task.
2. **Capability match.** The registry's keyword list is scanned, but a match alone isn't enough.
3. **Confidence score.** Every match is scored as `proximity × 0.7 + specificity × 0.3` — proximity to the verb (a keyword right after "build" scores high; one buried forty words into an unrelated sentence scores near zero), specificity being keyword length (a five-word phrase is a stronger signal than a bare noun). Only the highest-scoring capability above a fixed threshold gets dispatched.

This exists because of a real, observed failure mode: a research request — *"research local businesses that might need a better website"* — matched the `website` capability's keyword `"website"` under plain substring matching and silently hijacked the entire site-build pipeline instead of doing research. The fix wasn't a blocklist; it was replacing "does this string appear anywhere" with "is this actually what the sentence is about."

### 2. The capability registry — departments as data

`~/.agentic-os/capabilities.json` is the single source of truth for what the system can do. Each entry is a plain object:

```json
"website-redesign": {
  "match": ["redesign the website", "improve the website", "..."],
  "executor": { "kind": "shell", "script": "~/.hermes/scripts/website-redesign.sh" },
  "verifier": "website-redesign",
  "schedulerPool": "hermes",
  "timeoutMs": 2700000
}
```

Adding a new department — a new kind of work the system can do — is editing this file plus writing one verifier plugin. No router code changes, no dispatcher code changes. A capability can also carry `"enabled": false`, which the router treats as if the entry doesn't exist at all — the mechanism used to keep an unreliable executor (see OpenClaw, below) completely out of the routing path until it's proven itself.

### 3. The scheduler — a real admission gate, not just a queue

Before any task executes, the scheduler checks per-pool concurrency limits, a daily budget cap per executor kind, and system load/free-memory. If a task can't run yet, it doesn't error — it gets a `wait` state with a reason attached, so "why isn't this running" is always answerable from the dashboard rather than a silent stall.

### 4. Executors — plugins, not `if` chains

An executor's only job is to spawn the actual work and hand back a process — a shell script, a `hermes -z` one-shot call, a POST to the OpenClaw gateway, an n8n template import, a Scrapling scrape. It has no opinion on whether the work succeeded. That's deliberate: an executor's exit code is treated as informational, never authoritative.

### 5. Verifiers — the part that actually matters

Every capability names a verifier plugin, and a task is only ever marked `verified` if that plugin's independent check passes. Concretely, for the website-redesign capability:

```js
"website-redesign"(task, ctx) {
  // 1. Did a REDESIGN_ID actually appear in the output? (not just "exit 0")
  // 2. Did that worktree's git HEAD actually move since its own before-snapshot?
  // 3. Does the rebuilt bundle actually exist on disk?
  // 4. Does the build log actually show zero compile errors?
  // Only if all four hold does this return { verdict: "verified", evidence: [...] }
}
```

Four independent checks, not one agent's summary of what it did. A `rejected` verdict triggers a retry with a fresh attempt budget; repeated failure escalates to a human rather than looping forever.

---

## The website redesign pipeline — isolate blast radius, then require a human click

Real changes to the production site never touch the main working tree directly. The flow:

1. A request ("redesign the website: …") is routed to the `website-redesign` capability.
2. The executor script creates a **disposable git worktree and branch** (`~/.agentic-os/site-redesign/<id>`, branch `redesign/<id>`) off the current `HEAD` of the real site repo.
3. An agent (GLM 5.2) makes the actual change *inside that isolated worktree only* — it can never see or touch the main working tree.
4. The worktree is rebuilt independently; the verifier checks the four conditions above against that specific worktree.
5. If verified, the Missions dashboard shows a **live preview** (served directly from that worktree's build output) plus two buttons: **Approve & Deploy** (merges the branch into the real repo and runs the production deploy script) and **Discard** (deletes the worktree and branch — zero trace left on the live repo).

Nothing reaches the live site without an explicit human click on a verified, previewable result. A rejected or discarded attempt costs nothing beyond the disk space of an isolated folder.

---

## The Agent Room — a real multi-model conversation, not a single model role-playing

Several actual, independently-hosted models — not one model prompted to "pretend" to be different personalities — hold a shared conversation, each seeing what the others said before it replies. Any participant can end its turn with a `BUILD::` directive containing a full build spec; that text is parsed out of the chat and fired at the real build backend, with the resulting preview posted back into the same conversation. A "only one build per round" guard stops every participant from racing to commission the same thing.

**A real bug this surfaced:** a commissioned build was dying silently, ~5 minutes in, with zero output and no error visible anywhere in the chat. Root-cause tracing (reading the actual session transcript and process state rather than trusting the "still building…" chat messages) found that the code reading the build's live output used `fetch()`, whose underlying HTTP client kills a connection after roughly five minutes of no new bytes by default — and the model genuinely does go quiet that long mid-tool-loop. The client's own timeout was killing a real, working build. The fix was switching that one code path to a plain HTTP client with no such default, so the server's own explicit 12-minute hard cap became the only timeout that mattered.

---

## OpenClaw — proven in, not trusted by default

OpenClaw (a general-purpose autonomous agent gateway) is wired in as an executor, but ships **feature-flagged off** in the capability registry until it demonstrates reliability. It was disabled after a real incident: a research task hung for 8+ minutes, tracing through the session's tool-call history revealed it wasn't a network hang at all — the model had gone into a loop calling `headroom_retrieve`, a tool that doesn't exist, over and over, because its `web_search` tool was silently misconfigured (no provider set) and fell back to a dead end with no self-correction. The fix was at the actual root cause — properly configuring the search provider at the tool-config layer — not a workaround. Re-enabling it required three consecutive, independently verified clean runs before the flag flipped back to `true`.

---

## Other real, working pieces

- **n8n workflow automation** — imports real templates from n8n's public API and sanitizes them against an explicit allow-list of fields n8n's own schema actually accepts (marketplace exports carry extra fields — `cid`, `creator` — that n8n's create-workflow API rejects outright), rather than asking a model to author node/connection JSON from scratch.
- **Self-hosted web scraping (Scrapling)** — tries a plain HTTP fetch first, escalates to a real headless-stealth browser only if the page looks blocked or empty. Most scrapes never pay the cost of a browser.
- **Website Factory** — a real multi-stage local-business outreach pipeline: scout → score existing site quality → sort into industry lists → build a demo → draft outreach copy → **explicit human review gate** before anything is ever sent. Nothing auto-sends.
- **Production integrations** — live Stripe Checkout + webhooks; Microsoft 365 via real OAuth2 IMAP+SMTP (not a mock mailer — this involved diagnosing and fixing Entra app-registration scopes, tenant SMTP-AUTH policy, and stale OAuth tokens as genuinely separate failure points); Cloudflare DNS/DKIM management via API; Vapi voice AI with real assistant IDs on the live site.
- **Shared memory** — an Obsidian vault that agents read from and write to as persistent state, not just a human notebook.
- **Creative studio suite** — video, image/thumbnail, and music generation, plus a small game studio, sitting alongside the business tooling in the same dashboard.

---

## Tech stack

**Frontend/dashboard:** Next.js 16 (App Router), React 19, TypeScript, Tailwind, Framer Motion, Server-Sent Events for live updates.
**Kernel/daemon:** Plain Node.js, no framework — a `launchd`-managed dispatcher that has to keep running independently of the dashboard process.
**Agents/models:** Claude, GLM 5.2 (self-hosted proxy), and OpenRouter-routed Gemini/Llama/GPT for the multi-model Agent Room.
**Integrations:** Stripe, Microsoft Graph/Exchange Online (OAuth2), Cloudflare API, n8n API, Vapi, Apollo/Hunter/Firecrawl.
**Infra:** Docker Compose on a VPS, an idempotent rsync-based deploy pipeline, real DNS/DKIM record management.
**Storage:** flat JSON + an append-only event log for kernel state (auditable, no database dependency for mission tracking); an Obsidian vault as shared markdown-based memory.

---

## Licence

Personal project — feel free to read the code and borrow ideas. Not intended for redistribution as a packaged product.
