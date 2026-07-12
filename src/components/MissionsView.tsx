"use client";

// Missions tab — live board for the execution kernel. Initial load from
// GET /api/missions, then instant updates via the SSE event stream (any
// kernel event = refetch; the store is tiny). Drawer shows the task graph,
// verifier evidence, log tail, and an event Replay timeline.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Rocket, RefreshCw, X, CheckCircle2, XCircle, Clock, Loader2, PauseCircle,
  RotateCcw, Archive, FileText, ListTree, History, PlayCircle, ShieldCheck,
} from "lucide-react";

interface Evidence { type: string; value: string; capturedAt: number; }
interface Task {
  id: string; name: string; state: string; deps: string[]; attempts: number;
  maxAttempts: number; executor: { kind: string }; verifier: string;
  evidence: Evidence[]; startedAt?: number; finishedAt?: number; error?: string;
}
interface Mission {
  id: string; title: string; prompt: string; capability: string; source: string;
  priority: string; state: string; tasks: Task[]; createdAt: number;
  startedAt?: number; finishedAt?: number;
  history: { state: string; at: number; note?: string }[];
}
interface KernelEvent { ts: number; type: string; missionId: string; taskId?: string; data?: Record<string, unknown>; }

const COLUMNS: { key: string; label: string; states: string[] }[] = [
  { key: "queued",   label: "Queued",   states: ["queued"] },
  { key: "running",  label: "Running",  states: ["assigned", "running", "retrying", "waiting"] },
  { key: "verified", label: "Verified", states: ["completed", "verified"] },
  { key: "done",     label: "Closed · Failed", states: ["closed", "failed"] },
];

const STATE_COLOUR: Record<string, string> = {
  queued: "#94a3b8", assigned: "#7dd3fc", running: "#38bdf8", retrying: "#fbbf24",
  waiting: "#f97316", completed: "#a3e635", verified: "#4ade80", closed: "#64748b", failed: "#f87171",
};

function StateBadge({ state }: { state: string }) {
  const c = STATE_COLOUR[state] ?? "#94a3b8";
  const Icon = state === "verified" || state === "completed" ? CheckCircle2
    : state === "failed" ? XCircle
    : state === "running" || state === "assigned" ? Loader2
    : state === "waiting" ? PauseCircle
    : state === "retrying" ? RotateCcw : Clock;
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide"
      style={{ color: c, background: `${c}1f`, border: `1px solid ${c}44` }}>
      <Icon size={11} className={state === "running" || state === "assigned" ? "animate-spin" : ""} />{state}
    </span>
  );
}

