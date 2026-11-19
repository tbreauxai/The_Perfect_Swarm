/**
 * Prompt & output token budgets per provider.
 *
 * Math for Groq:
 * 2 execution rounds:
 * - Round 1: ~1,400 input + ~300 output tokens
 * - Round 2: ~1,350 input + ~800 output tokens
 * Total ~3.85k tokens, comfortably under Groq's 6,000 TPM limit.
 * maxPromptChars counts system instruction + tool schemas + prompt text.
 */

export interface SeatBudget {
  maxPromptChars: number;
  maxOutTokens: number;
  maxToolResultChars: number;
  maxToolCalls: number;
}

export interface PromptParts {
  systemInstruction?: string;
  toolSchemas?: string;
  prompt?: string;
  toolResults?: string;
  reports?: string;
  [key: string]: string | undefined;
}

export function seatBudget(provider?: string): SeatBudget {
  const norm = (provider || '').toLowerCase().trim();
  if (norm === 'groq') {
    return {
      maxPromptChars: 5600,
      maxOutTokens: 800,
      maxToolResultChars: 2000,
      maxToolCalls: 6
    };
  }
  // openrouter, gemini, mistral, or other fallback providers
  return {
    maxPromptChars: 14000,
    maxOutTokens: 1500,
    maxToolResultChars: 6000,
    maxToolCalls: 8
  };
}

export function assemblePrompt(parts: PromptParts): string {
  const chunks: string[] = [];
  if (parts.systemInstruction?.trim()) chunks.push(parts.systemInstruction.trim());
  if (parts.toolSchemas?.trim()) chunks.push(parts.toolSchemas.trim());
  if (parts.prompt?.trim()) chunks.push(parts.prompt.trim());
  if (parts.toolResults?.trim()) chunks.push(parts.toolResults.trim());
  if (parts.reports?.trim()) chunks.push(parts.reports.trim());
  return chunks.join('\n\n');
}

/**
 * Asserts that the total prompt parts fit within provider maxPromptChars.
 * Throws in test environments when exceeding budget.
 * In production, trims reports and toolResults (never instructions/schemas).
 */
export function assertPromptFits(
  provider: string | undefined,
  parts: PromptParts,
  options?: { isTest?: boolean }
): string {
  const budget = seatBudget(provider);
  const isTest =
    options?.isTest ??
    (typeof process !== 'undefined' &&
      (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true'));

  const sysLen = (parts.systemInstruction || '').length;
  const toolSchemaLen = (parts.toolSchemas || '').length;
  const promptLen = (parts.prompt || '').length;
  let toolResults = parts.toolResults || '';
  let reports = parts.reports || '';

  const fixedLen = sysLen + toolSchemaLen + promptLen;
  const total = fixedLen + toolResults.length + reports.length;

  if (total <= budget.maxPromptChars) {
    return assemblePrompt({ ...parts, toolResults, reports });
  }

  if (isTest) {
    throw new Error(
      `Prompt exceeds ${provider || 'default'} budget: ${total} chars > ${budget.maxPromptChars} max (overflow: ${total - budget.maxPromptChars})`
    );
  }

  // Production trim path: trim reports first, then toolResults. Never trim instructions or prompt.
  let allowedDynamic = Math.max(0, budget.maxPromptChars - fixedLen - 30);
  if (reports.length > allowedDynamic) {
    reports = reports.slice(0, Math.max(0, allowedDynamic - 15)) + '\n…[truncated]';
  }
  allowedDynamic = Math.max(0, allowedDynamic - reports.length);

  if (toolResults.length > allowedDynamic) {
    toolResults = toolResults.slice(0, Math.max(0, allowedDynamic - 15)) + '\n…[truncated]';
  }

  return assemblePrompt({ ...parts, toolResults, reports });
}
