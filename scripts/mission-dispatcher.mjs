#!/usr/bin/env node
// missiond — the execution kernel's dispatcher (launchd: ai.agentos.missiond).
//
// Deliberately stupid: it knows nothing about websites, OpenClaw, or Hermes.
// Its whole job, every 2s, for each task whose deps are verified:
//   Scheduler.approve(task) → Executor.run(task) → Verifier.run(task) → state + events
// All domain knowledge lives in ~/.agentic-os/capabilities.json and the
// plugins in scripts/kernel/. State machine per task:
//   queued → assigned → running → (verifier) → verified
//                                → rejected → retrying (30s backoff, maxAttempts) → failed
//                                → escalate → waiting (user decides in Missions tab)
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import {
  MISSIONS_DIR, missionLogPath, listMissions, saveMission, appendLog,
  setTaskState, deriveMissionState, emitEvent, loadRegistry, incrementBudget,
} from "./kernel/store.mjs";
import { approve, sortMissions } from "./kernel/scheduler.mjs";
import { executors } from "./kernel/executors.mjs";
import { verifiers } from "./kernel/verifiers.mjs";

const TICK_MS = 2000;
const RETRY_BACKOFF_MS = 30_000;
const PID_FILE = path.join(MISSIONS_DIR, ".dispatcher.pid");

// ── single instance ──
mkdirSync(MISSIONS_DIR, { recursive: true });
if (existsSync(PID_FILE)) {
  const old = Number(readFileSync(PID_FILE, "utf8"));
  try { process.kill(old, 0); console.error(`missiond already running (pid ${old})`); process.exit(1); }
  catch { /* stale */ }
}
writeFileSync(PID_FILE, String(process.pid), "utf8");
process.on("exit", () => { try { unlinkSync(PID_FILE); } catch {} });
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

console.log(`missiond up (pid ${process.pid}) — watching ${MISSIONS_DIR}`);

// running children: taskKey "missionId/taskId" → { child, pool, timer }
const running = new Map();
const lastWaitReason = new Map(); // throttle scheduler.wait events to reason changes

// ── crash recovery: any task marked running/assigned is unsupervised after a
// restart — even if its pid is still alive, nobody is watching for its exit
// (the close handler died with the old dispatcher). Kill leftovers and requeue.
for (const mission of listMissions()) {
  let changed = false;
  for (const task of mission.tasks) {
    if (task.state === "running" || task.state === "assigned") {
      if (task.pid) {
        try { process.kill(task.pid, "SIGKILL"); console.log(`restart sweep: killed orphaned pid ${task.pid} (${mission.id}/${task.id})`); }
        catch { /* already dead */ }
      }
      setTaskState(mission, task, "retrying", "dispatcher restart: worker unsupervised, requeued");
      task.retryAt = Date.now();
      task.pid = undefined;
      changed = true;
    }
  }
  if (changed) { deriveMissionState(mission); saveMission(mission); }
}

function poolCounts() {
  const counts = {};
  for (const { pool } of running.values()) counts[pool] = (counts[pool] ?? 0) + 1;
  return counts;
}

function startTask(mission, task, cap, pool) {
  const key = `${mission.id}/${task.id}`;
  setTaskState(mission, task, "assigned");
  saveMission(mission);

  let child;
  try {
    const executor = executors[task.executor?.kind];
    if (!executor) throw new Error(`unknown executor kind: ${task.executor?.kind}`);
    child = executor(task);
  } catch (e) {
    finishTask(mission.id, task.id, { exitCode: -1, error: String(e.message) });
    return;
  }

  incrementBudget(pool);
  task.pid = child.pid;
  task.startedAt = Date.now();
  setTaskState(mission, task, "running", `pid ${child.pid} (${task.executor.kind})`);
  deriveMissionState(mission);
  saveMission(mission);
  emitEvent("task.dispatched", mission.id, { taskId: task.id, data: { kind: task.executor.kind, pool, pid: child.pid } });

  child.stdout.on("data", (c) => appendLog(mission.id, task.id, c));
  child.stderr.on("data", (c) => appendLog(mission.id, task.id, c));

  const timer = setTimeout(() => {
    appendLog(mission.id, task.id, `missiond: timeout after ${task.timeoutMs}ms — killing pid ${child.pid}`);
    try { child.kill("SIGKILL"); } catch {}
  }, task.timeoutMs ?? 30 * 60 * 1000);

  running.set(key, { child, pool, timer });
  child.on("close", (code) => {
    clearTimeout(timer);
    running.delete(key);
    finishTask(mission.id, task.id, { exitCode: code ?? -1 });
  });
}

