import type { Agent } from "../agent.ts";
import type { SwarmContext } from "../context.ts";
import type { AgentRunConfig, SwarmEngineSettings } from "../types.ts";
import {
  AnalystScorecardSchema,
  AnalystScorecardSchemaV2,
  CriticScorecardSchema,
  CriticScorecardSchemaV2,
  type AnalystScorecard,
} from "../types.ts";
import { isJudgmentSchemaV2, sideEvColumn } from "../morning/judgment.ts";
import { parseJsonSafe } from "../parser.ts";
import { recordDegraded } from "./partialResult.ts";

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

/** JUDGMENT_SCHEMA_V2 for the engine (read at call time; default off). */
export function scorecardV2(env: Record<string, string | undefined> | undefined = typeof process !== 'undefined' ? process.env : {}): boolean {
    return isJudgmentSchemaV2(env);
}

/**
 * S7: the code edge for a pick, from a game_judgments row (flag on only): the picked side's EV column
 * (home -> ev_home, away -> ev_away, over -> ev_over, under -> ev_under). null = skip the code edge.
 */
export function codeEdgeForPick(row: Record<string, any> | null | undefined, side: string | null | undefined, v2: boolean = scorecardV2()): number | null {
    if (!v2 || !row) return null;
    const col = sideEvColumn(side);
    if (!col) return null;
    const v = row[col];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** R2-S2: appended at the very END of the analyst prompt (after any compression). */
export function renderScorecardInstruction(seat: string, v2: boolean = scorecardV2()): string {
    if (v2) return `\n\nOUTPUT FORMAT (scorecard mode, this overrides any other output format above):
Reply with ONE JSON object and nothing else:
{"seat":"${seat}","picks":[{"row":"R12","note":"max 60 chars"}],"parlay":{"rows":["R12","R40"],"targetFit":"in"},"key_risk":"max 120 chars","confidence":0.62,"status":"ok"}
Rules:
- Cite rows ONLY by the row ids from the tables above (R1..Rn). At most 8 picks.
- "parlay" is optional. targetFit is one of "in", "near", "none".
- No edge field (code computes it). "confidence" is a number from 0 to 1.
- "status" is "ok" or "no_play" (use "no_play" with "picks": [] when nothing qualifies).
JSON only.`;
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
    synthesized?: boolean;
}

function toText(raw: unknown): string {
    if (typeof raw === 'string') return raw;
    try { return JSON.stringify(raw ?? ''); } catch { return String(raw); }
}

function isScorecardLike(obj: any): boolean {
    return !!(obj && typeof obj === 'object' && !Array.isArray(obj) && (Array.isArray(obj.picks) || typeof obj.status === 'string'));
}

/** Parse with the shared parseJsonSafe, then validate with zod. The seat id is owned by code, not the model. */
export function validateScorecard<T = AnalystScorecard>(
    raw: unknown,
    seat: string,
    schema: { safeParse: (data: unknown) => any } = AnalystScorecardSchema,
    v2: boolean = scorecardV2()
): ScorecardValidation<T> {
    if (v2) {
        // S7: the LLM edge is dropped; the v1 schemas map to their no-edge v2 twins.
        if (schema === AnalystScorecardSchema) schema = AnalystScorecardSchemaV2;
        else if (schema === CriticScorecardSchema) schema = CriticScorecardSchemaV2;
    }
    const text = toText(raw);
    const parsed = parseJsonSafe<any>(raw, null);
    if (!isScorecardLike(parsed)) {
        // Auto-extract row IDs via regex (/R\d+/g) from unstructured markdown/prose if standard JSON parse fails
        const rowMatches = text.match(/R\d+/g);
        if (rowMatches && rowMatches.length > 0) {
            const uniqueRows = Array.from(new Set(rowMatches)).slice(0, 8);
            const picks = uniqueRows.map(row => {
                const regex = new RegExp(`${row}[:\\-\\s]+([^\\n.,;]+)`, 'i');
                const m = text.match(regex);
                const note = m && m[1] ? m[1].trim().slice(0, 60) : undefined;
                return note ? { row, note } : { row };
            });

            let edge = 0;
            const edgeMatch = text.match(/(?:edge|advantage)[:\s]*([+-]?\d+(?:\.\d+)?)/i) || text.match(/([+-]?\d+(?:\.\d+)?)\s*%\s*edge/i);
            if (edgeMatch && edgeMatch[1]) {
                const parsedEdge = parseFloat(edgeMatch[1]);
                if (Number.isFinite(parsedEdge)) edge = parsedEdge;
            }

            let confidence = 0.5;
            const confMatch = text.match(/confidence[:\s]*([0-1]?(?:\.\d+)?)/i);
            if (confMatch && confMatch[1]) {
                const parsedConf = parseFloat(confMatch[1]);
                if (Number.isFinite(parsedConf) && parsedConf >= 0 && parsedConf <= 1) {
                    confidence = parsedConf;
                }
            }

            let key_risk = 'Synthesized from unstructured recommendation';
            const riskMatch = text.match(/(?:key[ _]risk|risk)[:\s]*([^\n]+)/i);
            if (riskMatch && riskMatch[1]) {
                key_risk = riskMatch[1].trim().slice(0, 120);
            } else {
                const cleanText = text.replace(/[\r\n]+/g, ' ').trim();
                if (cleanText.length > 0) {
                    key_risk = cleanText.slice(0, 120);
                }
            }

            const synthesized: any = {
                seat,
                picks,
                ...(v2 ? {} : { edge }),
                key_risk,
                confidence,
                status: 'ok',
                row_risks: picks.map(p => ({ row: p.row, key_risk: key_risk.slice(0, 120) }))
            };

            const result = schema.safeParse(synthesized);
            if (result.success) {
                return { ok: true, scorecard: result.data as T, text, synthesized: true };
            }
        }
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
    // Models return confidence as a percentage and edge as text.
    // Coerce both so a valid pick is not rejected and retried.
    if (typeof parsed.confidence === 'number' && parsed.confidence > 1) {
        parsed.confidence = parsed.confidence / 100;
    }
    if (v2) {
        delete parsed.edge;
    } else if (typeof parsed.edge === 'string') {
        const n = parseFloat(parsed.edge.replace('%', ''));
        if (Number.isFinite(n)) parsed.edge = n;
    }
    if (!parsed.status) parsed.status = 'ok';
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
    if (v1.ok) {
        return {
            seat,
            scorecard: v1.scorecard,
            unstructured: v1.synthesized ? v1.text.slice(0, SCORECARD_UNSTRUCTURED_MAX_CHARS) : undefined,
            repaired: false
        };
    }

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
        if (v2.ok) {
            return {
                seat,
                scorecard: v2.scorecard,
                unstructured: v2.synthesized ? v2.text.slice(0, SCORECARD_UNSTRUCTURED_MAX_CHARS) : undefined,
                repaired: true
            };
        }
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

    // Auto-repair fallback: If lastText has valid unstructured recommendations with row IDs, preserve as synthesized scorecard
    const vFallback = validateScorecard<T>(lastText, seat, schema);
    if (vFallback.ok) {
        return {
            seat,
            scorecard: vFallback.scorecard,
            unstructured: lastText.slice(0, SCORECARD_UNSTRUCTURED_MAX_CHARS),
            repaired: true
        };
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
export function scorecardToAnalystReport(
    result: ScorecardSeatResult<AnalystScorecard>,
    role: string,
    /** S7 flag on: codeEdgeForPick(...) for the seat's pick; null/undefined = no code edge shown. */
    codeEdge?: number | null,
    v2: boolean = scorecardV2()
): any {
    if (result.scorecard) {
        const sc = result.scorecard;
        const insights = sc.picks.map(p => (p.note ? `${p.row}: ${p.note}` : p.row));
        if (sc.parlay) insights.push(`Parlay ${sc.parlay.rows.join(' + ')} (target fit: ${sc.parlay.targetFit})`);
        const headline = sc.status === 'no_play'
            ? 'No play'
            : v2
                ? (typeof codeEdge === 'number' && Number.isFinite(codeEdge) ? `Code edge ${codeEdge}%` : 'Play')
                : `Edge ${sc.edge}%`;
        const summary = result.unstructured
            ? `${headline} | ${result.unstructured}`
            : `${headline} | confidence ${sc.confidence} | key risk: ${sc.key_risk}`;
        return {
            insights,
            anomalies: [],
            summary,
            seat: result.seat,
            role,
            scorecard: sc,
            scorecardRepaired: result.repaired,
            ...(result.unstructured ? { unstructured: result.unstructured } : {})
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
