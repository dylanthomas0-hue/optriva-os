// Mission queue store — one JSON file per mission under ~/.agentic-os/missions/
// plus a plain-text <id>.log for executor output. The queue is the source of
// truth (kanban is display). No locking needed: the dashboard only CREATES
// missions and PATCHes user actions (retry/close); the missiond dispatcher
// (scripts/mission-dispatcher.mjs) owns all other transitions. Writes are
// atomic via temp-file + rename.
import { mkdir, readFile, writeFile, readdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { AGENTIC_ROOT, emitEvent } from "@/lib/eventBus";

export const MISSIONS_DIR = path.join(AGENTIC_ROOT, "missions");

export type KernelState =
  | "queued" | "assigned" | "running" | "waiting"
  | "retrying" | "completed" | "verified" | "closed" | "failed";

export interface Evidence {
  type: "commit" | "url" | "file" | "test" | "screenshot" | "log";
  value: string;
  capturedAt: number;
}

export interface MissionTask {
  id: string;
  name: string;
  prompt: string;
  executor: { kind: string; [k: string]: unknown };
  verifier: string;
  verify?: string;              // shell command for the "command"/"website" verifier plugins
  deps: string[];               // task ids that must be verified first
  state: KernelState;
  attempts: number;
  maxAttempts: number;
  timeoutMs: number;
  evidence: Evidence[];
  pid?: number;
  retryAt?: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface Mission {
  id: string;
  title: string;
  prompt: string;
  capability: string;
  source: string;               // "chat" | "api" | "goal:<id>"
  priority: "high" | "normal" | "low";
  state: KernelState;
  tasks: MissionTask[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  history: { state: KernelState; at: number; note?: string }[];
}

export function missionPath(id: string): string { return path.join(MISSIONS_DIR, `${id}.json`); }
export function missionLogPath(id: string): string { return path.join(MISSIONS_DIR, `${id}.log`); }

async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, file);
}

export async function createMission(input: {
  title: string; prompt: string; capability: string; source: string;
  priority?: Mission["priority"]; tasks: Omit<MissionTask, "state" | "attempts" | "evidence">[];
}): Promise<Mission> {
  await mkdir(MISSIONS_DIR, { recursive: true });
  const id = `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  const mission: Mission = {
    id,
    title: input.title,
    prompt: input.prompt,
    capability: input.capability,
    source: input.source,
    priority: input.priority ?? "normal",
    state: "queued",
    tasks: input.tasks.map((t) => ({ ...t, state: "queued", attempts: 0, evidence: [] })),
    createdAt: now,
    updatedAt: now,
    history: [{ state: "queued", at: now }],
  };
  await atomicWrite(missionPath(id), JSON.stringify(mission, null, 2));
  emitEvent("mission.created", id, { data: { capability: mission.capability, title: mission.title, source: mission.source, tasks: mission.tasks.length } });
  return mission;
}

export async function getMission(id: string): Promise<Mission | null> {
  // Ids come from the API path — keep them boring before touching the fs.
  if (!/^m_[a-z0-9]+$/.test(id)) return null;
  try { return JSON.parse(await readFile(missionPath(id), "utf8")); } catch { return null; }
}

export async function listMissions(): Promise<Mission[]> {
  if (!existsSync(MISSIONS_DIR)) return [];
  const files = (await readdir(MISSIONS_DIR)).filter((f) => f.startsWith("m_") && f.endsWith(".json"));
  const missions: Mission[] = [];
  for (const f of files) {
    try { missions.push(JSON.parse(await readFile(path.join(MISSIONS_DIR, f), "utf8"))); } catch { /* mid-rename */ }
  }
  return missions.sort((a, b) => b.createdAt - a.createdAt);
}

// Dashboard-side patches are limited to user actions; the dispatcher owns the
// real state machine. Used by PATCH /api/missions/[id] for retry & close.
export async function patchMission(id: string, action: "retry" | "close"): Promise<Mission | null> {
  const m = await getMission(id);
  if (!m) return null;
  const now = Date.now();
  if (action === "close") {
    m.state = "closed";
    m.history.push({ state: "closed", at: now, note: "closed from dashboard" });
  } else {
    // Re-queue failed/escalated work with a fresh attempt budget.
    for (const t of m.tasks) {
      if (t.state === "failed" || t.state === "waiting") {
        t.state = "queued"; t.attempts = 0; t.error = undefined; t.retryAt = undefined;
      }
    }
    m.state = "queued";
    m.history.push({ state: "queued", at: now, note: "retried from dashboard" });
  }
  m.updatedAt = now;
  await atomicWrite(missionPath(id), JSON.stringify(m, null, 2));
  emitEvent(`mission.${action}`, id);
  return m;
}

export async function missionLogTail(id: string, lines = 100): Promise<string> {
  try {
    const log = await readFile(missionLogPath(id), "utf8");
    return log.split("\n").slice(-lines).join("\n");
  } catch { return ""; }
}
