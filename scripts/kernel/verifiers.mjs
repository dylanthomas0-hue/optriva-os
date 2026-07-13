// Verifier plugins — the anti-"agent claims success" gate. An executor
// exiting 0 means nothing; only a passing check can mark a task verified
// (the glm-5.2 website conductor once marked a stage done without doing any
// work — this is the structural fix). Each plugin returns
// { verdict: "verified"|"rejected"|"retry"|"escalate", evidence: [], error? }.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const HOME = process.env.HOME ?? "/Users/dylanthomas";

function runCheck(cmd) {
  // Verify commands come from the capability registry / planner files (owner-
  // edited config, same trust level as the scripts they verify), not from
  // model output.
  return execFileSync("/bin/bash", ["-c", cmd], { encoding: "utf8", timeout: 5 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
}

export const verifiers = {
  // Generic: run the task's verify command; exit 0 = verified.
  command(task) {
    if (!task.verify) return { verdict: "rejected", error: "no verify command declared — cannot verify, will not trust exit code" };
    try {
      const out = runCheck(task.verify);
      return { verdict: "verified", evidence: [{ type: "test", value: `${task.verify} → OK\n${out.slice(-400)}`, capturedAt: Date.now() }] };
    } catch (e) {
      return { verdict: "rejected", error: String(e.stdout || e.stderr || e.message).slice(-800) };
    }
  },

  // Weak-but-real check for agent runs whose only artifact is their output:
  // the executor must have exited 0 AND produced substantive output.
  log(task, { exitCode, logTail }) {
    if (exitCode !== 0) return { verdict: "rejected", error: `executor exit ${exitCode}` };
    if (!logTail || logTail.trim().length < 80) return { verdict: "rejected", error: "no substantive output produced" };
    return { verdict: "verified", evidence: [{ type: "log", value: logTail.slice(-1000), capturedAt: Date.now() }] };
  },

  // Website pipeline: the driver's state file + built frontend are the truth.
  website(task, ctx) {
    const repo = "/Users/dylanthomas/optriva-website";
    const evidence = [];
    try {
      const state = readFileSync(`${repo}/.build-state`, "utf8");
      const done = (state.match(/^stage\d+ done/gm) ?? []).length;
      evidence.push({ type: "file", value: `.build-state: ${done}/5 stages done`, capturedAt: Date.now() });
      if (done < 5) return { verdict: "rejected", error: `only ${done}/5 stages verified in .build-state`, evidence };
      statSync(`${repo}/frontend/build/index.html`);
      evidence.push({ type: "file", value: `${repo}/frontend/build/index.html exists`, capturedAt: Date.now() });
      try {
        const commit = runCheck(`cd ${repo} && git rev-parse --short HEAD`).trim();
        evidence.push({ type: "commit", value: commit, capturedAt: Date.now() });
      } catch { /* repo may have no commits yet — the two file checks above carry the verdict */ }
      return { verdict: "verified", evidence };
    } catch (e) {
      // A half-built site is retryable (driver resumes from .build-state);
      // escalate only comes from the dispatcher when attempts run out.
      return { verdict: "rejected", error: String(e.message).slice(-400), evidence };
    }
  },

  // Frontend redesign: real work + a working build, not an executor's word.
  // Runs entirely in an isolated git worktree/branch (never the main working
  // tree) — "verified" requires BOTH: the worktree's HEAD moved since its own
  // before-snapshot (something actually changed, not a no-op run) AND the
  // rebuild produced a non-trivial bundle (a broken build after "improvements"
  // is a rejection). Evidence carries the branch/worktree so the dashboard can
  // offer a real preview + an explicit Approve & Deploy action — nothing here
  // touches the live site.
  "website-redesign"(task, ctx) {
    const evidence = [];
    const m = (ctx.logTail || "").match(/REDESIGN_ID::(\S+)/);
    if (!m) return { verdict: "rejected", error: "no REDESIGN_ID found in output — driver did not reach completion", evidence };
    const id = m[1];
    const worktree = `/Users/dylanthomas/.agentic-os/site-redesign/${id}`;
    const branch = `redesign/${id}`;
    try {
      const before = readFileSync(`${worktree}/.redesign-before-head`, "utf8").trim();
      const after = runCheck(`cd ${worktree} && git rev-parse HEAD`).trim();
      if (before === after) {
        return { verdict: "rejected", error: "git HEAD unchanged in worktree — no commit was made, no real work done", evidence };
      }
      evidence.push({ type: "commit", value: `${branch} — ${before.slice(0, 7)} → ${after.slice(0, 7)}`, capturedAt: Date.now() });
      evidence.push({ type: "file", value: `worktree: ${worktree}`, capturedAt: Date.now() });

      const bundleStat = statSync(`${worktree}/frontend/build/static/js`, { throwIfNoEntry: false });
      const idx = statSync(`${worktree}/frontend/build/index.html`, { throwIfNoEntry: false });
      if (!idx || !bundleStat) {
        return { verdict: "rejected", error: "frontend/build missing or incomplete after rebuild — build likely failed", evidence };
      }
      const rebuildLog = readFileSync(`${worktree}/redesign-rebuild.log`, "utf8");
      if (/Failed to compile|error TS|SyntaxError/i.test(rebuildLog)) {
        return { verdict: "rejected", error: "rebuild log shows compile errors", evidence: [...evidence, { type: "log", value: rebuildLog.slice(-1000), capturedAt: Date.now() }] };
      }
      evidence.push({ type: "url", value: `/api/missions/${ctx.missionId ?? ""}/preview/index.html`, capturedAt: Date.now() });
      evidence.push({ type: "log", value: "frontend rebuilt successfully in isolated worktree — NOT deployed; review the preview, then Approve & Deploy from the Missions tab", capturedAt: Date.now() });
      return { verdict: "verified", evidence };
    } catch (e) {
      return { verdict: "rejected", error: String(e.message).slice(-400), evidence };
    }
  },

  // n8n import: the executor's own stdout claiming success is worthless on
  // its own — this does a live GET back from n8n's API to confirm the
  // workflow actually exists with real, non-empty nodes (not an empty shell
  // that "created" successfully but imported nothing).
  n8n(task, { exitCode, logTail }) {
    const evidence = [];
    if (exitCode !== 0) return { verdict: "rejected", error: `importer exit ${exitCode}: ${String(logTail).slice(-400)}`, evidence };
    let record;
    try {
      record = JSON.parse(readFileSync(`${HOME}/.agentic-os/n8n/last-import.json`, "utf8"));
    } catch (e) {
      return { verdict: "rejected", error: `no last-import.json record: ${e.message}`, evidence };
    }
    evidence.push({ type: "log", value: `template #${record.templateId} "${record.templateName}" -> workflow ${record.workflowId}`, capturedAt: Date.now() });

    let cfg;
    try {
      cfg = JSON.parse(readFileSync(`${HOME}/.agentic-os/n8n/config.json`, "utf8"));
    } catch (e) {
      return { verdict: "rejected", error: `no n8n config: ${e.message}`, evidence };
    }
    try {
      const out = runCheck(`curl -sf "${cfg.baseUrl}/api/v1/workflows/${record.workflowId}" -H "X-N8N-API-KEY: ${cfg.apiKey}"`);
      const live = JSON.parse(out);
      const nodeCount = (live.nodes || []).length;
      if (nodeCount === 0) return { verdict: "rejected", error: "workflow exists but has zero nodes", evidence };
      if (nodeCount !== record.nodeCount) {
        evidence.push({ type: "log", value: `node count mismatch: importer said ${record.nodeCount}, live shows ${nodeCount} — using live as truth`, capturedAt: Date.now() });
      }
      evidence.push({ type: "url", value: `${cfg.baseUrl}/workflow/${record.workflowId}`, capturedAt: Date.now() });
      return { verdict: "verified", evidence };
    } catch (e) {
      return { verdict: "rejected", error: `live GET failed — workflow may not actually exist: ${String(e.message).slice(-300)}`, evidence };
    }
  },

  // Scrapling scrape: the script's own exit code just means "didn't crash" —
  // this parses its final JSON line out of the log and requires real,
  // substantive extracted text, not an empty/blocked page that "succeeded".
  "web-scrape"(task, { exitCode, logTail }) {
    const evidence = [];
    if (exitCode !== 0) return { verdict: "rejected", error: `scraper exit ${exitCode}: ${String(logTail).slice(-400)}`, evidence };
    const lines = String(logTail).trim().split("\n");
    let record;
    for (let i = lines.length - 1; i >= 0; i--) {
      // Log lines are prefixed by the dispatcher (e.g. "[t1] {...}"), so find
      // the JSON payload within the line rather than requiring it to start there.
      const line = lines[i].trim();
      const start = line.indexOf("{");
      if (start === -1 || !line.endsWith("}")) continue;
      try { record = JSON.parse(line.slice(start)); break; } catch { /* keep scanning backwards */ }
    }
    if (!record) return { verdict: "rejected", error: "no JSON result line found in scraper output", evidence };
    evidence.push({ type: "url", value: record.url, capturedAt: Date.now() });
    evidence.push({ type: "log", value: `fetcher=${record.fetcherUsed} status=${record.statusCode} title="${record.title}" textLength=${record.textLength}`, capturedAt: Date.now() });
    if (!record.textLength || record.textLength < 50) {
      return { verdict: "rejected", error: `only ${record.textLength || 0} chars extracted — likely blocked or empty page`, evidence };
    }
    return { verdict: "verified", evidence };
  },
};
