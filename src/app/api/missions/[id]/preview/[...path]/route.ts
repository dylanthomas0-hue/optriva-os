// Serves the built frontend from a website-redesign mission's isolated git
// worktree (see siteRedesignActions.ts) so it can be previewed before the
// explicit Approve & Deploy action ships it to the live site.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getMission } from "@/lib/missionStore";
import { redesignWorktree } from "@/lib/siteRedesignActions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; path: string[] }> }) {
  const { id, path: parts } = await params;
  const mission = await getMission(id);
  if (!mission) return new Response("mission not found", { status: 404 });
  const task = mission.tasks.find((t) => t.verifier === "website-redesign");
  const worktree = task ? redesignWorktree(task) : null;
  if (!worktree) return new Response("no redesign preview for this mission", { status: 404 });

  const root = path.join(worktree, "frontend", "build");
  const rel = (parts || []).map(decodeURIComponent).join("/") || "index.html";
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep) && full !== root) return new Response("forbidden", { status: 403 });
  try {
    const buf = await readFile(full);
    const ext = path.extname(full).toLowerCase();
    return new Response(new Uint8Array(buf), {
      headers: { "Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": "no-store" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
