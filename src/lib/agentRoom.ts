// Agent Room — a live group chat where each agent is its OWN real model + persona.
// Cloud agents run through the shared OpenRouter key (from the active Hermes
// profile); Free Claude Code runs locally on Ollama ($0). A round is sequential:
// each agent sees what was said before it, so they actually talk to each other.

import { readFileSync, existsSync } from "node:fs";
import { writeFile, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { searchNotes, recentNotes, searchOmi, readNote, VAULT_AVAILABLE } from "@/lib/vault";
import { AGENTIC_DIR } from "@/lib/vaultWriter";
import { uniqueSlug, writeItem, type PipelineItem } from "@/lib/pipeline";
import { config, hermesHome } from "@/lib/config";
import { run } from "@/lib/runner";

const HOME = os.homedir();
const OLLAMA = process.env.OLLAMA_HOST || "http://localhost:11434";

// ── Durable group-chat history — saved to the vault so it survives browser clears
// and shows on any device (localStorage in the browser is only a fast cache). ──
const CONVOS_DIR = AGENTIC_DIR ? path.join(AGENTIC_DIR, "Agent Room", "conversations") : "";
export interface RoomMsg { key: number; who: string; name?: string; color?: string; text: string; kind?: string }
export interface RoomConvo { id: string; title: string; ts: number; msgs: RoomMsg[] }
const safeConvoId = (id: string) => String(id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);

export async function saveConversation(convo: RoomConvo): Promise<boolean> {
  if (!CONVOS_DIR) return false;
  const id = safeConvoId(convo?.id || "");
  if (!id || !Array.isArray(convo.msgs) || convo.msgs.length === 0) return false;
  try {
    if (!existsSync(CONVOS_DIR)) await mkdir(CONVOS_DIR, { recursive: true });
    const clean: RoomConvo = { id, title: String(convo.title || "Chat").slice(0, 120), ts: Number(convo.ts) || Date.now(), msgs: convo.msgs.slice(0, 400) };
    await writeFile(path.join(CONVOS_DIR, `${id}.json`), JSON.stringify(clean), "utf8");
    return true;
  } catch { return false; }
}

export async function listConversations(): Promise<RoomConvo[]> {
  if (!CONVOS_DIR || !existsSync(CONVOS_DIR)) return [];
  try {
    const files = (await readdir(CONVOS_DIR)).filter((f) => f.endsWith(".json"));
    const convos: RoomConvo[] = [];
    for (const f of files) {
      try { const c = JSON.parse(await readFile(path.join(CONVOS_DIR, f), "utf8")); if (c?.id && Array.isArray(c.msgs)) convos.push(c); } catch { /* skip bad file */ }
    }
    return convos.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 80);
  } catch { return []; }
}

export async function deleteConversation(id: string): Promise<boolean> {
  if (!CONVOS_DIR) return false;
  try { await unlink(path.join(CONVOS_DIR, `${safeConvoId(id)}.json`)); return true; } catch { return false; }
}

export interface RoomAgent {
  id: string; name: string; color: string;
  provider: "openrouter" | "ollama" | "openai";
  model: string;
  persona: string;
  noReasoning?: boolean;  // snappy chat agents (GLM 5.2) skip chain-of-thought so a short reply is never starved
  baseUrl?: string;       // provider:"openai" → any OpenAI-compatible endpoint (z.ai, Sakana, a local server…)
  apiKeyEnv?: string;     // provider:"openai" → env var (or active Hermes profile .env key) holding the API key
}

