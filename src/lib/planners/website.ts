// Website planner — decomposes a website mission into the five build stages
// as kernel tasks with a dependency graph. Each task runs ONE stage via the
// proven driver (~/.hermes/scripts/website-build.sh <stage>), which does the
// GLM Code run + objective verify + .build-state append, so the kernel, the
// 5am cron, and manual runs all share one source of truth and already-done
// stages skip instantly.
import type { PlannedTask } from "@/lib/missionPlanner";

const DRIVER = "/Users/dylanthomas/.hermes/scripts/website-build.sh";
const STATE = "/Users/dylanthomas/optriva-website/.build-state";

// stage → [dependencies] — backend scaffold first, then payments and admin
// build on it, packaging needs the app complete, tests gate the lot.
const STAGES: { id: string; name: string; deps: string[] }[] = [
  { id: "stage1", name: "backend scaffold (FastAPI+Postgres+Alembic)", deps: [] },
  { id: "stage2", name: "onboarding + Stripe checkout/webhooks", deps: ["stage1"] },
  { id: "stage3", name: "admin panel + frontend build", deps: ["stage2"] },
  { id: "stage4", name: "docker-compose + Caddy + DEPLOY.md", deps: ["stage3"] },
  { id: "stage5", name: "test suite + verification", deps: ["stage4"] },
];

export function plan(prompt: string): PlannedTask[] {
  return STAGES.map((s) => ({
    id: s.id,
    name: s.name,
    prompt,
    executor: { kind: "shell", script: DRIVER, args: [s.id] },
    verifier: "command",
    // The driver only appends "<stage> done" after ITS verify command passed —
    // so this check means "stage ran AND its objective checks held".
    verify: `grep -q '^${s.id} done' ${STATE}`,
    deps: s.deps,
    maxAttempts: 2,
    timeoutMs: 50 * 60 * 1000,
  }));
}
