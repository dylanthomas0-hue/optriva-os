// Kernel operational metrics, computed from the mission store + event log.
// This is the observability layer: where time goes, where reliability degrades.
import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { listMissions } from "@/lib/missionStore";
import { EVENTS_FILE, type KernelEvent } from "@/lib/eventBus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const missions = await listMissions();
  let events: KernelEvent[] = [];
  try {
    events = (await readFile(EVENTS_FILE, "utf8")).split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as KernelEvent; } catch { return null; } })
      .filter((e): e is KernelEvent => !!e);
  } catch { /* no events yet */ }

  const terminal = missions.filter((m) => ["verified", "failed", "closed"].includes(m.state));
  const verified = terminal.filter((m) => m.state === "verified").length;

  const queueTimes: number[] = [];
  const execTimes: number[] = [];
  for (const m of missions) {
    if (m.startedAt) queueTimes.push(m.startedAt - m.createdAt);
    if (m.startedAt && m.finishedAt) execTimes.push(m.finishedAt - m.startedAt);
  }
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

  const verdicts = events.filter((e) => e.type === "verifier.verdict");
  const rejected = verdicts.filter((e) => e.data?.verdict === "rejected").length;

  const retriedMissions = missions.filter((m) => m.tasks.some((t) => t.attempts > 0)).length;

  const dayAgo = Date.now() - 86_400_000;
  const throughput24h = missions.filter((m) => m.finishedAt && m.finishedAt > dayAgo && m.state === "verified").length;

  const waitReasons: Record<string, number> = {};
  for (const e of events) {
    if (e.type === "scheduler.wait") {
      const r = String(e.data?.reason ?? "unknown");
      waitReasons[r] = (waitReasons[r] ?? 0) + 1;
    }
  }

  return NextResponse.json({
    missions: missions.length,
    active: missions.length - terminal.length,
    successRate: terminal.length ? verified / terminal.length : null,
    avgQueueMs: avg(queueTimes),
    avgExecMs: avg(execTimes),
    verifierRejectionRate: verdicts.length ? rejected / verdicts.length : null,
    retryRate: missions.length ? retriedMissions / missions.length : null,
    throughput24h,
    waitReasons: Object.entries(waitReasons).sort((a, b) => b[1] - a[1]).slice(0, 5),
    events: events.length,
  });
}
