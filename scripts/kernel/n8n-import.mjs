#!/usr/bin/env node
// n8n workflow importer — searches n8n.io's public template library (real,
// tested workflows) instead of asking a model to hallucinate n8n's node
// schema from scratch, which is a much less reliable source of truth. Picks
// the best free match, maps known credential types onto credentials that
// already exist in this n8n instance, and creates it INACTIVE so a human
// reviews before turning it on. Writes the result to last-import.json so the
// verifier can confirm real nodes/connections exist, not just a 2xx response.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const CFG_PATH = path.join(HOME, ".agentic-os", "n8n", "config.json");
const STATE_PATH = path.join(HOME, ".agentic-os", "n8n", "last-import.json");

const prompt = process.argv.slice(2).join(" ");
if (!prompt.trim()) {
  console.error("no prompt given");
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(CFG_PATH, "utf8"));

// Strip common request-phrasing so the search query is closer to the actual
// intent ("build me an n8n workflow that watches gmail" -> "watches gmail").
function toQuery(p) {
  return p
    .replace(/\b(please\s+|can you\s+|could you\s+)/gi, "")
    .replace(/\b(build|create|make|set up|setup)\s+(me\s+)?(an?\s+)?(n8n\s+)?(workflow|automation)\s*(that|to|for|which)?\s*/gi, "")
    .replace(/\bn8n\b/gi, "")
    .trim() || p;
}

async function main() {
  const query = toQuery(prompt);
  const searchUrl = `https://api.n8n.io/templates/search?q=${encodeURIComponent(query)}&rows=15`;
  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) throw new Error(`template search failed: ${searchRes.status}`);
  const searchJson = await searchRes.json();
  const candidates = (searchJson.workflows || []).filter((w) => !w.price);
  if (!candidates.length) throw new Error(`no free template matched "${query}"`);
  candidates.sort((a, b) => (b.totalViews || 0) - (a.totalViews || 0));
  const chosen = candidates[0];

  const detailRes = await fetch(`https://api.n8n.io/templates/workflows/${chosen.id}`);
  if (!detailRes.ok) throw new Error(`template detail fetch failed: ${detailRes.status}`);
  const detailJson = await detailRes.json();
  const wf = detailJson.workflow?.workflow;
  if (!wf?.nodes?.length) throw new Error(`template ${chosen.id} has no importable workflow body`);

  // n8n.io's template export adds marketplace-only fields (cid, creator, and
  // sometimes others) that aren't part of n8n's actual node schema — its
  // create-workflow API validates strictly and rejects "additional
  // properties", so only real node fields survive the round-trip.
  const NODE_FIELDS = new Set([
    "id", "name", "type", "typeVersion", "position", "parameters", "credentials",
    "disabled", "notes", "notesInFlow", "continueOnFail", "retryOnFail", "maxTries",
    "waitBetweenTries", "alwaysOutputData", "executeOnce", "onError", "webhookId",
  ]);
  const credMap = cfg.credentialMap || {};
  const nodes = wf.nodes.map((n) => {
    const clean = {};
    for (const key of Object.keys(n)) {
      if (NODE_FIELDS.has(key)) clean[key] = n[key];
    }
    // Adapt credentials: map known types onto real local credentials, drop the
    // rest (the workflow still imports — those nodes just show "select
    // credential" in the UI instead of pointing at a dead reference).
    if (clean.credentials) {
      const mapped = {};
      for (const credType of Object.keys(clean.credentials)) {
        if (credMap[credType]) mapped[credType] = credMap[credType];
      }
      clean.credentials = mapped;
    }
    return clean;
  });

  const body = {
    name: `${chosen.name} (template #${chosen.id})`,
    nodes,
    connections: wf.connections || {},
    settings: wf.settings || { executionOrder: "v1" },
  };

  const createRes = await fetch(`${cfg.baseUrl}/api/v1/workflows`, {
    method: "POST",
    headers: { "X-N8N-API-KEY": cfg.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const created = await createRes.json();
  if (!created.id) throw new Error(`n8n create failed: ${JSON.stringify(created).slice(0, 300)}`);

  const result = {
    templateId: chosen.id,
    templateName: chosen.name,
    templateDescription: (chosen.description || "").slice(0, 300),
    workflowId: created.id,
    workflowName: created.name,
    nodeCount: nodes.length,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(STATE_PATH, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
