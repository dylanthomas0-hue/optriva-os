// Single mission: detail + log tail (+ ?replay=1 for the ordered event
// timeline), and PATCH for the two user actions the dashboard owns
// (retry / close) — everything else is missiond's job.
import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { getMission, patchMission, missionLogTail } from "@/lib/missionStore";
import { EVENTS_FILE, type KernelEvent } from "@/lib/eventBus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const mission = await getMission(id);
  if (!mission) return NextResponse.json({ error: "not found" }, { status: 404 });

  const url = new URL(req.url);
  if (url.searchParams.get("replay")) {
    let events: KernelEvent[] = [];
    try {
      events = (await readFile(EVENTS_FILE, "utf8"))
        .split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l) as KernelEvent; } catch { return null; } })
        .filter((e): e is KernelEvent => !!e && e.missionId === id);
    } catch { /* no events yet */ }
    return NextResponse.json({ mission, events });
  }
  return NextResponse.json({ mission, log: await missionLogTail(id) });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { action } = await req.json();
  if (action !== "retry" && action !== "close") {
    return NextResponse.json({ error: "action must be retry|close" }, { status: 400 });
  }
  const mission = await patchMission(id, action);
  if (!mission) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true, mission });
}
