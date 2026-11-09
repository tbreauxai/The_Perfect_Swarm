import type { SeedManifest } from '../server/slimPayload.ts';
import type { TriagePlan, TriageToolCall } from './triagePlanner.ts';
import { globalToolRegistry, type ToolRegistry, type SwarmTool } from '../tools/index.ts';
import { globalGameQueryCache, GameQueryCache } from '../cache/gameQueryCache.ts';
import { estimateTokens } from '../providers/limiter.ts';

export const TOOL_EXECUTION_TIMEOUT_MS = 1500;

export interface DossierSection {
  tool: string;
  parameters: Record<string, any>;
  success: boolean;
  summary: string;
  durationMs: number;
  cached: boolean;
  data?: any;
  error?: string;
}

export interface CuratedDossier {
  game_id: string;
  candidate_id: string;
  sport: string;
  market_type: string;
  sections: DossierSection[];
  markdown: string;
  tokenEstimate: number;
  totalDurationMs: number;
}

export interface TriageExecutorOptions {
  toolRegistry?: ToolRegistry;
  cache?: GameQueryCache;
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  qdrantClient?: any;
  timeoutMs?: number; // default: 1500ms
}

/**
 * Executes a single tool with single-flight cache and 1500ms hard timeout.
 */
async function executeToolWithCacheAndTimeout(
  toolCall: TriageToolCall,
  manifest: SeedManifest,
  registry: ToolRegistry,
  cache: GameQueryCache,
  timeoutMs: number,
  options?: { env?: Record<string, string | undefined>; fetchFn?: typeof fetch; qdrantClient?: any }
): Promise<DossierSection> {
  const toolName = toolCall.tool;
  const tool = registry.get(toolName);
  const startTime = Date.now();

  if (!tool) {
    return {
      tool: toolName,
      parameters: toolCall.parameters,
      success: false,
      summary: `[TOOL_ERROR: Tool '${toolName}' not registered]`,
      durationMs: 0,
      cached: false,
      error: `Tool '${toolName}' not found in registry`
    };
  }

  // Check if already in cache before calling
  const isAlreadyCached = cache.has(manifest.game_id, toolName, toolCall.parameters);

  try {
    const rawResult = await cache.getOrFetch(
      manifest.game_id,
      toolName,
      toolCall.parameters,
      async () => {
        let timer: any;
        const timeoutPromise = new Promise<{ ok: false; error: string; summary: string }>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Tool '${toolName}' exceeded ${timeoutMs}ms execution timeout`));
          }, timeoutMs);
        });

        try {
          const runPromise = Promise.resolve(
            tool.execute(toolCall.parameters, {
              env: options?.env,
              fetchFn: options?.fetchFn,
              qdrantClient: options?.qdrantClient
            })
          );
          const result = await Promise.race([runPromise, timeoutPromise]);
          return result;
        } finally {
          clearTimeout(timer);
        }
      }
    );

    const durationMs = Date.now() - startTime;
    const success = Boolean(rawResult && (rawResult.success !== false) && !rawResult.error);
    const summary = typeof rawResult?.summary === 'string'
      ? rawResult.summary
      : (typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult));

    return {
      tool: toolName,
      parameters: toolCall.parameters,
      success,
      summary,
      durationMs,
      cached: isAlreadyCached,
      data: rawResult?.data ?? rawResult,
      error: rawResult?.error
    };
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    return {
      tool: toolName,
      parameters: toolCall.parameters,
      success: false,
      summary: `[TOOL_TIMEOUT: ${toolName} failed (${err?.message || 'timeout'})]`,
      durationMs,
      cached: false,
      error: err?.message || 'Tool execution failed'
    };
  }
}

/**
 * Hop 1 Triage Executor:
 * Concurrently executes up to 3 tools in the TriagePlan, using GameQueryCache
 * and 1500ms timeout per tool, then stitches a curated dossier.
 */
export async function executeTriage(
  plan: TriagePlan,
  manifest: SeedManifest,
  options?: TriageExecutorOptions
): Promise<CuratedDossier> {
  const startTime = Date.now();
  const registry = options?.toolRegistry || globalToolRegistry;
  const cache = options?.cache || globalGameQueryCache;
  const timeoutMs = options?.timeoutMs ?? TOOL_EXECUTION_TIMEOUT_MS;

  // Execute all selected tools in parallel (Promise.all)
  const toolPromises = plan.tool_calls.map((call) =>
    executeToolWithCacheAndTimeout(call, manifest, registry, cache, timeoutMs, {
      env: options?.env,
      fetchFn: options?.fetchFn,
      qdrantClient: options?.qdrantClient
    })
  );

  const sections = await Promise.all(toolPromises);
  const totalDurationMs = Date.now() - startTime;

  // Assemble Curated Dossier Markdown
  const header = [
    `### Curated Matchup Dossier [${manifest.sport.toUpperCase()} | Game: ${manifest.game_id} | Market: ${manifest.market_type}]`,
    `- Candidate: ${manifest.candidate_id} | Selection: ${manifest.pricing.selection} (Odds: ${manifest.pricing.book_odds}, Fair: ${manifest.pricing.fair_prob}${manifest.pricing.line !== undefined ? `, Line: ${manifest.pricing.line}` : ''})`,
    `- Matchup Context: Dome: ${manifest.flags.is_dome} | Hours to Start: ${manifest.flags.hours_to_kickoff} | Active Injury Tags: ${manifest.flags.has_active_injury_tags}`
  ].join('\n');

  const bodySections = sections.map((sec) => sec.summary.trim()).filter(Boolean);
  const markdown = `${header}\n\n${bodySections.join('\n\n')}`;
  const tokenEstimate = estimateTokens(markdown);

  return {
    game_id: manifest.game_id,
    candidate_id: manifest.candidate_id,
    sport: manifest.sport,
    market_type: manifest.market_type,
    sections,
    markdown,
    tokenEstimate,
    totalDurationMs
  };
}