function finishTask(missionId, taskId, { exitCode, error }) {
  // Re-read from disk — the dashboard may have PATCHed meanwhile.
  const mission = listMissions().find((m) => m.id === missionId);
  if (!mission) return;
  const task = mission.tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.pid = undefined;
  task.finishedAt = Date.now();

  let logTail = "";
  try { logTail = readFileSync(missionLogPath(missionId), "utf8").split("\n").slice(-60).join("\n"); } catch {}

  // Executor done (or dead) → the Verifier decides what actually happened.
  let result;
  try {
    const verifier = verifiers[task.verifier] ?? verifiers.command;
    result = error ? { verdict: "rejected", error } : verifier(task, { exitCode, logTail, missionId });
  } catch (e) {
    result = { verdict: "rejected", error: `verifier crashed: ${String(e.message)}` };
  }
  if (result.evidence?.length) task.evidence.push(...result.evidence);
  emitEvent("verifier.verdict", missionId, { taskId, data: { verdict: result.verdict, verifier: task.verifier, exitCode, error: result.error } });

  if (result.verdict === "verified") {
    setTaskState(mission, task, "verified");
  } else if (result.verdict === "escalate") {
    setTaskState(mission, task, "waiting", result.error ?? "escalated by verifier");
  } else {
    task.attempts += 1;
    task.error = result.error;
    if (task.attempts < (task.maxAttempts ?? 2)) {
      task.retryAt = Date.now() + RETRY_BACKOFF_MS;
      setTaskState(mission, task, "retrying", `attempt ${task.attempts} rejected: ${String(result.error).slice(0, 160)}`);
    } else {
      setTaskState(mission, task, "failed", String(result.error).slice(0, 200));
    }
  }
  deriveMissionState(mission);
  saveMission(mission);
}

function tick() {
  let registry;
  try { registry = loadRegistry(); } catch (e) {
    console.error(`capabilities.json unreadable: ${e.message}`);
    return;
  }
  const now = Date.now();
  const active = sortMissions(listMissions().filter((m) => !["verified", "closed", "failed", "waiting"].includes(m.state)));

  for (const mission of active) {
    for (const task of mission.tasks) {
      const startable = task.state === "queued" || (task.state === "retrying" && now >= (task.retryAt ?? 0));
      if (!startable) continue;
      if (running.has(`${mission.id}/${task.id}`)) continue;
      const depsOk = task.deps.every((d) => mission.tasks.find((t) => t.id === d)?.state === "verified");
      if (!depsOk) continue;

      const cap = registry.capabilities[mission.capability];
      const decision = approve(task, cap, registry, poolCounts());
      if (decision.verdict !== "run") {
        const key = `${mission.id}/${task.id}`;
        if (lastWaitReason.get(key) !== decision.reason) {
          lastWaitReason.set(key, decision.reason);
          emitEvent("scheduler.wait", mission.id, { taskId: task.id, data: { reason: decision.reason, detail: decision.detail } });
        }
        continue;
      }
      lastWaitReason.delete(`${mission.id}/${task.id}`);
      startTask(mission, task, cap, decision.pool);
    }
  }
}

setInterval(tick, TICK_MS);
tick();