// Each agent is authentically itself — verified working model IDs.
export const ROOM_AGENTS: RoomAgent[] = [
  { id: "claude", name: "Claude", color: "#d97757", provider: "openrouter", model: "anthropic/claude-opus-4.8",
    persona: "You are Claude — thoughtful, careful, balanced. You weigh trade-offs, bring nuance, and give a calm, precise take. You gently flag risks others miss." },
  { id: "hermes", name: "Hermes", color: "#60a5fa", provider: "openrouter", model: "nousresearch/hermes-4-70b",
    persona: "You are Hermes — direct, action-oriented, a little unfiltered. You cut straight to the practical next step and call out fluff. You like momentum." },
  { id: "gemini", name: "Gemini", color: "#4285F4", provider: "openrouter", model: "google/gemini-2.5-flash",
    persona: "You are Gemini — Google's agent. Broad knowledge, curious and upbeat. You bring data, facts, and a research angle to the table." },
  { id: "codex", name: "Codex", color: "#22c55e", provider: "openrouter", model: "openai/gpt-4o-mini",
    persona: "You are Codex — OpenAI's coding agent. Pragmatic, implementation-first. You think in systems and concrete steps, and you sketch the how." },
  { id: "openclaw", name: "OpenClaw", color: "#f472b6", provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct",
    persona: "You are OpenClaw — open-source, bold, a little cheeky. You challenge assumptions and champion the scrappy, independent path." },
  { id: "glm", name: "GLM 5.2", color: "#34E5B0", provider: "openrouter", model: "z-ai/glm-5.2", noReasoning: true,
    persona: "You are GLM 5.2 — Zhipu's frontier coder with a 1M-token context, and you match the big models on the long jobs for a fraction of the price. You're the efficient builder: you ship the grinding, multi-hour work others would charge a fortune for, and you quietly champion the cheaper, open-weights path. Confident, fast, a builder at heart — you'd rather show a working build than argue." },
  { id: "fcc", name: "Free Claude Code", color: "#10b981", provider: "ollama", model: "",
    persona: "You are Free Claude Code — scrappy and resourceful, running locally for free. You love the clever low-cost solution and remind everyone it doesn't have to be expensive." },
];

// Power users can repoint any room agent WITHOUT editing source — set "roomAgents"
// in ~/.agentic-os/config.json, keyed by agent id. e.g. route GLM to your z.ai key:
//   "roomAgents": { "glm": { "provider": "openai", "baseUrl": "https://api.z.ai/api/paas/v4",
//                            "apiKeyEnv": "GLM_API_KEY", "model": "glm-4.6" },
//                   "gemini": { "model": "google/gemini-3-pro-preview" },
//                   "codex": { "provider": "ollama" } }
function applyOverride(a: RoomAgent): RoomAgent {
  const o = (config.roomAgents ?? {})[a.id];
  const explicitModel = !!(o && typeof o.model === "string" && o.model);
  const m: RoomAgent = o ? {
    ...a,
    ...(explicitModel ? { model: o.model as string } : {}),
    ...(o.provider === "openrouter" || o.provider === "ollama" || o.provider === "openai" ? { provider: o.provider } : {}),
    ...(typeof o.baseUrl === "string" && o.baseUrl ? { baseUrl: o.baseUrl } : {}),
    ...(typeof o.apiKeyEnv === "string" && o.apiKeyEnv ? { apiKeyEnv: o.apiKeyEnv } : {}),
    ...(typeof o.noReasoning === "boolean" ? { noReasoning: o.noReasoning } : {}),
  } : a;
  // ollama agents inherit the warm local model unless an explicit model was given —
  // so switching an agent TO ollama without naming a model uses the local one (not its old cloud id).
  return m.provider === "ollama" && !explicitModel ? { ...m, model: localModel() } : m;
}
export function roomAgents(): RoomAgent[] {
  return ROOM_AGENTS.map(applyOverride);
}
export function getAgent(id: string): RoomAgent | undefined {
  return roomAgents().find((a) => a.id === id);
}

