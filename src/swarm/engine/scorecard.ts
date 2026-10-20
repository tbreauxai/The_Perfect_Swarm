import type { Agent } from '../agent.ts';
import type { SwarmContext } from '../context.ts';
import type { AgentRunConfig, SwarmEngineSettings } from '../types.ts';
import { AnalystScorecardSchema, type AnalystScorecard } from '../types.ts';
import { parseJsonSafe } from '../parser.ts';
import { recordDegraded } from './partialResult.ts';

/** R2-S1: analyst max output tokens in scorecard mode (a scorecard is ~150 tokens). */
export const SCORECARD_ANALYST_MAX_TOKENS = 800;
/** R2-S2: free text kept when a seat never produces a valid scorecard. */
export const SCORECARD_UNSTRUCTURED_MAX_CHARS = 600;

/** Scorecard mode is opt-in (request or settings) and never applies to morning_judge runs. */
export function isScorecardMode(
    params: { scorecardMode?: boolean } | undefined,
    settings?: SwarmEngineSettings
): boolean {
    if ((settings as any)?.responseSchema === 'morning_judge') return false;
    return params?.scorecardMode === true || settings?.scorecardMode === true;
}

export function scorecardAnalystMaxTokens(settings?: SwarmEngineSettings): number {
    const n = Number(settings?.scorecardAnalystMaxTokens);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : SCORECARD_ANALYST_MAX_TOKENS;
}

/** R2-S2: appended at the very END of the analyst prompt (after any compression). */
export function renderScorecardInstruction(seat: string): string {
    return `\n\nOUTPUT FORMAT (scorecard mode, this overrides any other output format above):
Reply with ONE JSON object and nothing else:
{"seat":"${seat}","picks":[{"row":"R12","note":"max 60 chars"}],"parlay":{"rows":["R12","R40"],"targetFit":"in"},"edge":3.5,"key_risk":"max 120 chars","confidence":0.62,"status":"ok"}
Rules:
- Cite rows ONLY by the row ids from the tables above (R1..Rn). At most 8 picks.
- "parlay" is optional. targetFit is one of "in", "near", "none".
- "edge" is a number in percent. "confidence" is a number from 0 to 1.
- "status" is "ok" or "no_play" (use "no_play" with "picks": [] when nothing qualifies).
JSON only.`;
}

export interface ScorecardValidation<T> {
    ok: boolean;
    scorecard?: T;
    error?: string;
    text: string;
}

function toText(raw: unknown): string {
    if (typeof raw === 'string') return raw;
    try { return JSON.stringify(raw ?? ''); } catch { return String(raw); }
}

/** Parse with the shared parseJsonSafe, then validate with zod. The seat id is owned by code, not the model. */
export function validateScorecard<T = AnalystScorecard>(
    raw: unknown,
    seat: string,
    schema: { safeParse: (data: unknown) => any } = AnalystScorecardSchema
): ScorecardValidation<T> {
    const text = toText(raw);
    const parsed = parseJsonSafe<any>(raw, null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: 'reply is not a JSON object', text };
    }
    // A long note is not a bad pick. Cut it instead of rejecting the card and
    // forcing a repair call that walks the whole failover chain again.
    if (Array.isArray(parsed.picks)) {
        for (const p of parsed.picks) {
            if (p && typeof p.note === 'string' && p.note.length > 60) p.note = p.note.slice(0, 60);
        }
    }
    if (typeof parsed.key_risk === 'string' && parsed.key_risk.length > 120) {
        parsed.key_risk = parsed.key_risk.slice(0, 120);
    }
    const result = schema.safeParse({ ...parsed, seat });
    if (result.success) {
        return { ok: true, scorecard: result.data as T, text };
    }
    const error = (result.error?.issues || [])
        .map((i: any) => `${(i.path || []).join('.') || '(root)'}: ${i.message}`)
        .join('; ')
        .slice(0, 400);
    return { ok: false, error: error || 'invalid scorecard', text };
}

