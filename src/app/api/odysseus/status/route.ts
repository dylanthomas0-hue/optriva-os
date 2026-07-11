// Server-side reachability probe for Odysseus (Docker Compose, 127.0.0.1:7300).
// Probed from the server because the browser can't read a cross-origin status.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ODYSSEUS_URL = process.env.ODYSSEUS_URL || "http://127.0.0.1:7300";

export async function GET() {
  let up = false;
  try {
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), 1500);
    // Any HTTP answer (incl. the 302 → /login redirect) means the app is up.
    const r = await fetch(ODYSSEUS_URL, { signal: ctl.signal, redirect: "manual" });
    clearTimeout(tid);
    up = r.status > 0;
  } catch { /* container down / colima not running */ }
  return Response.json({ up, url: ODYSSEUS_URL });
}
