// Code-based intent router: decides in <1ms whether a chat message is a task
// to dispatch (→ mission queue) or conversation (→ normal Hermes chat). No
// LLM, no tokens. Biased hard against false positives: a question routed to
// the queue is far worse than a task answered conversationally — the user can
// always say "build it" to dispatch.
import { loadRegistry, type Capability } from "@/lib/capabilityRegistry";

export interface Route {
  capability: string;
  cap: Capability;
  matched: string;   // which keyword hit — logged so misfires are debuggable
}

// A dispatchable message must START with (or contain right after a greeting)
// a task-imperative verb. "how do I build a website?" must not match.
const IMPERATIVE = /^(?:please\s+|can you\s+|could you\s+)?(build|create|make|deploy|launch|fix|update|rebuild|redeploy|automate|schedule|monitor|scrape|research|generate|set up|setup|run)\b/i;

// Hard conversational guards — any of these means "talk, don't dispatch".
const QUESTION = /^(what|why|how|when|where|who|which|is|are|was|were|am|do|does|did|can|could|should|would|will|has|have|tell me|explain)\b/i;

export function routeIntent(prompt: string): Route | null {
  const p = prompt.trim();
  if (p.length < 8 || p.length > 2000) return null;
  if (QUESTION.test(p) || p.endsWith("?")) return null;
  if (!IMPERATIVE.test(p)) return null;

  const lower = p.toLowerCase();
  const { capabilities } = loadRegistry();
  for (const [name, cap] of Object.entries(capabilities)) {
    for (const kw of cap.match) {
      if (lower.includes(kw.toLowerCase())) return { capability: name, cap, matched: kw };
    }
  }
  return null;
}
