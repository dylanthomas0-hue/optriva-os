// Live mission events over SSE — tails ~/.agentic-os/events.ndjson from the
// client's connect point (no replay of history here; Mission Replay uses
// /api/missions/[id]?replay=1). fs.watch + offset, 15s heartbeat, no polling.
import { createReadStream, existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { EVENTS_FILE } from "@/lib/eventBus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let watcher: FSWatcher | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let offset = existsSync(EVENTS_FILE) ? statSync(EVENTS_FILE).size : 0;
  let reading = false;
  let pending = false;
  let carry = ""; // partial last line between reads

  const stream = new ReadableStream({
    start(controller) {
      const send = (line: string) => {
        try { controller.enqueue(encoder.encode(`data: ${line}\n\n`)); } catch { /* client gone */ }
      };
      send(JSON.stringify({ type: "sse.connected", ts: Date.now() }));

      const drain = () => {
        if (reading) { pending = true; return; }
        if (!existsSync(EVENTS_FILE)) return;
        const size = statSync(EVENTS_FILE).size;
        if (size <= offset) { if (size < offset) offset = size; return; } // truncated/rotated
        reading = true;
        const rs = createReadStream(EVENTS_FILE, { start: offset, end: size - 1, encoding: "utf8" });
        rs.on("data", (chunk) => {
          const text = carry + chunk;
          const lines = text.split("\n");
          carry = lines.pop() ?? "";
          for (const l of lines) if (l.trim()) send(l);
        });
        rs.on("close", () => {
          offset = size;
          reading = false;
          if (pending) { pending = false; drain(); }
        });
        rs.on("error", () => { reading = false; });
      };

      try { watcher = watch(EVENTS_FILE, drain); }
      catch { /* file may not exist yet; heartbeat below retries the watch */ }
      heartbeat = setInterval(() => {
        send(JSON.stringify({ type: "sse.heartbeat", ts: Date.now() }));
        if (!watcher && existsSync(EVENTS_FILE)) {
          try { watcher = watch(EVENTS_FILE, drain); drain(); } catch { /* next beat */ }
        }
      }, 15_000);

      req.signal.addEventListener("abort", () => {
        watcher?.close();
        if (heartbeat) clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    cancel() {
      watcher?.close();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
