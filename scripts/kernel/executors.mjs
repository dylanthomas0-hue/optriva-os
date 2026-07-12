// Executor plugins, selected by executor.kind from the capability registry.
// Each returns a spawned child process; the dispatcher never knows what any
// of them do. Add a department = add an entry here + registry JSON.
import { spawn } from "node:child_process";

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

  // Whitelisted script path only — never an arbitrary shell string.
  shell(task) {
    const script = String(task.executor.script ?? "");
    if (!script.startsWith(`${HOME}/.hermes/scripts/`) && !script.startsWith(`${HOME}/.agentic-os/scripts/`)) {
      throw new Error(`shell executor: script outside whitelist: ${script}`);
    }
    return sh("/bin/bash", [script]);
  },
};
