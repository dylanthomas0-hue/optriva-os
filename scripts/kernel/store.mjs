// Daemon-side mission/event/registry access. Mirrors the file formats owned
// by src/lib/{missionStore,eventBus,capabilityRegistry}.ts — the contract
// between dashboard and daemon is these JSON files, not shared code (launchd
// runs plain node; the dashboard is TypeScript).
import { readFileSync, writeFileSync, renameSync, readdirSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const ROOT = path.join(os.homedir(), ".agentic-os");
export const MISSIONS_DIR = path.join(ROOT, "missions");
export const EVENTS_FILE = path.join(ROOT, "events.ndjson");
export const CAPABILITIES_FILE = path.join(ROOT, "capabilities.json");
export const BUDGET_FILE = path.join(ROOT, "metrics", "budget.json");

export function missionPath(id) { return path.join(MISSIONS_DIR, `${id}.json`); }
export function missionLogPath(id) { return path.join(MISSIONS_DIR, `${id}.log`); }

export function emitEvent(type, missionId, extra = {}) {
  try {
    mkdirSync(ROOT, { recursive: true });
    appendFileSync(EVENTS_FILE, JSON.stringify({ ts: Date.now(), type, missionId, ...extra }) + "\n", "utf8");
  } catch { /* best-effort */ }
}

export function loadRegistry() {
  return JSON.parse(readFileSync(CAPABILITIES_FILE, "utf8"));
}

export function listMissions() {
  if (!existsSync(MISSIONS_DIR)) return [];
  const out = [];
  for (const f of readdirSync(MISSIONS_DIR)) {
    if (!f.startsWith("m_") || !f.endsWith(".json")) continue;
    try { out.push(JSON.parse(readFileSync(path.join(MISSIONS_DIR, f), "utf8"))); } catch { /* mid-rename */ }
  }
  return out;
}

export function saveMission(mission) {
  mission.updatedAt = Date.now();
  const file = missionPath(mission.id);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(mission, null, 2), "utf8");
  renameSync(tmp, file);
}

export function appendLog(missionId, taskId, chunk) {
  try {
    mkdirSync(MISSIONS_DIR, { recursive: true });
    const prefix = `[${taskId}] `;
    const text = chunk.toString().split("\n").filter((l) => l.length).map((l) => prefix + l).join("\n");
    if (text) appendFileSync(missionLogPath(missionId), text + "\n", "utf8");
  } catch { /* best-effort */ }
}

export function setTaskState(mission, task, state, note) {
  task.state = state;
  mission.history.push({ state, at: Date.now(), note: note ? `${task.id}: ${note}` : task.id });
  emitEvent("task.state", mission.id, { taskId: task.id, data: { state, note } });
}

// Derive the mission-level state from its tasks; emit only on change.
export function deriveMissionState(mission) {
  const states = mission.tasks.map((t) => t.state);
  let next = mission.state;
  if (states.some((s) => s === "failed")) next = "failed";
  else if (states.some((s) => s === "waiting")) next = "waiting";
  else if (states.every((s) => s === "verified")) next = "verified";
  else if (states.some((s) => s === "running" || s === "assigned" || s === "retrying" || s === "completed")) next = "running";
  else next = "queued";
  if (next !== mission.state) {
    mission.state = next;
    if (next === "running" && !mission.startedAt) mission.startedAt = Date.now();
    if (["verified", "failed"].includes(next)) mission.finishedAt = Date.now();
    mission.history.push({ state: next, at: Date.now() });
    emitEvent("mission.state", mission.id, { data: { state: next } });
  }
}

// Daily launch budget per scheduler pool — OpenCode Go is $0 marginal but
// rate-limited; this stops a runaway queue from hammering it.
export function readBudget() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const b = JSON.parse(readFileSync(BUDGET_FILE, "utf8"));
    if (b.date === today) return b;
  } catch { /* fresh day / first run */ }
  return { date: today, counts: {} };
}

export function incrementBudget(pool) {
  const b = readBudget();
  b.counts[pool] = (b.counts[pool] ?? 0) + 1;
  mkdirSync(path.dirname(BUDGET_FILE), { recursive: true });
  writeFileSync(BUDGET_FILE, JSON.stringify(b), "utf8");
}
