import type { AgentConfig, Provider, SwarmEngineSettings } from "../types.ts";
import { resolveProvider } from "./utils.ts";

/**
 * Morning runs (responseSchema 'morning_judge') prefer Groq and never use OpenRouter (2026-10-16: the OpenRouter
 * :free cap is 50 calls/day and Tyler won't buy credits). AI Lab / chat runs are not touched.
 * Groq's own caps still apply to every Groq call (groq.ts: prompt char cap, max_tokens rule, < 800 => skip to the
 * next fallback) and the limiter's 7k tokens/min budget (limiter.ts), so a busy Groq falls back to Mistral/Gemini.
 */
export const MORNING_POOL_PROVIDERS: Provider[] = ["groq", "mistral", "gemini"];
export const MORNING_GROQ_JUDGE_MODEL = "openai/gpt-oss-120b";

/** Where a morning seat that asked for OpenRouter goes instead, in order (first one with a key and a free Groq model). */
export const MORNING_SEAT_REPLACEMENTS: ReadonlyArray<{
  provider: Provider;
  model: string;
}> = [
  { provider: "groq" as Provider, model: "openai/gpt-oss-20b" },
  { provider: "mistral" as Provider, model: "mistral-small-latest" },
  { provider: "gemini" as Provider, model: "gemini-3.1-flash-lite" },
];

const MOVABLE_JUDGE_PROVIDERS = new Set<string>([
  "gemini",
  "mistral",
  "openrouter",
]);

function isManagerSeat(a: AgentConfig): boolean {
  return a.id === "manager" || a.role === "Manager Node";
}

/**
 * - The judge (manager seat) on Gemini, Mistral or OpenRouter runs on Groq gpt-oss-120b when a Groq key exists; otherwise it keeps its seat,
 *   unless that seat is OpenRouter, which is replaced like any other seat.
 * - Every other OpenRouter seat is replaced (Groq gpt-oss-20b, then Mistral, then Gemini). With no key for any of
 *   them the seat is dropped.
 * - At most one analyst seat per Groq model (each Groq model has its own rate limit), so a2 keeps gpt-oss-120b
 *   and a replaced critic takes gpt-oss-20b.
 */
export function applyMorningProviderPolicy(
  agents: AgentConfig[],
  settings: SwarmEngineSettings | undefined,
): AgentConfig[] {
  const hasKey = (p: string) =>
    !!resolveProvider(p, (settings || {}) as SwarmEngineSettings).key;
  const usedGroqModels = new Set(
    agents
      .filter((a) => !isManagerSeat(a) && a.provider === "groq")
      .map((a) => a.model),
  );
  const out: AgentConfig[] = [];
  for (const a of agents) {
    // Only seats on a real hosted provider move (custom / mock / simulated seats are left alone).
    if (
      isManagerSeat(a) &&
      MOVABLE_JUDGE_PROVIDERS.has(a.provider) &&
      hasKey("groq")
    ) {
      out.push({
        ...a,
        provider: "groq",
        model: MORNING_GROQ_JUDGE_MODEL,
        apiKey: undefined,
      });
      continue;
    }
    if (a.provider !== "openrouter") {
      out.push(a);
      continue;
    }
    const pick = MORNING_SEAT_REPLACEMENTS.find(
      (r) =>
        hasKey(r.provider) &&
        !(
          r.provider === "groq" &&
          !isManagerSeat(a) &&
          usedGroqModels.has(r.model)
        ),
    );
    if (!pick) {
      console.warn(
        `[Morning] Dropping seat ${a.id || a.role}: OpenRouter is not used for morning runs and no Groq/Mistral/Gemini key is set.`,
      );
      continue;
    }
    if (pick.provider === "groq" && !isManagerSeat(a))
      usedGroqModels.add(pick.model);
    out.push({
      ...a,
      provider: pick.provider,
      model: pick.model,
      apiKey: undefined,
    });
  }
  return out;
}
