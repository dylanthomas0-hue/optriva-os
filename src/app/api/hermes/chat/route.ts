import { NextResponse } from "next/server";
import { spawnStream } from "@/lib/runner";
import { hermesHome } from "@/lib/config";
import { routeIntent } from "@/lib/missionRouter";
import { createMission } from "@/lib/missionStore";
import { planMission } from "@/lib/missionPlanner";
import { existsSync, readFileSync, appendFile, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// Phase timing for every chat request → ~/.agentic-os/metrics/hermes-chat.ndjson.
// Benchmarks (2026-07-12): hermes -z has a 4–9s floor from agent init alone —
// the model round-trip through Headroom is only 1–2s and the toolset choice is
// noise. This file is how regressions (and router decisions) stay visible.
const METRICS_DIR = path.join(os.homedir(), ".agentic-os", "metrics");
function logMetric(entry: Record<string, unknown>) {
  try {
    mkdirSync(METRICS_DIR, { recursive: true });
    appendFile(path.join(METRICS_DIR, "hermes-chat.ndjson"),
      JSON.stringify({ ts: Date.now(), ...entry }) + "\n", () => {});
  } catch {}
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Strip ALL common ANSI escape sequences (CSI, OSC, simple SGR) — not just `[...m`.
// Otherwise terminal control codes can eat the reply or leave it looking empty.
const ANSI_STRIP = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\]\d+;[^\x07\x1b]*(\x07|\x1b\\)/g;

const TIMEOUT_MS = 90 * 1000; // 90s — gemini-2.5-flash on OpenRouter replies in 3–7s; 90s is plenty for multi-tool runs while failing fast on broken configs.

// ── Vault Instant Memory — Hermes always knows who Dylan is and what's happening ──
// Reads the same auto-loaded context files the Agent Room uses (Omi/Memories.md +
// About Me.md) so Hermes never has to read a file to learn basic facts. Cached in
// memory after first read — refreshes on restart.
let _vaultContext = "";
function vaultContext(): string {
  if (_vaultContext) return _vaultContext;
  const vaultRoot = "/Users/dylanthomas/Documents/Obsidian Vault";
  const parts: string[] = [];
  try {
    const omi = readFileSync(path.join(vaultRoot, "Omi", "Memories.md"), "utf8");
    parts.push("WHO DYLAN IS + WHAT'S HAPPENING (instant vault memory):\n" + omi.slice(0, 3000));
  } catch {}
  try {
    const about = readFileSync(path.join(vaultRoot, "About Me.md"), "utf8");
    const clean = about.replace(/^---[\s\S]*?---/, "").replace(/[#*>[\]]/g, "").replace(/\n{2,}/g, "\n").trim().slice(0, 800);
    if (clean) parts.push("ABOUT DYLAN:\n" + clean);
  } catch {}
  _vaultContext = parts.join("\n\n");
  return _vaultContext;
}

interface ChatMsg { role: "user" | "assistant" | "system"; text: string; }

// `hermes -z` is single-query mode — it has no memory of earlier turns, so a
// back-and-forth chat felt like talking to someone with amnesia. We give it the
// recent conversation by packing it into the prompt (same approach the Claude,
// Kimi, Free-Claude and Grok chat tabs use). Trimmed to fit the context budget.
function buildPromptWithHistory(history: ChatMsg[], current: string): string {
  if (!Array.isArray(history) || !history.length) return current;
  const recent = history.slice(-24);
  const lines: string[] = [
    "The following is the prior conversation between you and the user.",
    "Read it, then answer the user's latest message at the bottom.",
    "",
    "--- prior conversation ---",
  ];
  let bytes = 0;
  const MAX_BYTES = 8000;
  for (const m of recent) {
    if (!m || typeof m.text !== "string") continue;
    const role = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "System";
    const line = `${role}: ${m.text}`;
    if (bytes + line.length > MAX_BYTES) { lines.push("…[earlier turns trimmed]"); break; }
    lines.push(line);
    bytes += line.length;
  }
  lines.push("--- end prior conversation ---", "", `User: ${current}`, "Assistant:");
  return lines.join("\n");
}

export async function POST(req: Request) {
  const t0 = Date.now();
  const { prompt, profile, history } = await req.json();
  if (typeof prompt !== "string" || prompt.length === 0) {
    return NextResponse.json({ error: "missing prompt" }, { status: 400 });
  }
  if (prompt.length > 16_000) {
    return NextResponse.json({ error: "prompt too long" }, { status: 413 });
  }
  // Optional profile = chat as a specific Hermes employee (seo-writer, etc.).
  if (profile !== undefined && (typeof profile !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(profile))) {
    return NextResponse.json({ error: "bad profile" }, { status: 400 });
  }

  // ── Execution kernel fast path: task requests never wait for the LLM. ──
  // The code-based router (no tokens, <1ms) turns clear imperatives into
  // missions; missiond picks them up within 2s. Everything else falls through
  // to the normal Hermes chat below. Hermes plans — the kernel executes.
  const route = routeIntent(prompt);
  logMetric({ kind: "route", dispatched: !!route, capability: route?.capability ?? null, matched: route?.matched ?? null, promptBytes: prompt.length });
  if (route) {
    const cap = route.cap;
    const mission = await createMission({
      title: prompt.slice(0, 80),
      prompt,
      capability: route.capability,
      source: "chat",
      priority: cap.priority,
      tasks: planMission(route.capability, cap, prompt),
    });
    return NextResponse.json({
      ok: true,
      dispatched: true,
      missionId: mission.id,
      text: [
        `✓ Mission Created — ${route.capability}`,
        `✓ ${mission.tasks.length} task${mission.tasks.length === 1 ? "" : "s"} planned`,
        `Dispatching… track it in the Missions tab (${mission.id}).`,
      ].join("\n"),
      durationMs: Date.now() - t0,
    });
  }

  // hermes -z PROMPT  — single-query non-interactive mode.
  // --yolo + --accept-hooks are ESSENTIAL for headless/VPS runs: without them,
  // Hermes blocks on an interactive approval/hook-confirmation prompt it can't
  // display in oneshot mode, and the dashboard just sees blank output. (Matches
  // the flags Goal Mode already uses.) If the reply is STILL blank after this,
  // it's almost always auth — run `hermes status` and check the provider shows
  // a ✓ for its API key.
  // A stale/deleted profile selection (e.g. a "kimi" pill left in localStorage from an
  // earlier setup) must NOT hard-fail every message with "Profile 'kimi' does not exist" or
  // "HTTP 400: No models provided". A profile directory existing is NOT enough — Hermes needs
  // profiles/<name>/config.yaml to define a model, else `hermes -z --profile <name>` 400s.
  // Only pass --profile when that config.yaml actually exists; otherwise fall back to Hermes'
  // default active profile so the chat still works.
  const profileArgs = profile && existsSync(path.join(hermesHome(), "profiles", profile, "config.yaml"))
    ? ["--profile", profile]
    : [];
  // Pack the recent conversation in so follow-ups keep context (no more amnesia).
  // Also prepend instant vault memory so Hermes always knows who Dylan is and what
  // he's working on — no file reads needed for basic context.
  const ctx = vaultContext();
  // Hermes keeps trying to hit localhost HTTP APIs for cron/kanban actions and
  // gets blocked by its own SSRF protection — steer it to the CLI. Task-style
  // requests are dispatched by the kernel router above, so this block is now
  // short (prompt bytes cost real model latency: +0.9s per 10KB measured).
  const capabilities = [
    "--- HOW TO DO THINGS ---",
    "ALWAYS reply in English, regardless of what language feels natural.",
    "For cron/kanban actions use your terminal tool with the hermes CLI (e.g. `hermes cron run <job-id> --accept-hooks`, `hermes cron list`) — NEVER call localhost HTTP APIs (SSRF protection blocks them).",
    "Build/automation/research requests are dispatched to the mission queue automatically — if the user asks about ongoing work, point them to the Missions tab.",
    "--- end ---",
  ].join("\n");
  const fullPrompt = ctx
    ? `--- INSTANT VAULT MEMORY (you know this, don't read any file for it) ---\n${ctx}\n--- end vault memory ---\n\n${capabilities}\n\n${buildPromptWithHistory(history, prompt)}`
    : `${capabilities}\n\n${buildPromptWithHistory(history, prompt)}`;
  const promptBuildMs = Date.now() - t0;

  // ── Streaming fallthrough ──
  // Phase-0 benchmarks: hermes -z has a 4–9s floor from agent init (toolset
  // choice is noise — -t all vs -t todo differ by ~0.4s), so we keep -t all
  // for capability and fix the FEEL with streaming: an immediate status event,
  // then output chunks as they arrive, instead of 10–30s of dead air.
  // PYTHONUNBUFFERED so Python doesn't block-buffer stdout under a pipe.
  const child = spawnStream("hermes", [...profileArgs, "-z", fullPrompt, "-t", "all", "--yolo", "--accept-hooks"],
    { extraEnv: { PYTHONUNBUFFERED: "1" } });

  const encoder = new TextEncoder();
  let stdout = "";
  let stderr = "";
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (obj: Record<string, unknown>) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n")); } catch { closed = true; }
      };
      const safeClose = () => { if (!closed) { closed = true; try { controller.close(); } catch {} } };

      send({ type: "status", text: "Hermes is thinking…" });
      const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, TIMEOUT_MS);

      child.stdout.on("data", (b: Buffer) => {
        const clean = b.toString().replace(ANSI_STRIP, "");
        stdout += clean;
        if (clean) send({ type: "delta", text: clean });
      });
      child.stderr.on("data", (b: Buffer) => { stderr += b.toString().replace(ANSI_STRIP, ""); });
      child.on("close", (code) => {
        clearTimeout(killer);
        const totalMs = Date.now() - t0;
        logMetric({ kind: "chat", promptBuildMs, runMs: totalMs - promptBuildMs, totalMs, promptBytes: fullPrompt.length, exitCode: code });
        const text = stdout.trim();
        if (!text) {
          // Same diagnostics the old JSON path had — common failures get a fix hint.
          const timedOut = totalMs >= TIMEOUT_MS - 2_000;
          const lines = [timedOut
            ? `Hermes timed out after ${(totalMs / 1000).toFixed(1)}s. Your provider may be slow or unreachable. Try: hermes status`
            : `Hermes finished in ${(totalMs / 1000).toFixed(1)}s with exit ${code} but no response.`];
          const known: Record<string, string> = {
            "No models provided": "Hermes couldn't find a valid model. Check ~/.hermes/config.yaml → model & provider. Run hermes status.",
            "401": "API key rejected. Run hermes login or check ~/.hermes/.env for the provider key.",
            "400": "Bad request — likely a model/provider mismatch. Run hermes status.",
            "timeout": "The model took too long. Provider may be overloaded.",
          };
          const s = stderr.toLowerCase();
          for (const [k, fix] of Object.entries(known)) if (s.includes(k.toLowerCase())) { lines.push(`Fix: ${fix}`); break; }
          if (stderr.trim()) lines.push("", "─── stderr ───", stderr.trim().slice(-2000));
          else lines.push("", "Blank output with no error is almost always auth/provider config — run `hermes status`, then `hermes doctor`.");
          send({ type: "result", text: lines.join("\n"), empty: true });
        }
        send({ type: "done", code, durationMs: totalMs });
        safeClose();
      });
      child.on("error", (e) => {
        clearTimeout(killer);
        send({ type: "result", text: `Hermes failed to start: ${String(e)}`, empty: true });
        send({ type: "done", code: -1 });
        safeClose();
      });
    },
    cancel() { try { child.kill("SIGTERM"); } catch {} },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
