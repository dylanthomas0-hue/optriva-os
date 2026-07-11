// GLM Code — the real Claude Code CLI (`claude`) running on GLM-5.2 instead of
// Anthropic's models. Same env-override trick as Free Claude Code (fccSpawnEnv).
//
// REWIRED 2026-07-10 (Dylan's setup): instead of the stock Ollama-Cloud bridge
// (glm-5.2:cloud via :11434, which needs an ollama.com login we don't have),
// this now points at the local fcc-server proxy (:8082), which speaks the
// Anthropic Messages API and routes to OpenCode Go — where MODEL in ~/.fcc/.env
// is `opencode_go/glm-5.2`. Same GLM-5.2 model, already-paid OpenCode key,
// zero extra accounts. Override with GLM_CODE_BASE / GLM_CODE_MODEL /
// GLM_CODE_TOKEN env if the routing ever changes.
//
// NOTE for future updates: the stock Agent OS updater will revert this file —
// it's on the RE-APPLY-AFTER-UPDATE list.

import { FCC_BASE, FCC_TOKEN } from "@/lib/fcc";

export const GLM_CODE_BASE = process.env.GLM_CODE_BASE || FCC_BASE;
export const GLM_CODE_MODEL = process.env.GLM_CODE_MODEL || "glm-5.2";
const GLM_CODE_TOKEN = process.env.GLM_CODE_TOKEN || FCC_TOKEN;

// Env injected when we spawn `claude`. Mapping every default model slot to
// the GLM model stops Claude Code from ever reaching for an Anthropic model
// (e.g. its small/fast background model), which would 401 against the proxy.
export function glmcodeSpawnEnv(): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: GLM_CODE_BASE,
    ANTHROPIC_API_KEY: GLM_CODE_TOKEN,
    ANTHROPIC_AUTH_TOKEN: GLM_CODE_TOKEN,
    ANTHROPIC_MODEL: GLM_CODE_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: GLM_CODE_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: GLM_CODE_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: GLM_CODE_MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: GLM_CODE_MODEL,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    // fcc-server upstream (OpenCode Go glm-5.2) carries ~200k context, not the
    // 1M the Ollama-Cloud variant had — keep compaction inside that window.
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "190000",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  };
  if (process.env.OLLAMA_API_KEY) env.OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;
  return env;
}

export interface GlmCodeState {
  ollamaUp: boolean;
  model: string;
  base: string;
  ready: boolean;
}

// Is the Anthropic-compatible backend reachable? fcc-server answers /health;
// an Ollama daemon (if GLM_CODE_BASE is pointed back at one) answers /api/version.
export async function getGlmCodeState(): Promise<GlmCodeState> {
  let up = false;
  for (const probe of ["/health", "/api/version"]) {
    try {
      const ctl = new AbortController();
      const tid = setTimeout(() => ctl.abort(), 1500);
      const r = await fetch(`${GLM_CODE_BASE}${probe}`, { signal: ctl.signal });
      clearTimeout(tid);
      if (r.ok) { up = true; break; }
    } catch { /* backend down or wrong probe — try next */ }
  }
  return { ollamaUp: up, model: GLM_CODE_MODEL, base: GLM_CODE_BASE, ready: up };
}