export interface ScorecardSeatResult<T = AnalystScorecard> {
    seat: string;
    scorecard?: T;
    unstructured?: string;
    repaired: boolean;
}

/**
 * R2-S2: run one seat in scorecard mode.
 * Invalid reply -> ONE repair attempt on the same seat with the validation error.
 * Still invalid -> keep <= 600 chars of free text as unstructured and mark the seat degraded. Never throws for
 * bad output (PS1). Provider failures on the first call still throw, so the existing failed-seat path handles them.
 */
export async function runScorecardSeat<T = AnalystScorecard>(opts: {
    agent: Agent;
    seat: string;
    prompt: string;
    context: SwarmContext;
    runConfig: AgentRunConfig;
    schema?: { safeParse: (data: unknown) => any };
}): Promise<ScorecardSeatResult<T>> {
    const { agent, seat, prompt, context, runConfig } = opts;
    const schema = opts.schema || AnalystScorecardSchema;

    const first = await agent.run(prompt, context, runConfig);
    const v1 = validateScorecard<T>(first, seat, schema);
    if (v1.ok) return { seat, scorecard: v1.scorecard, repaired: false };

    context.addEvent({
        agentRole: agent.role,
        action: 'Scorecard Invalid (one repair attempt)',
        modelName: `${agent.provider} / ${agent.modelName}`,
        prompt: `Scorecard for seat '${seat}' failed validation; retrying once on the same seat.`,
        error: v1.error,
        durationMs: 0
    });

    let lastText = v1.text;
    try {
        const repairPrompt = `${prompt}\n\n[SYSTEM: Your previous reply was not a valid scorecard (${v1.error}). Reply again with the corrected scorecard JSON only.]`;
        const second = await agent.run(repairPrompt, context, { ...runConfig, bypassCache: true });
        const v2 = validateScorecard<T>(second, seat, schema);
        if (v2.ok) return { seat, scorecard: v2.scorecard, repaired: true };
        lastText = v2.text || lastText;
    } catch (repairErr: any) {
        context.addEvent({
            agentRole: agent.role,
            action: 'Scorecard Repair Call Failed',
            modelName: `${agent.provider} / ${agent.modelName}`,
            prompt: `Repair attempt for seat '${seat}' failed; keeping the first reply as unstructured text.`,
            error: repairErr?.message || String(repairErr),
            durationMs: 0
        });
    }

    recordDegraded(context, seat);
    const unstructured = (lastText || '').slice(0, SCORECARD_UNSTRUCTURED_MAX_CHARS);
    context.addEvent({
        agentRole: agent.role,
        action: 'Scorecard Unstructured (seat degraded)',
        modelName: `${agent.provider} / ${agent.modelName}`,
        prompt: `Seat '${seat}' gave no valid scorecard after one repair; keeping ${unstructured.length} chars of free text.`,
        output: { seat, unstructured: true },
        durationMs: 0
    });
    return { seat, unstructured, repaired: false };
}

/**
 * Wraps a scorecard result in the analyst report shape the rest of the engine already reads
 * (insights / anomalies / summary), so consensus, the PS1 partial fallback and the hierarchy bus keep working.
 */
export function scorecardToAnalystReport(result: ScorecardSeatResult<AnalystScorecard>, role: string): any {
    if (result.scorecard) {
        const sc = result.scorecard;
        const insights = sc.picks.map(p => (p.note ? `${p.row}: ${p.note}` : p.row));
        if (sc.parlay) insights.push(`Parlay ${sc.parlay.rows.join(' + ')} (target fit: ${sc.parlay.targetFit})`);
        const headline = sc.status === 'no_play' ? 'No play' : `Edge ${sc.edge}%`;
        return {
            insights,
            anomalies: [],
            summary: `${headline} | confidence ${sc.confidence} | key risk: ${sc.key_risk}`,
            seat: result.seat,
            role,
            scorecard: sc,
            scorecardRepaired: result.repaired
        };
    }
    return {
        insights: [],
        anomalies: [],
        summary: result.unstructured || '',
        seat: result.seat,
        role,
        unstructured: true
    };
}
