// Mission Planner — turns (capability, prompt) into a task graph at mission
// creation time. Planners are plugin modules in src/lib/planners/, selected by
// the registry's `planner` field; adding a department = a JSON entry + a
// planner file + one line in PLANNERS below (static map so Next.js can bundle
// them). Capabilities with planner:null get a single task built from the
// registry entry. Hermes never plans task graphs — the kernel does.
import type { Capability } from "@/lib/capabilityRegistry";
import type { MissionTask } from "@/lib/missionStore";
import { plan as websitePlan } from "@/lib/planners/website";

export type PlannedTask = Omit<MissionTask, "state" | "attempts" | "evidence">;

const PLANNERS: Record<string, (prompt: string) => PlannedTask[]> = {
  website: websitePlan,
};

export function planMission(capability: string, cap: Capability, prompt: string): PlannedTask[] {
  const planner = cap.planner ? PLANNERS[cap.planner] : null;
  if (planner) return planner(prompt);
  return [{
    id: "t1",
    name: capability,
    prompt,
    executor: cap.executor,
    verifier: cap.verifier,
    verify: cap.verify,
    deps: [],
    maxAttempts: 2,
    timeoutMs: cap.timeoutMs ?? 30 * 60 * 1000,
  }];
}
