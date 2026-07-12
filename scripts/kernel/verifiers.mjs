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
  // "verified" requires BOTH: git HEAD moved since the driver's before-snapshot
  // (something actually changed, not a no-op run) AND the rebuild produced a
  // non-trivial bundle (a broken build after "improvements" is a rejection).
  "website-redesign"(task, ctx) {
    const repo = "/Users/dylanthomas/optriva-website";
    const evidence = [];
    try {
      const before = readFileSync(`${repo}/.redesign-before-head`, "utf8").trim();
      const after = runCheck(`cd ${repo} && git rev-parse HEAD`).trim();
      if (before === after) {
        return { verdict: "rejected", error: "git HEAD unchanged — no commit was made, no real work done", evidence };
      }
      evidence.push({ type: "commit", value: `${before.slice(0, 7)} → ${after.slice(0, 7)}`, capturedAt: Date.now() });

      const bundleStat = statSync(`${repo}/frontend/build/static/js`, { throwIfNoEntry: false });
      const idx = statSync(`${repo}/frontend/build/index.html`, { throwIfNoEntry: false });
      if (!idx || !bundleStat) {
        return { verdict: "rejected", error: "frontend/build missing or incomplete after rebuild — build likely failed", evidence };
      }
      const rebuildLog = readFileSync(`${repo}/build/redesign-rebuild.log`, "utf8");
      if (/Failed to compile|error TS|SyntaxError/i.test(rebuildLog)) {
        return { verdict: "rejected", error: "rebuild log shows compile errors", evidence: [...evidence, { type: "log", value: rebuildLog.slice(-1000), capturedAt: Date.now() }] };
      }
      evidence.push({ type: "log", value: "frontend rebuilt successfully — NOT deployed to production; review then deploy manually", capturedAt: Date.now() });
      return { verdict: "verified", evidence };
    } catch (e) {
      return { verdict: "rejected", error: String(e.message).slice(-400), evidence };
    }
  },
};
