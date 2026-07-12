// Resource Scheduler — the universal admission gate. Every task passes
// approve() before the dispatcher may start it; nothing bypasses it. Answers
// run|wait from live signals so the queue can't DOS the machine or the
// flat-rate model endpoint. New signals (Redis, API rate limits, GPU) plug in
// here without touching the dispatcher.
import os from "node:os";
import { execFileSync } from "node:child_process";
import { readBudget } from "./store.mjs";

// os.freemem() on macOS counts only truly-free pages (~hundreds of MB even on
// an idle machine, because macOS keeps RAM in file cache) — using it starves
// the queue forever. Available = free + inactive + purgeable + speculative.
function availableMemMB() {
  if (process.platform !== "darwin") return os.freemem() / (1024 * 1024);
  try {
    const out = execFileSync("/usr/bin/vm_stat", { encoding: "utf8", timeout: 5000 });
    const page = Number(out.match(/page size of (\d+)/)?.[1] ?? 16384);
    const grab = (name) => Number(out.match(new RegExp(`${name}:\\s+(\\d+)`))?.[1] ?? 0);
    const pages = grab("Pages free") + grab("Pages inactive") + grab("Pages purgeable") + grab("Pages speculative");
    return (pages * page) / (1024 * 1024);
  } catch {
    return os.freemem() / (1024 * 1024);
  }
}

// runningPools: { poolName: currentRunningCount }, from the dispatcher's view.
export function approve(task, cap, registry, runningPools) {
  const cfg = registry._scheduler;
  const pool = cap?.schedulerPool ?? "shell";

  const totalRunning = Object.values(runningPools).reduce((a, b) => a + b, 0);
  if (totalRunning >= cfg.global) return { verdict: "wait", reason: `global cap ${cfg.global} reached` };

  const poolCap = cfg.pools[pool] ?? 1;
  if ((runningPools[pool] ?? 0) >= poolCap) return { verdict: "wait", reason: `pool "${pool}" cap ${poolCap} reached` };

  // Reasons are stable strings (no live numbers) so the dispatcher's
  // per-reason event throttle works; the live value goes in `detail`.
  const availMB = availableMemMB();
  if (availMB < cfg.minFreeMemMB) return { verdict: "wait", reason: `available RAM below ${cfg.minFreeMemMB}MB`, detail: `${Math.round(availMB)}MB` };

  const loadPerCore = os.loadavg()[0] / os.cpus().length;
  if (loadPerCore > cfg.maxLoadPerCore) return { verdict: "wait", reason: `load/core above ${cfg.maxLoadPerCore}`, detail: loadPerCore.toFixed(2) };

  const budget = readBudget();
  const dailyCap = cfg.dailyBudget[pool] ?? 100;
  if ((budget.counts[pool] ?? 0) >= dailyCap) return { verdict: "wait", reason: `daily budget for "${pool}" (${dailyCap}) exhausted` };

  return { verdict: "run", pool };
}

// Oldest-first within priority bands, so high-priority work jumps the queue
// but nothing starves forever within a band.
const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };
export function sortMissions(missions) {
  return missions.sort((a, b) =>
    (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1) || a.createdAt - b.createdAt);
}
