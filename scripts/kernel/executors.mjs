// Executor plugins, selected by executor.kind from the capability registry.
// Each returns a spawned child process; the dispatcher never knows what any
// of them do. Add a department = add an entry here + registry JSON.
import { spawn } from "node:child_process";
import path from "node:path";

const HOME = process.env.HOME ?? "/Users/dylanthomas";
// launchd starts daemons with a minimal PATH — make sure the CLIs resolve.
const ENV = {
  ...process.env,
  PATH: `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
};

function sh(cmd, args) {
  return spawn(cmd, args, { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
}

export const executors = {
  // Persistent OpenClaw service: `openclaw agent` WITHOUT --local runs the
  // turn via the always-on gateway (launchd ai.openclaw.gateway :18789) — the
  // CLI is just a thin client, so there's no per-mission agent startup.
  openclaw(task) {
    return sh("openclaw", ["agent", "--agent", task.executor.agent ?? "main", "-m", task.prompt, "--json"]);
  },

  // Pre-approved Hermes cron job (script mode) — e.g. the website-build.sh
  // driver. The job id lives in registry data, never in code.
  "hermes-cron"(task) {
    return sh("hermes", ["cron", "run", String(task.executor.job), "--accept-hooks"]);
  },

  // One-shot Hermes agent run with a restricted toolset.
  "hermes-oneshot"(task) {
    return sh("hermes", ["-z", task.prompt, "-t", task.executor.tools ?? "web", "--yolo", "--accept-hooks"]);
  },

  // Whitelisted script path only — never an arbitrary shell string. Optional
  // executor.args are passed as separate argv entries (no shell interpolation).
  shell(task) {
    const script = String(task.executor.script ?? "");
    if (!script.startsWith(`${HOME}/.hermes/scripts/`) && !script.startsWith(`${HOME}/.agentic-os/scripts/`)) {
      throw new Error(`shell executor: script outside whitelist: ${script}`);
    }
    const args = Array.isArray(task.executor.args) ? task.executor.args.map(String) : [];
    return sh("/bin/bash", [script, ...args]);
  },

  // n8n workflow import: searches n8n.io's real template library for the
  // best free match to the mission prompt and creates it (inactive) in the
  // local n8n instance — see n8n-import.mjs for why templates beat asking a
  // model to author n8n's node schema from scratch.
  n8n(task) {
    const script = path.join(HOME, "agent-os", "source", "scripts", "kernel", "n8n-import.mjs");
    return sh("node", [script, task.prompt]);
  },
};
