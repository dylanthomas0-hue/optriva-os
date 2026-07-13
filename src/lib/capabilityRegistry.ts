// Capability Registry — fully data-driven department definitions in
// ~/.agentic-os/capabilities.json. Adding a department = one JSON entry (plus
// planner/verifier plugins if it needs custom ones); no kernel code changes.
// The missiond dispatcher (plain node) reads the same file.
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { AGENTIC_ROOT } from "@/lib/eventBus";

export const CAPABILITIES_FILE = path.join(AGENTIC_ROOT, "capabilities.json");

export interface Capability {
  match: string[];                                  // keywords that route a prompt here
  planner: string | null;                           // planner plugin name (Phase 4) or null = single task
  verifier: string;                                 // verifier plugin name in scripts/kernel/verifiers/
  verify?: string;                                  // default shell check for command-style verifiers
  executor: { kind: string; [k: string]: unknown }; // executor plugin + its config
  schedulerPool: string;
  priority: "high" | "normal" | "low";
  timeoutMs?: number;
  enabled?: boolean;                                 // false = feature-flagged off; routeIntent skips it entirely
}

export interface Registry {
  _scheduler: {
    pools: Record<string, number>;                  // max concurrent tasks per pool
    global: number;
    minFreeMemMB: number;
    maxLoadPerCore: number;
    dailyBudget: Record<string, number>;            // max executor launches per pool per day
  };
  capabilities: Record<string, Capability>;
}

// Seeded on first load so a fresh machine works; afterwards the JSON file is
// the single source of truth — edit it, don't edit this seed.
const DEFAULT_REGISTRY: Registry = {
  _scheduler: {
    pools: { openclaw: 2, hermes: 2, shell: 2 },
    global: 2,
    minFreeMemMB: 1024,
    maxLoadPerCore: 1.5,
    dailyBudget: { openclaw: 100, hermes: 100, shell: 200 },
  },
  capabilities: {
    // Checked before "website" — more specific match phrases, so a redesign
    // request never falls through to the build pipeline (which would just
    // re-verify already-done stages and report false success instantly).
    "website-redesign": {
      match: ["improve the website", "improve website", "redesign the website", "redesign website",
        "revamp the website", "website animations", "website look", "website design",
        "polish the website", "enhance the website", "upgrade the website design"],
      planner: null,
      verifier: "website-redesign",
      executor: { kind: "shell", script: "/Users/dylanthomas/.hermes/scripts/website-redesign.sh" },
      schedulerPool: "hermes",
      priority: "normal",
      timeoutMs: 45 * 60 * 1000,
    },
    website: {
      match: ["website", "optriva site", "landing page", "web site", "deploy the site"],
      planner: "website",
      verifier: "website",
      executor: { kind: "hermes-cron", job: "c6cce5cc4875" },
      schedulerPool: "hermes",
      priority: "normal",
      timeoutMs: 3 * 60 * 60 * 1000,
    },
    // Checked before "automation" — searches n8n.io's real template library
    // (nodes/connections a model would otherwise hallucinate) and imports the
    // best free match into the local n8n instance, inactive for review.
    "n8n-workflow": {
      match: ["n8n", "build a workflow", "build me a workflow", "create a workflow", "make a workflow",
        "n8n workflow", "n8n automation"],
      planner: null,
      verifier: "n8n",
      executor: { kind: "n8n" },
      schedulerPool: "shell",
      priority: "normal",
      timeoutMs: 3 * 60 * 1000,
    },
    // Checked before "automation" — free, self-hosted (Scrapling), tries
    // plain HTTP first and only escalates to a real stealth browser if the
    // page looks blocked/empty, so most scrapes never pay for a browser.
    "web-scrape": {
      match: ["scrape", "scrape this", "scrape the", "scrape a website", "extract data from"],
      planner: null,
      verifier: "web-scrape",
      executor: { kind: "scrapling" },
      schedulerPool: "shell",
      priority: "normal",
      timeoutMs: 2 * 60 * 1000,
    },
    // Disabled 2026-07-13: a real test (research task via `openclaw agent`)
    // hung for 5+ minutes at 0% CPU with zero output — no evidence anywhere of
    // OpenClaw completing a real mission (its session logs are all smoke
    // tests). Feature-flagged off until it's proven with repeated successful
    // runs; routeIntent skips disabled capabilities entirely, so prompts that
    // would've matched this just fall through to normal chat instead.
    automation: {
      match: ["automate", "automation", "monitor", "schedule a", "set up a job"],
      planner: null,
      verifier: "log",
      executor: { kind: "openclaw", agent: "main" },
      schedulerPool: "openclaw",
      priority: "normal",
      timeoutMs: 15 * 60 * 1000,
      enabled: false,
    },
    research: {
      match: ["research", "look up", "look into", "find out", "compare prices", "market research"],
      planner: null,
      verifier: "log",
      executor: { kind: "hermes-oneshot", tools: "web" },
      schedulerPool: "hermes",
      priority: "low",
      timeoutMs: 15 * 60 * 1000,
    },
  },
};

let _cache: { registry: Registry; mtime: number } | null = null;

export function loadRegistry(): Registry {
  try {
    if (!existsSync(CAPABILITIES_FILE)) {
      mkdirSync(AGENTIC_ROOT, { recursive: true });
      writeFileSync(CAPABILITIES_FILE, JSON.stringify(DEFAULT_REGISTRY, null, 2), "utf8");
    }
    const stat = statSync(CAPABILITIES_FILE);
    if (_cache && _cache.mtime === stat.mtimeMs) return _cache.registry;
    const registry = JSON.parse(readFileSync(CAPABILITIES_FILE, "utf8")) as Registry;
    _cache = { registry, mtime: stat.mtimeMs };
    return registry;
  } catch {
    return DEFAULT_REGISTRY;
  }
}
