import type { MemoryCortex } from '../memory/cortex.ts';
import { Agent } from '../agent.ts';
import { resolveProvider } from '../engine/utils.ts';
import { parseJsonSafe } from '../parser/parseJsonSafe.ts';

export interface OfflineReflectionInput {
    workflowId?: string;
    originApp?: string;
    outcome: string;
    task?: string;
    reason?: string;
    predictionSummary?: string;
    workflowRecord?: any;
    cortex: MemoryCortex;
    agent?: Agent | { run: (prompt: string, context?: any, config?: any) => Promise<any> };
}

export interface OfflineReflectionResult {
    rule: string;
    reason: string;
    category: 'failure_reflection';
    lessonId: string;
    storedId?: string | null;
}

/**
 * Meta-Learning Failure Reflection (offline):
 * When an outcome is graded as 'loss' or negative, triggers an asynchronous,
 * non-blocking reflection job. Formulates a preventative rule and stores
 * the lesson into Memory Cortex via upsertGradedLesson.
 */
export async function triggerOfflineFailureReflection(
    input: OfflineReflectionInput
): Promise<OfflineReflectionResult> {
    const task = input.task || input.workflowRecord?.task || 'Predictive analysis';
    const reason = input.reason || input.workflowRecord?.reason || 'Prediction deviated from actual outcome';
    const summary = input.predictionSummary || input.workflowRecord?.finalAnalysis?.summary || 'N/A';

    const reflectionPrompt = `You are an expert Swarm Meta-Learning Reflection Agent.
A previous swarm analysis/prediction failed (Outcome: ${input.outcome}).

Context:
Task: ${task}
Observed Failure Reason: ${reason}
Previous Summary: ${summary}

Analyze this failure deeply:
1. What unstated assumption or missed anomaly caused this prediction to fail?
2. Formulate 1 concise, preventative, actionable rule that the swarm must follow in the future to avoid repeating this exact error.

Output strictly valid JSON matching this schema:
{
  "rule": "Concise preventative rule (max 2 sentences)",
  "reason": "Detailed explanation of the missed anomaly or unstated assumption",
  "category": "failure_reflection"
}`;

    let parsed: { rule?: string; reason?: string; category?: string } | null = null;

    // 1. Attempt LLM execution with provided agent or available provider
    let reflectionAgent = input.agent;
    if (!reflectionAgent) {
        for (const provider of ['gemini', 'groq', 'mistral'] as const) {
            const { key, client } = resolveProvider(provider, {} as any);
            if (key) {
                reflectionAgent = new Agent('Meta-Learning Reflection Agent', 'default', provider, key, client);
                break;
            }
        }
    }

    if (reflectionAgent && typeof reflectionAgent.run === 'function') {
        try {
            const raw = await reflectionAgent.run(reflectionPrompt, {} as any, {
                responseMimeType: 'application/json',
                maxTokens: 400
            });
            parsed = parseJsonSafe(raw);
        } catch {
            // LLM reflection failed or threw, fall back to heuristic
        }
    }

    // 2. Heuristic fallback if LLM was unavailable or output was invalid
    const rule = (typeof parsed?.rule === 'string' && parsed.rule.trim().length > 0)
        ? parsed.rule.trim()
        : `Preventative Rule: Re-verify unstated assumptions and anomalies for "${task.slice(0, 100)}" before concluding conviction under ${reason.slice(0, 100)}.`;

    const finalReason = (typeof parsed?.reason === 'string' && parsed.reason.trim().length > 0)
        ? parsed.reason.trim()
        : `Unstated assumption or missed anomaly observed in failed outcome: ${reason}`;

    // 3. Store in Memory Cortex
    const lessonId = `lesson:failure_reflection:${input.workflowId || Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
    const pointPayload = {
        id: lessonId,
        workflowId: input.workflowId,
        app_id: input.originApp || 'swarm',
        originApp: input.originApp || 'swarm',
        rule,
        reason: finalReason,
        category: 'failure_reflection' as const,
        outcome: input.outcome,
        type: 'graded_lesson',
        memory_type: 'graded_lesson',
        date: new Date().toISOString()
    };

    let storedId: string | null = null;
    if (input.cortex && typeof input.cortex.upsertGradedLesson === 'function') {
        storedId = await input.cortex.upsertGradedLesson(lessonId, pointPayload);
    }

    return {
        rule,
        reason: finalReason,
        category: 'failure_reflection',
        lessonId,
        storedId
    };
}