function fmtAgo(ts?: number): string {
  if (!ts) return "—";
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function fmtElapsed(t: Task): string {
  if (!t.startedAt) return "";
  const end = t.finishedAt ?? Date.now();
  const s = Math.floor((end - t.startedAt) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

export default function MissionsView() {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ mission: Mission; log: string } | null>(null);
  const [replay, setReplay] = useState<KernelEvent[] | null>(null);
  const [replayStep, setReplayStep] = useState(0);
  const [tab, setTab] = useState<"tasks" | "log" | "replay">("tasks");
  const [live, setLive] = useState(false);
  const openIdRef = useRef(openId);
  openIdRef.current = openId;

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/missions", { cache: "no-store" });
      const j = await r.json();
      setMissions(j.missions ?? []);
    } catch { /* dashboard restarting */ }
  }, []);

  const openDetail = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/missions/${id}`, { cache: "no-store" });
      if (r.ok) setDetail(await r.json());
    } catch { /* transient */ }
  }, []);

  // Initial load + SSE: any kernel event refreshes the board (and the open
  // drawer, if the event is about it). EventSource auto-reconnects.
  useEffect(() => {
    refresh();
    const es = new EventSource("/api/missions/events");
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as KernelEvent;
        if (ev.type.startsWith("sse.")) return;
        refresh();
        if (openIdRef.current && ev.missionId === openIdRef.current) openDetail(openIdRef.current);
      } catch { /* ignore malformed */ }
    };
    return () => es.close();
  }, [refresh, openDetail]);

  useEffect(() => {
    if (!openId) { setDetail(null); setReplay(null); setTab("tasks"); return; }
    openDetail(openId);
  }, [openId, openDetail]);

  const loadReplay = useCallback(async () => {
    if (!openId) return;
    const r = await fetch(`/api/missions/${openId}?replay=1`, { cache: "no-store" });
    const j = await r.json();
    setReplay(j.events ?? []);
    setReplayStep(0);
  }, [openId]);

  const act = useCallback(async (id: string, action: "retry" | "close") => {
    await fetch(`/api/missions/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
    refresh();
    if (openIdRef.current === id) openDetail(id);
  }, [refresh, openDetail]);

  const m = detail?.mission;
  return (
    <div className="p-5 h-full flex flex-col gap-4 overflow-hidden">
      <header className="flex items-center gap-3">
        <Rocket size={20} className="text-[#4ade80]" />
        <h1 className="text-[18px] font-semibold tracking-tight text-[var(--fg)]">Missions</h1>
        <span className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full border ${live ? "text-[#4ade80] border-[#4ade8055] bg-[#4ade8014]" : "text-[var(--fg-dimmer)] border-[var(--panel-border)]"}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${live ? "bg-[#4ade80]" : "bg-[var(--fg-dimmer)]"}`} />
          {live ? "live" : "reconnecting…"}
        </span>
        <button onClick={refresh} className="ml-auto p-1.5 rounded-md border border-[var(--panel-border)] text-[var(--fg-dim)] hover:text-[var(--fg)]" title="Refresh">
          <RefreshCw size={14} />
        </button>
      </header>

      <div className="grid grid-cols-4 gap-3 flex-1 min-h-0">
        {COLUMNS.map((col) => {
          const items = missions.filter((mi) => col.states.includes(mi.state));
          return (
            <section key={col.key} className="flex flex-col min-h-0 rounded-xl border border-[var(--panel-border)] bg-[rgba(255,255,255,0.02)]">
              <div className="px-3 py-2 flex items-center justify-between border-b border-[var(--panel-border)]">
                <span className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--fg-dim)]">{col.label}</span>
                <span className="text-[11px] text-[var(--fg-dimmer)]">{items.length}</span>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {items.map((mi) => (
                  <button key={mi.id} onClick={() => setOpenId(mi.id)}
                    className="w-full text-left rounded-lg border border-[var(--panel-border)] bg-[rgba(0,0,0,0.25)] p-2.5 hover:border-[var(--panel-border-hot)] transition-colors">
                    <div className="flex items-center gap-2 mb-1.5">
                      <StateBadge state={mi.state} />
                      <span className="text-[10.5px] text-[var(--fg-dimmer)] uppercase tracking-wide">{mi.capability}</span>
                      {mi.priority === "high" && <span className="text-[10px] text-[#f87171]">high</span>}
                    </div>
                    <div className="text-[13px] text-[var(--fg)] leading-snug line-clamp-2">{mi.title}</div>
                    <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-[var(--fg-dimmer)]">
                      <span>{mi.tasks.filter((t) => t.state === "verified").length}/{mi.tasks.length} tasks</span>
                      <span>·</span><span>{fmtAgo(mi.createdAt)}</span>
                      <span className="ml-auto font-[var(--font-geist-mono)]">{mi.id.slice(0, 10)}</span>
                    </div>
                  </button>
                ))}
                {!items.length && <div className="text-[11.5px] text-[var(--fg-dimmer)] text-center py-6">empty</div>}
              </div>
            </section>
          );
        })}
      </div>

      {m && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={() => setOpenId(null)}>
          <aside className="w-[560px] max-w-full h-full overflow-y-auto bg-[var(--panel,#16121f)] border-l border-[var(--panel-border)] p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3 mb-1">
              <StateBadge state={m.state} />
              <span className="text-[11px] text-[var(--fg-dimmer)] uppercase tracking-wide mt-0.5">{m.capability} · {m.source}</span>
              <button className="ml-auto p-1 text-[var(--fg-dim)] hover:text-[var(--fg)]" onClick={() => setOpenId(null)}><X size={16} /></button>
            </div>
            <h2 className="text-[15px] font-semibold text-[var(--fg)] leading-snug mb-1">{m.title}</h2>
            <div className="text-[11px] text-[var(--fg-dimmer)] mb-3 font-[var(--font-geist-mono)]">{m.id} · created {fmtAgo(m.createdAt)}</div>

            <div className="flex gap-2 mb-4">
              {(m.state === "failed" || m.state === "waiting") && (
                <button onClick={() => act(m.id, "retry")} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] border border-[#fbbf2455] text-[#fbbf24] hover:bg-[#fbbf2414]">
                  <RotateCcw size={12} /> Retry
                </button>
              )}
              {m.state !== "closed" && (
                <button onClick={() => act(m.id, "close")} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] border border-[var(--panel-border)] text-[var(--fg-dim)] hover:text-[var(--fg)]">
                  <Archive size={12} /> Close
                </button>
              )}
            </div>

            <div className="flex gap-1 mb-3 border-b border-[var(--panel-border)]">
              {([["tasks", "Tasks", ListTree], ["log", "Log", FileText], ["replay", "Replay", History]] as const).map(([key, label, Icon]) => (
                <button key={key}
                  onClick={() => { setTab(key); if (key === "replay" && !replay) loadReplay(); }}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] border-b-2 -mb-px ${tab === key ? "border-[#4ade80] text-[var(--fg)]" : "border-transparent text-[var(--fg-dim)] hover:text-[var(--fg)]"}`}>
                  <Icon size={12} />{label}
                </button>
              ))}
            </div>

            {tab === "tasks" && (
              <div className="space-y-2.5">
                {m.tasks.map((t) => (
                  <div key={t.id} className="rounded-lg border border-[var(--panel-border)] p-3" style={{ marginLeft: t.deps.length ? 16 : 0 }}>
                    <div className="flex items-center gap-2">
                      <StateBadge state={t.state} />
                      <span className="text-[12.5px] font-medium text-[var(--fg)]">{t.name}</span>
                      <span className="text-[10.5px] text-[var(--fg-dimmer)]">{t.executor.kind}</span>
                      <span className="ml-auto text-[10.5px] text-[var(--fg-dimmer)]">{fmtElapsed(t)}</span>
                    </div>
                    {t.deps.length > 0 && <div className="mt-1 text-[10.5px] text-[var(--fg-dimmer)]">after: {t.deps.join(", ")}</div>}
                    {t.attempts > 0 && <div className="mt-1 text-[10.5px] text-[#fbbf24]">attempt {t.attempts}/{t.maxAttempts}</div>}
                    {t.error && <div className="mt-1.5 text-[11px] text-[#f87171] font-[var(--font-geist-mono)] whitespace-pre-wrap break-all">{t.error.slice(0, 300)}</div>}
                    {t.evidence.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {t.evidence.map((e, i) => (
                          <div key={i} className="flex items-start gap-1.5 text-[11px] text-[var(--fg-dim)]">
                            <ShieldCheck size={11} className="text-[#4ade80] mt-0.5 shrink-0" />
                            <span className="uppercase text-[9.5px] tracking-wide text-[#4ade80] mt-0.5">{e.type}</span>
                            {e.type === "url"
                              ? <a href={e.value} target="_blank" rel="noopener noreferrer" className="text-[var(--accent-cyan,#67e8f9)] hover:underline break-all">{e.value}</a>
                              : <span className="font-[var(--font-geist-mono)] whitespace-pre-wrap break-all">{e.value.slice(0, 240)}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {tab === "log" && (
              <pre className="rounded-lg border border-[var(--panel-border)] bg-[rgba(0,0,0,0.45)] p-3 text-[11px] leading-relaxed font-[var(--font-geist-mono)] whitespace-pre-wrap break-all text-[var(--fg-dim)]">
                {detail?.log || "(no output yet)"}
              </pre>
            )}

            {tab === "replay" && (
              <div>
                {!replay ? (
                  <div className="text-[12px] text-[var(--fg-dimmer)]">loading events…</div>
                ) : (
                  <>
                    <div className="flex items-center gap-2 mb-3">
                      <button onClick={() => setReplayStep(0)} className="px-2 py-1 rounded border border-[var(--panel-border)] text-[11px] text-[var(--fg-dim)]">⏮</button>
                      <button onClick={() => setReplayStep((s) => Math.min(s + 1, replay.length))}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-[#4ade8055] text-[#4ade80] text-[11px]">
                        <PlayCircle size={12} /> step
                      </button>
                      <span className="text-[11px] text-[var(--fg-dimmer)]">{replayStep}/{replay.length} events</span>
                    </div>
                    <ol className="space-y-1">
                      {replay.slice(0, replayStep === 0 ? replay.length : replayStep).map((ev, i) => (
                        <li key={i} className="flex items-start gap-2 text-[11px]">
                          <span className="text-[var(--fg-dimmer)] font-[var(--font-geist-mono)] shrink-0">{new Date(ev.ts).toLocaleTimeString()}</span>
                          <span className="text-[var(--fg)] font-medium shrink-0">{ev.type}</span>
                          <span className="text-[var(--fg-dim)] break-all">{ev.data ? JSON.stringify(ev.data).slice(0, 140) : ""}</span>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
