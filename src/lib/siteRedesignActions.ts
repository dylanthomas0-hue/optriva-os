// Approve & Deploy / Discard for the website-redesign capability. Every
// redesign runs in its own git worktree/branch under
// ~/.agentic-os/site-redesign/ (see ~/.hermes/scripts/website-redesign.sh) —
// nothing touches the live optriva-website repo until one of these two
// actions is explicitly invoked from the Missions tab.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getMission, type Mission, type MissionTask } from "@/lib/missionStore";

const execFileAsync = promisify(execFile);
const REPO = "/Users/dylanthomas/optriva-website";

function findRedesignTask(mission: Mission): MissionTask | undefined {
  return mission.tasks.find((t) => t.verifier === "website-redesign");
}

function extractBranchAndWorktree(task: MissionTask): { branch: string; worktree: string } | null {
  const commitEv = task.evidence.find((e) => e.type === "commit" && e.value.startsWith("redesign/"));
  const fileEv = task.evidence.find((e) => e.type === "file" && e.value.startsWith("worktree: "));
  if (!commitEv || !fileEv) return null;
  const branch = commitEv.value.split(" — ")[0].trim();
  const worktree = fileEv.value.replace("worktree: ", "").trim();
  // Belt-and-braces: only ever act on paths/branches this system itself created.
  if (!branch.startsWith("redesign/") || !worktree.startsWith("/Users/dylanthomas/.agentic-os/site-redesign/")) return null;
  return { branch, worktree };
}

async function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return stdout + stderr;
}

export async function deployWebsiteRedesign(id: string): Promise<{ ok: boolean; log: string }> {
  const mission = await getMission(id);
  if (!mission) return { ok: false, log: "mission not found" };
  const task = findRedesignTask(mission);
  if (!task || task.state !== "verified") return { ok: false, log: "no verified website-redesign task on this mission" };
  const info = extractBranchAndWorktree(task);
  if (!info) return { ok: false, log: "could not resolve branch/worktree from task evidence" };
  let log = "";
  try {
    log += await run("git", ["-C", REPO, "merge", "--no-ff", "--no-edit", info.branch], 60_000);
    log += await run("/bin/bash", [`${REPO}/deploy-vps.sh`], 10 * 60_000);
    return { ok: true, log };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, log: (log + (err.stdout ?? "") + (err.stderr ?? "") + (err.message ?? "")).slice(-4000) };
  }
}

export async function discardWebsiteRedesign(id: string): Promise<{ ok: boolean; log: string }> {
  const mission = await getMission(id);
  if (!mission) return { ok: false, log: "mission not found" };
  const task = findRedesignTask(mission);
  if (!task) return { ok: false, log: "no website-redesign task on this mission" };
  const info = extractBranchAndWorktree(task);
  if (!info) return { ok: false, log: "could not resolve branch/worktree from task evidence" };
  let log = "";
  try {
    log += await run("git", ["-C", REPO, "worktree", "remove", "--force", info.worktree], 30_000);
    log += await run("git", ["-C", REPO, "branch", "-D", info.branch], 30_000);
    return { ok: true, log };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, log: (log + (err.stdout ?? "") + (err.stderr ?? "") + (err.message ?? "")).slice(-4000) };
  }
}

export function redesignWorktree(task: MissionTask): string | null {
  return extractBranchAndWorktree(task)?.worktree ?? null;
}
