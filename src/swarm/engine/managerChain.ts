import type { GoogleGenAI } from "@google/genai";
import type {
  ProviderCredential,
  Provider,
  AgentConfig,
  SwarmEngineSettings,
} from "../types.ts";
import { resolveProvider } from "./utils.ts";
import { globalProviderLimiter } from "../providers/limiter.ts";
import { DEFAULT_PROVIDER_MODELS } from "../agent.ts";

/**
 * Ordered server-side manager fallback chain (PS3).
 * Free tiers only (Tyler, 2026-10-16). github is not here: GitHub Models was retired on 2026-07-30.
 * PROVISIONAL models: to be finalized by PS4 (Code Auditor provider probe). Do not change them in this branch.
 */
export const MANAGER_CHAIN: ReadonlyArray<{
  provider: Provider;
  model: string;
}> = [
  { provider: "gemini" as Provider, model: "gemini-2.5-flash" },
  { provider: "gemini" as Provider, model: "gemini-2.5-flash-lite" },
  { provider: "mistral" as Provider, model: "mistral-small-latest" },
  { provider: "groq" as Provider, model: "openai/gpt-oss-120b" },
];

/**
 * MANAGER_CHAIN entries that have a server (Render env) key and a closed circuit/live model.
 * `exclude` drops the manager's own provider+model (an empty model drops every entry for that provider).
 */
export function buildManagerChain(
  defaultAi?: GoogleGenAI,
  exclude?: { provider: string; model?: string },
): ProviderCredential[] {
  const out: ProviderCredential[] = [];
  for (const entry of MANAGER_CHAIN) {
    if (
      exclude &&
      entry.provider === exclude.provider &&
      (!exclude.model || exclude.model === entry.model)
    )
      continue;
    if (!globalProviderLimiter.isAvailable(entry.provider, entry.model))
      continue;
    // Server env keys only (empty settings): the chain never depends on a user-supplied key.
    const { key, client } = resolveProvider(
      entry.provider,
      {} as SwarmEngineSettings,
      defaultAi,
    );
    if (!key) continue;
    out.push({
      provider: entry.provider,
      modelName: entry.model,
      apiKey: key,
      aiClient: client,
    });
  }
  return out;
}

/**
 * Global analyst fallback pool: every provider with a key (user or env), using that provider's seat model
 * when one is configured, else DEFAULT_PROVIDER_MODELS. Open circuits / dead models are left out.
 * seatModelsOnly (morning runs): only providers that already have a seat model in this run, i.e. the pre-PS3
 * behavior. Morning never borrows from the global pool, so the cron can't burn chat quota.
 */
export function buildAnalystPool(
  providers: Provider[],
  settings: SwarmEngineSettings | undefined,
  rawAgents: AgentConfig[],
  defaultAi?: GoogleGenAI,
  options: { seatModelsOnly?: boolean } = {},
): ProviderCredential[] {
  const pool: ProviderCredential[] = [];
  for (const p of providers) {
    const { key, client } = resolveProvider(
      p,
      settings as SwarmEngineSettings,
      defaultAi,
    );
    if (!key) continue;
    const seat = rawAgents.find(
      (a: AgentConfig) =>
        a.provider === p && a.model && a.model.trim().length > 0,
    );
    if (options.seatModelsOnly && !seat) continue;
    const model = (seat?.model || DEFAULT_PROVIDER_MODELS[p] || "").trim();
    if (!model) continue;
    if (!globalProviderLimiter.isAvailable(p, model)) continue;
    pool.push({ provider: p, apiKey: key, modelName: model, aiClient: client });
  }
  return pool;
}

/** Concatenate fallback lists, keeping the first occurrence of each provider+model. */
export function mergeFallbacks(
  ...lists: ProviderCredential[][]
): ProviderCredential[] {
  const seen = new Set<string>();
  const out: ProviderCredential[] = [];
  for (const list of lists) {
    for (const f of list) {
      const k = `${f.provider}::${f.modelName || ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(f);
    }
  }
  return out;
}
