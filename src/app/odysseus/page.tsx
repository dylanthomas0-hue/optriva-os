"use client";

import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";

// Odysseus runs in Docker on 127.0.0.1:7300. It is deliberately NOT iframed:
// its login sets SameSite=Lax session cookies, which browsers refuse to send on
// cross-origin iframe requests (3737 parent vs 7300 child) — login "succeeds"
// as a network call but never persists inside a frame. So this tab is a
// launcher that opens Odysseus in its own browser tab, where login works.
// (Re-added 2026-07-10 after the July update wiped the custom tab — this file
// is on the RE-APPLY-AFTER-UPDATE list.)

export default function OdysseusRoute() {
  const [status, setStatus] = useState<{ up: boolean; url: string } | null>(null);
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    try {
      const r = await fetch("/api/odysseus/status", { cache: "no-store" });
      setStatus(await r.json());
    } catch {
      setStatus({ up: false, url: "http://127.0.0.1:7300" });
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => { check(); }, []);

  const url = status?.url ?? "http://127.0.0.1:7300";

  return (
    <div style={{ padding: 24, lineHeight: 1.7, maxWidth: 640 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Odysseus</h1>
        <span
          style={{
            fontSize: 12, padding: "2px 10px", borderRadius: 999,
            background: status?.up ? "rgba(47,191,113,0.15)" : "rgba(239,68,68,0.15)",
            color: status?.up ? "#2fbf71" : "#ef4444",
          }}
        >
          {status === null ? "checking…" : status.up ? "online" : "offline"}
        </span>
        <button
          onClick={check}
          title="Re-check"
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--fg-dim)", opacity: checking ? 0.4 : 1 }}
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <p style={{ opacity: 0.75, marginBottom: 16 }}>
        Local AI workspace with sessions, memory, and web search (Docker, port 7300).
        It opens in its own browser tab — its login session can&apos;t survive inside an
        embedded frame, so embedding it here would leave you stuck at the login screen.
      </p>

      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          padding: "10px 18px", borderRadius: 10, textDecoration: "none",
          background: status?.up ? "rgba(56,189,248,0.16)" : "rgba(120,120,120,0.12)",
          border: `1px solid ${status?.up ? "#38bdf8" : "var(--panel-border)"}`,
          color: status?.up ? "#38bdf8" : "var(--fg-dim)", fontWeight: 600,
        }}
      >
        Open Odysseus <ExternalLink size={15} />
      </a>

      {!status?.up && status !== null && (
        <p style={{ marginTop: 16, fontSize: 13, opacity: 0.65 }}>
          Not running? Double-click <strong>Start Everything.command</strong> on the
          Desktop (it starts Colima + the Odysseus containers), or run{" "}
          <code>cd ~/odysseus &amp;&amp; docker compose up -d</code>.
        </p>
      )}
      <p style={{ marginTop: 8, fontSize: 13, opacity: 0.65 }}>
        Log in as <code>admin</code>. Memory syncs to the Obsidian vault via the{" "}
        <code>odysseus-memory-sync</code> skill.
      </p>
    </div>
  );
}
