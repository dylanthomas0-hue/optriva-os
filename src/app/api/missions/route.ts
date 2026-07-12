// Mission queue API — list + create. POST is also the front door for the
// future Goal Engine and any external tool that wants to enqueue work.
import { NextResponse } from "next/server";
import { listMissions, createMission } from "@/lib/missionStore";
import { loadRegistry } from "@/lib/capabilityRegistry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ missions: await listMissions() });
}

export async function POST(req: Request) {
  const body = await req.json();
  const { prompt, capability, title, priority, source } = body ?? {};
  if (typeof prompt !== "string" || !prompt.trim()) {
    return NextResponse.json({ error: "missing prompt" }, { status: 400 });
  }
  const registry = loadRegistry();
  const cap = typeof capability === "string" ? registry.capabilities[capability] : undefined;
  if (!cap) {
    return NextResponse.json({ error: `unknown capability — one of: ${Object.keys(registry.capabilities).join(", ")}` }, { status: 400 });
  }
  const mission = await createMission({
    title: typeof title === "string" && title.trim() ? title.slice(0, 120) : prompt.slice(0, 80),
    prompt,
    capability,
    source: typeof source === "string" ? source.slice(0, 64) : "api",
    priority: priority === "high" || priority === "low" ? priority : cap.priority,
    tasks: [{
      id: "t1",
      name: capability,
      prompt,
      executor: cap.executor,
      verifier: cap.verifier,
      verify: cap.verify,
      deps: [],
      maxAttempts: 2,
      timeoutMs: cap.timeoutMs ?? 30 * 60 * 1000,
    }],
  });
  return NextResponse.json({ ok: true, mission });
}
