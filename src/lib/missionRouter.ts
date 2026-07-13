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
const IMPERATIVE = /^(?:please\s+|can you\s+|could you\s+)?(build|create|make|deploy|launch|fix|update|rebuild|redeploy|automate|schedule|monitor|scrape|research|generate|set up|setup|run|improve|redesign|revamp|enhance|upgrade|polish)\b/i;

// Hard conversational guards — any of these means "talk, don't dispatch".
const QUESTION = /^(what|why|how|when|where|who|which|is|are|was|were|am|do|does|did|can|could|should|would|will|has|have|tell me|explain)\b/i;

// A capability keyword mentioned deep in a prompt (e.g. "...might need a
// better website" inside a research request) is a much weaker signal than one
// appearing right after the imperative verb — pure substring matching treated
// those the same and let incidental nouns hijack unrelated requests (found via
// "research local businesses...that might need a better website" dispatching
// the whole website-build pipeline instead of research). Score every
// capability's best match by proximity to the verb instead of stopping at the
// first hit in registry order, and require a minimum confidence before
// dispatching — below it, fall through to normal conversational chat.
const PROXIMITY_WINDOW = 30;   // chars after the verb where a match still counts as the verb's object
const CONFIDENCE_THRESHOLD = 0.3;

export function routeIntent(prompt: string): Route | null {
  const p = prompt.trim();
  if (p.length < 8 || p.length > 2000) return null;
  if (QUESTION.test(p) || p.endsWith("?")) return null;
  const verbMatch = p.match(IMPERATIVE);
  if (!verbMatch) return null;
  const verbEnd = verbMatch[0].length;

  const lower = p.toLowerCase();
  const { capabilities } = loadRegistry();
  let best: (Route & { score: number }) | null = null;
  for (const [name, cap] of Object.entries(capabilities)) {
    if (cap.enabled === false) continue; // feature-flagged off — not proven reliable yet
    for (const kw of cap.match) {
      const idx = lower.indexOf(kw.toLowerCase());
      if (idx === -1) continue;
      const distance = Math.max(0, idx - verbEnd);
      const proximityScore = Math.max(0, 1 - distance / PROXIMITY_WINDOW);
      const specificityScore = Math.min(kw.length / 20, 1); // longer/more-specific keywords are stronger signals
      const score = proximityScore * 0.7 + specificityScore * 0.3;
      if (!best || score > best.score) best = { capability: name, cap, matched: kw, score };
    }
  }
  if (!best || best.score < CONFIDENCE_THRESHOLD) return null;
  return { capability: best.capability, cap: best.cap, matched: best.matched };
}