// ── keys / models ─────────────────────────────────────────────────────────────
function activeProfile(): string {
  try { const p = readFileSync(path.join(hermesHome(), "active_profile"), "utf8").trim(); if (p) return p; } catch {}
  return process.env.HERMES_PROFILE || "main";
}
// Resolve a named API key: the active Hermes profile .env first, then process.env.
// (Generalises the old OpenRouter-only reader so a room agent can use any key, e.g.
// GLM_API_KEY for z.ai, when routed to a native OpenAI-compatible endpoint.)
function profileEnvKey(name: string): string | null {
  const f = path.join(hermesHome(), "profiles", activeProfile(), ".env");
  if (existsSync(f)) {
    try {
      const line = readFileSync(f, "utf8").split("\n").find((l) => l.startsWith(name + "="));
      if (line) { const v = line.slice(name.length + 1).replace(/^["']|["']$/g, "").trim(); if (v) return v; }
    } catch {}
  }
  return process.env[name]?.trim() || null;
}
function openRouterKey(): string | null {
  return profileEnvKey("OPENROUTER_API_KEY");
}
function hermesDefaultModel(): string {
  try {
    const cfg = readFileSync(path.join(hermesHome(), "profiles", activeProfile(), "config.yaml"), "utf8");
    const m = cfg.match(/^\s*default:\s*([^\s#]+)/m);
    if (m) return m[1].trim();
  } catch {}
  return "anthropic/claude-opus-4.8";
}
function localModel(): string {
  try {
    const env = readFileSync(path.join(HOME, ".fcc", ".env"), "utf8");
    const line = env.split("\n").find((l) => l.startsWith("MODEL="));
    if (line) { const v = line.slice(6).replace(/^["']|["']$/g, "").trim(); if (v.startsWith("ollama/")) return v.slice(7); }
  } catch {}
  // Cloud MODEL slug (not ollama/) → use the pinned LOCAL_MODEL (installed) instead
  // of the un-pulled 12B default, so the Agent Room's local path doesn't 404.
  return process.env.LOCAL_MODEL || "qwen3.5:4b";
}

const ROOM_SYSTEM =
  "You are in a fast, live group chat with the user and a few other AI agents. " +
  "Keep every message SHORT and conversational — 1 to 3 sentences, like a real chat. " +
  "Stay fully in your own character. You can agree, disagree, build on, or tease the other agents by name. " +
  "Don't repeat what someone already said. Be genuinely useful and real. No preamble, no name prefix — just your message.\n" +
  "You can take REAL actions, but ONLY when the user clearly asks for them. Add the directive as a final line, exactly:\n" +
  "• NOTE:: <a short title> — save your point as a note in their vault\n" +
  "• PIPELINE:: <one-line idea> — add an idea to their project pipeline\n" +
  "• BUILD:: <full build prompt> — commission a REAL website/app build (GLM Code agent runs it and the finished preview link is posted back to this room). Write the complete spec in the directive itself: pages, sections, copy angle, style. Only ONE agent per round should emit BUILD:: — if another agent already committed to building this round, don't.\n" +
  "• LEAD:: <Company Name> status=<new|mockup|contacted|won|lost> — update a lead's stage in the user's Bexley CRM\n" +
  "• KANBAN:: <card title> | <card body> — add a tracking card to the user's bexley-factory kanban board\n" +
  "Use these sparingly — only on a clear request (e.g. 'build it', 'mark it contacted', 'track this'). Write your normal chat message first, then the directive on its own final line. Never mention this directive syntax in your visible message.";

export interface RoomTurn { speaker: string; text: string; }

// Some models/routes ignore the `reasoning: { enabled: false }` opt-out above and
// emit their chain-of-thought inline as a <think>...</think> (or <reasoning>/<thinking>)
// block ahead of the real reply, which otherwise renders straight into the chat as
// visible junk. Strip it generically here — every completion path funnels through
// this — rather than per-agent, since any seat's model could start doing this.
const THINK_TAG_STRIP = /<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi;
function stripReasoning(text: string): string {
  return text.replace(THINK_TAG_STRIP, "").trim();
}

// Generic OpenAI-compatible chat completion — works for OpenRouter, z.ai, Sakana,
// a local LM Studio/vLLM server, etc. (anything that speaks /chat/completions).
async function openaiChat(baseUrl: string, model: string, sys: string, user: string, key: string, signal?: AbortSignal, opts?: { noReasoning?: boolean }): Promise<string> {
  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  // Reasoning models (Claude 5 / Fable, but also Qwen-Max / DeepSeek-V4 routed in
  // via config) spend tokens thinking BEFORE the visible reply. A tight max_tokens
  // cap returns EMPTY content with finish_reason:"length" — the whole budget eaten
  // by hidden chain-of-thought — which surfaces in the Room as a lone "…". Two
  // levers: max_tokens gives reasoning headroom so it still emits a reply; the
  // noReasoning flag opts out of hidden CoT entirely (snappy chat agents).
  const call = (forceNoReason: boolean): Promise<Response> => fetch(url, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ model, max_tokens: 4000, temperature: 0.75, ...((opts?.noReasoning || forceNoReason) ? { reasoning: { enabled: false } } : {}), messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
  });
  let r = await call(false);
  let j = await r.json();
  if (!r.ok || !j?.choices?.[0]) throw new Error(j?.error?.message || `HTTP ${r.status}`);
  let out = stripReasoning(String(j.choices[0].message?.content ?? "").trim());
  // Empty visible content usually means reasoning ate the whole budget — retry
  // once with hidden CoT forced off so the agent still answers instead of "…".
  if (!out && !signal?.aborted) {
    r = await call(true);
    j = await r.json();
    if (!r.ok || !j?.choices?.[0]) throw new Error(j?.error?.message || `HTTP ${r.status}`);
    out = stripReasoning(String(j.choices[0].message?.content ?? "").trim());
  }
  return out;
}
function orComplete(model: string, sys: string, user: string, key: string, signal?: AbortSignal, opts?: { noReasoning?: boolean }): Promise<string> {
  return openaiChat("https://openrouter.ai/api/v1", model, sys, user, key, signal, opts);
}
async function ollamaComplete(model: string, sys: string, user: string, signal?: AbortSignal): Promise<string> {
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ model, stream: false, keep_alive: "30m", options: { num_predict: 200, temperature: 0.75 },
      messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status} — is it running?`);
  const j = await r.json();
  return stripReasoning(String(j?.message?.content ?? "").trim());
}

export interface RoomSource { kind: "profile" | "note" | "memory"; title: string; }

// Pull REAL context from the user's OWN Obsidian vault so the agents answer about
// THEIR world (their business, projects, notes, memories) — not with generic advice.
// Returns the context text + the list of sources it read (for transparency).
// (Add an "About Me.md" note to your vault to give the agents your profile.)
export async function roomContext(query: string): Promise<{ text: string; sources: RoomSource[] }> {
  if (!VAULT_AVAILABLE) return { text: "", sources: [] };
  const parts: string[] = []; const sources: RoomSource[] = [];
  try {
    const a = (await readNote("About Me.md")) ?? (await readNote("04 Resources/About Me.md"));
    if (a?.content) { parts.push("WHO THE USER IS:\n" + a.content.replace(/^---[\s\S]*?---/, "").replace(/[#*>[\]]/g, "").replace(/\n{2,}/g, "\n").trim().slice(0, 1100)); sources.push({ kind: "profile", title: "About Me" }); }
  } catch {}
  try {
    const hits = await searchNotes(query, 5);
    if (hits.length) { parts.push("RELEVANT NOTES FROM THE USER'S VAULT:\n" + hits.map((h) => `• ${h.title} — ${(h.preview || "").replace(/\s+/g, " ").slice(0, 150)}`).join("\n")); hits.forEach((h) => sources.push({ kind: "note", title: h.title })); }
  } catch {}
  try {
    const mem = await searchOmi(query, 6);
    if (mem.length) { parts.push("RELEVANT MEMORIES (things the user has said/done):\n" + mem.map((m) => "• " + m.slice(0, 170)).join("\n")); sources.push({ kind: "memory", title: `${mem.length} memories` }); }
  } catch {}
  try {
    const rec = await recentNotes(8);
    if (rec.length) parts.push("WHAT THE USER IS WORKING ON LATELY: " + rec.map((r) => r.title).join(", "));
  } catch {}
  return { text: parts.join("\n\n").slice(0, 4500), sources };
}

// ── deeper agentic: agents can write a note to the vault or add a pipeline item ─
export interface RoomAction { kind: "note" | "pipeline" | "build" | "lead" | "kanban"; label: string; ok: boolean; path?: string; }

const KANBAN_BOARD = "bexley-factory";
const LEADS_DIR = AGENTIC_DIR ? path.join(AGENTIC_DIR, "Website Factory", "Leads", "Companies") : "";
const LEAD_STATUSES = new Set(["new", "mockup", "contacted", "won", "lost"]);

// BUILD:: — fire-and-forget commission of a real GLM Code build via the dashboard's
// own API. The stream is drained in the background; on completion the outcome (and
// preview link for an index.html) is saved as a Room Note so the result is findable.
// Drains the build's ndjson stream via node:http rather than fetch(): undici
// (fetch's client) kills idle connections after ~5min of no bytes by default,
// and GLM 5.2 routinely goes quiet that long mid-tool-loop — that timeout was
// silently killing real, working builds (`TypeError: terminated`, no error
// surfaced anywhere) well before the server's own 12-minute hard cap ever got
// a chance to apply. http.request has no such default idle timeout.
function drainBuildStream(port: string, body: string): Promise<{ ok: boolean; resultLine: string }> {
  return new Promise((resolve) => {
    let ok = false; let resultLine = "";
    let buf = "";
    const req = http.request(
      { hostname: "127.0.0.1", port: Number(port), path: "/api/glm-code/build", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            try {
              const j = JSON.parse(line);
              if (j.type === "result") { ok = j.subtype === "success"; resultLine = String(j.result ?? "").slice(0, 400); }
            } catch {}
          }
        });
        res.on("end", () => resolve({ ok, resultLine }));
        res.on("error", (e) => resolve({ ok: false, resultLine: `build request failed: ${String(e).slice(0, 120)}` }));
      }
    );
    req.on("error", (e) => resolve({ ok: false, resultLine: `build request failed: ${String(e).slice(0, 120)}` }));
    req.write(body);
    req.end();
  });
}

function startRoomBuild(prompt: string, agentName: string): string {
  const project = `room-${prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32)}-${Date.now().toString(36).slice(-4)}`;
  const port = process.env.PORT || "3737";
  void (async () => {
    const { ok, resultLine } = await drainBuildStream(port, JSON.stringify({ prompt, project }));
    const preview = `/api/glm-code/preview/${project}/index.html`;
    await saveRoomNote(
      `Build ${ok ? "finished" : "FAILED"} — ${project}`,
      `Commissioned from the Agent Room by ${agentName}.\n\n**Prompt:** ${prompt.slice(0, 600)}\n\n**Result:** ${resultLine || "(no result line)"}\n\n**Preview:** http://127.0.0.1:${port}${preview}\n(Also visible in the GLM Code tab under project \`${project}\`.)`
    ).catch(() => {});
  })();
  return project;
}

// LEAD:: — flip a lead's status in the vault CRM (frontmatter `status:` in
// Website Factory/Leads/Companies/<Company>.md; case-insensitive filename match).
async function updateLeadStatus(company: string, status: string): Promise<boolean> {
  if (!LEADS_DIR || !LEAD_STATUSES.has(status)) return false;
  let files: string[] = [];
  try { files = (await readdir(LEADS_DIR)).filter((f) => f.endsWith(".md")); } catch { return false; }
  const want = company.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const match = files.find((f) => f.slice(0, -3).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === want)
    ?? files.find((f) => f.toLowerCase().includes(want.split(" ")[0] ?? "") && want.length > 3 && f.slice(0, -3).toLowerCase().replace(/[^a-z0-9]+/g, " ").includes(want));
  if (!match) return false;
  const full = path.join(LEADS_DIR, match);
  try {
    const src = await readFile(full, "utf8");
    if (!/^status:.*$/m.test(src)) return false;
    await writeFile(full, src.replace(/^status:.*$/m, `status: ${status}`), "utf8");
    return true;
  } catch { return false; }
}

async function saveRoomNote(title: string, body: string): Promise<string | null> {
  if (!AGENTIC_DIR) return null;
  const dir = path.join(AGENTIC_DIR, "Room Notes");
  await mkdir(dir, { recursive: true });
  const slug = (title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)) || "room-note";
  const date = new Date().toISOString().slice(0, 10);
  await writeFile(path.join(dir, `${slug}.md`), `# ${title}\n\n${body}\n\n---\n_Saved from the Agent Room · ${date}_\n`, "utf8");
  return `Agent OS/Room Notes/${slug}.md`;
}

// Parse + run NOTE:: / PIPELINE:: / BUILD:: / LEAD:: / KANBAN:: directives from an
// agent's reply. Returns the cleaned message (directives stripped) + actions taken.
export async function executeRoomActions(text: string, agentName = "an agent", opts?: { allowBuild?: boolean }): Promise<{ clean: string; actions: RoomAction[] }> {
  const actions: RoomAction[] = [];
  const noteM = text.match(/^\s*NOTE::\s*(.+?)\s*$/im);
  const pipeM = text.match(/^\s*PIPELINE::\s*(.+?)\s*$/im);
  const buildM = text.match(/^\s*BUILD::\s*(.+?)\s*$/im);
  const leadM = text.match(/^\s*LEAD::\s*(.+?)\s+status=([a-z]+)\s*$/im);
  const kanbanM = text.match(/^\s*KANBAN::\s*(.+?)\s*$/im);
  const clean = text.replace(/^\s*(?:NOTE|PIPELINE|BUILD|LEAD|KANBAN)::.*$/gim, "").replace(/\n{3,}/g, "\n\n").trim();

  if (noteM) {
    const title = noteM[1].trim().slice(0, 80) || "Room note";
    const p = await saveRoomNote(title, clean || title);
    actions.push({ kind: "note", label: title, ok: !!p, path: p || undefined });
  }
  if (pipeM) {
    const idea = pipeM[1].trim();
    try {
      const slug = await uniqueSlug(idea);
      const item: PipelineItem = { slug, title: idea.slice(0, 80), stage: "inbox", created: new Date().toISOString(), idea };
      await writeItem(item);
      actions.push({ kind: "pipeline", label: idea.slice(0, 60), ok: true });
    } catch { actions.push({ kind: "pipeline", label: idea.slice(0, 60), ok: false }); }
  }
  if (buildM) {
    const prompt = buildM[1].trim();
    if (opts?.allowBuild === false) {
      // Another agent already commissioned a build this round — models sometimes
      // all volunteer despite the prompt telling them not to. One build per round.
      actions.push({ kind: "build", label: "skipped — a build is already running this round", ok: false });
    } else if (prompt.length >= 20) {
      const project = startRoomBuild(prompt, agentName);
      actions.push({ kind: "build", label: project, ok: true, path: `/api/glm-code/preview/${project}/index.html` });
    } else {
      actions.push({ kind: "build", label: "prompt too short", ok: false });
    }
  }
  if (leadM) {
    const company = leadM[1].trim();
    const status = leadM[2].toLowerCase();
    const ok = await updateLeadStatus(company, status);
    actions.push({ kind: "lead", label: `${company} → ${status}`, ok });
  }
  if (kanbanM) {
    const [titlePart, ...bodyParts] = kanbanM[1].split("|");
    const title = (titlePart ?? "").trim().slice(0, 200);
    const cardBody = bodyParts.join("|").trim().slice(0, 2000);
    if (title) {
      try {
        const args = ["kanban", "--board", KANBAN_BOARD, "create", title, "--json"];
        if (cardBody) args.push("--body", cardBody);
        const out = await run("hermes", args, { timeoutMs: 20_000 });
        actions.push({ kind: "kanban", label: title.slice(0, 60), ok: out.ok });
      } catch { actions.push({ kind: "kanban", label: title.slice(0, 60), ok: false }); }
    } else {
      actions.push({ kind: "kanban", label: "missing title", ok: false });
    }
  }
  return { clean: clean || text, actions };
}

// One agent's reply, given the transcript + the user's vault context. Cloud agents
// fall back to the Hermes default model if their model errors — never stalls.
export async function roomReply(agent: RoomAgent, transcript: RoomTurn[], context: string, signal?: AbortSignal): Promise<string> {
  const ctx = context
    ? `\n\n--- THE USER'S REAL CONTEXT (from their Obsidian vault) ---\n${context}\n--- end context ---\nGround your reply in THIS. Reference their actual business, projects, and notes. Be specific to the user — never give generic advice you could give anyone.`
    : "";
  const sys = `${ROOM_SYSTEM}\n\nYou are ${agent.name}. ${agent.persona}${ctx}`;
  const convo = transcript.slice(-14).map((t) => `${t.speaker}: ${t.text}`).join("\n");
  const user = `${convo}\n\n${agent.name}:`;
  if (agent.provider === "ollama") {
    let out = await ollamaComplete(agent.model, sys, user, signal);
    if (!out && !signal?.aborted) out = await ollamaComplete(agent.model, sys, user, signal);  // gemma occasionally returns empty
    return out || "I'm here — running locally and ready when you are.";
  }
  // Native OpenAI-compatible endpoint (config override) — e.g. GLM via your z.ai key.
  if (agent.provider === "openai") {
    const base = agent.baseUrl || "https://api.openai.com/v1";
    const envName = agent.apiKeyEnv || "OPENAI_API_KEY";
    const k = profileEnvKey(envName);
    if (!k) throw new Error(`No API key for ${agent.name} — set ${envName} (env var or your active Hermes profile .env).`);
    return await openaiChat(base, agent.model, sys, user, k, signal, { noReasoning: agent.noReasoning });
  }
  const key = openRouterKey();
  if (!key) throw new Error("No OpenRouter key in the active Hermes profile.");
  try { return await orComplete(agent.model, sys, user, key, signal, { noReasoning: agent.noReasoning }); }
  catch (e) {
    if (signal?.aborted) throw e;
    const fallback = hermesDefaultModel();
    if (fallback && fallback !== agent.model) { try { return await orComplete(fallback, sys, user, key, signal); } catch {} }
    throw e;
  }
}

// Pull @mentions (e.g. "@claude @gemini") from a message → agent ids, if any.
export function mentionedIds(message: string): string[] {
  const ids = roomAgents().map((a) => a.id);
  const found = (message.toLowerCase().match(/@([a-z]+)/g) || []).map((m) => m.slice(1));
  return ids.filter((id) => found.includes(id));
}
