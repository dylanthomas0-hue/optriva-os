// Execution-kernel event bus: an append-only ndjson log. Every mission/task
// state transition, scheduler decision, and verifier verdict lands here — the
// SSE route, Mission Replay, and (later) World State / Goal Engine all consume
// this stream instead of calling each other. The dispatcher daemon
// (scripts/kernel/store.mjs) appends to the same file with the same shape.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const AGENTIC_ROOT = path.join(os.homedir(), ".agentic-os");
export const EVENTS_FILE = path.join(AGENTIC_ROOT, "events.ndjson");

export interface KernelEvent {
  ts: number;
  type: string;               // e.g. "mission.created", "task.state", "scheduler.wait", "verifier.verdict"
  missionId: string;
  taskId?: string;
  data?: Record<string, unknown>;
}

export function emitEvent(type: string, missionId: string, extra?: { taskId?: string; data?: Record<string, unknown> }): KernelEvent {
  const ev: KernelEvent = { ts: Date.now(), type, missionId, ...extra };
  try {
    mkdirSync(AGENTIC_ROOT, { recursive: true });
    // appendFileSync with O_APPEND writes one line atomically at this size.
    appendFileSync(EVENTS_FILE, JSON.stringify(ev) + "\n", "utf8");
  } catch { /* events are best-effort; never break the caller */ }
  return ev;
}
