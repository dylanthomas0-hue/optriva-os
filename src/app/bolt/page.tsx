"use client";

import { useEffect, useState } from "react";

// Bolt.DIY runs its own dev server on :5173 and boots an in-browser WebContainer
// for live build + preview. WebContainers need the *hosting* document to be
// cross-origin-isolated (SharedArrayBuffer). We set COOP/COEP for /bolt in
// next.config.ts, but a client-side (SPA) navigation into /bolt won't apply those
// response headers — so if we land here un-isolated, force one hard reload to
// re-fetch /bolt fresh with the headers in effect. This is what makes the iframe
// actually work (previously the framed preview couldn't boot its WebContainer).
// Use 127.0.0.1 (not "localhost") to match bolt.diy's exact IPv4 bind — some browsers
// resolve "localhost" to IPv6 ::1 first, where the Vite server isn't listening, giving
// an in-iframe "can't connect". 127.0.0.1 removes that resolution ambiguity.
const BOLT_URL = "http://127.0.0.1:5173/";
const RELOAD_FLAG = "bolt-coi-reload";

export default function BoltRoute() {
  const [state, setState] = useState<"loading" | "ready" | "stuck">("loading");

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.crossOriginIsolated) {
      sessionStorage.removeItem(RELOAD_FLAG);
      setState("ready");
      return;
    }
    // Not isolated (almost always because we arrived via client-side nav). Hard-reload
    // once so the COEP/COOP headers on /bolt take effect.
    if (!sessionStorage.getItem(RELOAD_FLAG)) {
      sessionStorage.setItem(RELOAD_FLAG, "1");
      window.location.reload();
      return;
    }
    // Reloaded once and still not isolated — don't loop; offer the pop-out instead.
    setState("stuck");
  }, []);

  if (state === "loading") {
    return <div style={{ padding: 24, opacity: 0.7 }}>Preparing Bolt.DIY…</div>;
  }

  if (state === "stuck") {
    return (
      <div style={{ padding: 24, lineHeight: 1.7 }}>
        <p style={{ fontWeight: 600, marginBottom: 8 }}>Bolt.DIY couldn’t enter isolated mode.</p>
        <p style={{ opacity: 0.75, marginBottom: 12, maxWidth: 560 }}>
          Its live preview needs a cross-origin-isolated page and this browser didn’t grant it.
          You can still use Bolt.DIY in its own tab:
        </p>
        <a
          href={BOLT_URL}
          target="_blank"
          rel="noreferrer"
          style={{ color: "#38bdf8", textDecoration: "underline" }}
        >
          Open Bolt.DIY at localhost:5173 ↗
        </a>
      </div>
    );
  }

  return (
    <iframe
      src={BOLT_URL}
      title="Bolt.DIY"
      // cross-origin-isolated delegates SharedArrayBuffer to the :5173 iframe so its
      // WebContainer boots; the rest are conveniences bolt.diy uses.
      allow="cross-origin-isolated; clipboard-read; clipboard-write; fullscreen"
      style={{
        width: "100%",
        height: "calc(100vh - 9rem)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 12,
        background: "#0b0b0f",
        display: "block",
      }}
    />
  );
}
