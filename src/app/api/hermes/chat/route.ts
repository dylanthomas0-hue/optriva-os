import { NextResponse } from "next/server";
import { run } from "@/lib/runner";
import { hermesHome } from "@/lib/config";
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
  // gets blocked by its own SSRF protection. It already has the terminal tool
  // (-t all) — steer it to the CLI, which works in oneshot mode.
  const capabilities = [
    "--- HOW TO DO THINGS (capabilities) ---",
    "ALWAYS reply in English, regardless of what language feels natural.",
    "Cron jobs: use your terminal tool with the hermes CLI — NEVER call localhost/127.0.0.1 HTTP APIs (SSRF protection blocks them and it will fail).",
    "  • Run a job now:  hermes cron run <job-id> --accept-hooks",
    "  • List jobs:      hermes cron list",
    "After triggering a job, tell the user it's running; output lands in ~/.hermes/cron/output/<job-id>/.",
    "--- end capabilities ---",
  ].join("\n");
  const fullPrompt = ctx
    ? `--- INSTANT VAULT MEMORY (you know this, don't read any file for it) ---\n${ctx}\n--- end vault memory ---\n\n${capabilities}\n\n${buildPromptWithHistory(history, prompt)}`
    : `${capabilities}\n\n${buildPromptWithHistory(history, prompt)}`;
  // -t all gives Hermes every tool (cron, kanban, file, web, terminal, browser, etc.)
  // Without it, oneshot mode loads a limited subset and can't manage crons or kanban.
  const promptBuildMs = Date.now() - t0;
  const out = await run("hermes", [...profileArgs, "-z", fullPrompt, "-t", "all", "--yolo", "--accept-hooks"], { timeoutMs: TIMEOUT_MS });
  logMetric({ kind: "chat", promptBuildMs, runMs: out.durationMs,
    totalMs: Date.now() - t0, promptBytes: fullPrompt.length, exitCode: out.code });

  const text = out.stdout.replace(ANSI_STRIP, "").trim();
  const stderrClean = out.stderr.replace(ANSI_STRIP, "").trim();

  // If Hermes produced no usable text, build a diagnostic reply instead of returning the opaque "(no response)".
  let diagnostic: string | null = null;
  if (!text) {
    const seconds = (out.durationMs / 1000).toFixed(1);
    const probableTimeout = out.durationMs >= TIMEOUT_MS - 2_000;
    const lines: string[] = [];
    lines.push(probableTimeout
      ? `Hermes timed out after ${seconds}s. Your provider (${process.env.OPENROUTER_API_KEY ? "OpenRouter" : "custom"}) may be slow or unreachable. Try: hermes status`
      : `Hermes finished in ${seconds}s with exit ${out.code} but no response.`);
    if (stderrClean) {
      // Surface the most actionable line first — common errors have known fixes.
      const known: Record<string, string> = {
        "No models provided": "Hermes couldn't find a valid model. Check ~/.hermes/config.yaml → model & provider. Run hermes status.",
        "401": "API key rejected. Run hermes login or check ~/.hermes/.env for your OPENROUTER_API_KEY.",
        "400": "Bad request — likely a model/provider mismatch. Run hermes status to see what model is configured.",
        "timeout": "The model took too long to respond. Your provider may be overloaded or the model is too slow for agent use.",
      };
      for (const [key, fix] of Object.entries(known)) {
        if (stderrClean.toLowerCase().includes(key.toLowerCase())) { lines.push(`Fix: ${fix}`); break; }
      }
      lines.push("");
      lines.push("─── stderr ───");
      lines.push(stderrClean.length > 4000 ? stderrClean.slice(-4000) : stderrClean);
    } else {
      lines.push("");
      lines.push("Blank output with no error is almost always auth or provider config:");
      lines.push("  1. Run `hermes status` — does your provider show a ✓ next to its API key?");
      lines.push("  2. If ✗, run `hermes login` (or set the key in ~/.hermes/.env) for that provider.");
      lines.push("  3. Check the Model + Provider lines in `hermes status` are a real, supported combo.");
      lines.push("  4. Then `hermes doctor` for a full config check.");
    }
    diagnostic = lines.join("\n");
  }

  return NextResponse.json({
    ok: out.ok && !!text,
    text: text || diagnostic || "(no response)",
    empty: !text,
    durationMs: out.durationMs,
    phases: { promptBuildMs, runMs: out.durationMs, totalMs: Date.now() - t0 },
    exitCode: out.code,
    timedOut: !text && out.durationMs >= TIMEOUT_MS - 2_000,
    stderr: stderrClean, // full, no trunc — useful for diagnosing
  });
}
