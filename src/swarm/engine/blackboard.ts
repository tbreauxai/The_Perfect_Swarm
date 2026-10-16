import type { Agent } from '../agent.ts';
import type { AnalystScorecard, CriticScorecard } from '../types.ts';

/** One blackboard entry per analyst report: a valid scorecard, or <= 600 chars of unstructured text. */
export type BlackboardScorecard =
    | (AnalystScorecard & { role: string; chunk?: number; unstructured?: false })
    | { seat: string; role: string; chunk?: number; unstructured: true; text: string };

export interface CitedRow {
    row: string;
    /** The row's original table line, copied verbatim from the request `data`. */
    line: string;
}

/** R2-S3: shared workflow state for scorecard mode. */
export interface Blackboard {
    brief: string;
    scorecards: BlackboardScorecard[];
    degraded: string[];
    citedRows: CitedRow[];
    /** The table header line (`id|...`) above the first cited row, when the data has one. */
    header?: string;
    /** Row ids an analyst cited that are not in `data` (never sent to the critic or manager). */
    unknownRows: string[];
    /** R2-S4: the critic's scorecard (or its unstructured text), when a critic ran. */
    critic?: (CriticScorecard & { unstructured?: false }) | { seat: string; unstructured: true; text: string };
}

const ROW_LINE = /^\s*(R\d+)\s*\|/;
const HEADER_LINE = /^\s*id\s*\|/i;

/** Map of row id -> original table line (first occurrence), plus the nearest `id|...` header above each row. */
export function indexTableRows(data: string): { lines: Map<string, string>; headers: Map<string, string> } {
    const lines = new Map<string, string>();
    const headers = new Map<string, string>();
    let currentHeader: string | undefined;
    for (const rawLine of (data || '').split(/\r?\n/)) {
        if (HEADER_LINE.test(rawLine)) {
            currentHeader = rawLine.trim();
            continue;
        }
        const m = rawLine.match(ROW_LINE);
        if (m && !lines.has(m[1])) {
            lines.set(m[1], rawLine.trim());
            if (currentHeader) headers.set(m[1], currentHeader);
        }
    }
    return { lines, headers };
}

function rowNumber(row: string): number {
    return Number(row.slice(1)) || 0;
}

/** Row ids cited by structured scorecards (picks + parlay legs), de-duplicated. */
export function collectCitedRowIds(scorecards: BlackboardScorecard[]): string[] {
    const ids = new Set<string>();
    for (const sc of scorecards) {
        if (sc.unstructured) continue;
        const card = sc as AnalystScorecard;
        for (const p of card.picks || []) ids.add(p.row);
        for (const r of card.parlay?.rows || []) ids.add(r);
    }
    return Array.from(ids).sort((a, b) => rowNumber(a) - rowNumber(b));
}

/** citedRows = union of the cited row ids, each with its original table line from `data`. */
export function buildCitedRows(data: string, rowIds: string[]): { citedRows: CitedRow[]; header?: string; unknownRows: string[] } {
    const { lines, headers } = indexTableRows(data);
    const citedRows: CitedRow[] = [];
    const unknownRows: string[] = [];
    let header: string | undefined;
    for (const row of rowIds) {
        const line = lines.get(row);
        if (line === undefined) {
            unknownRows.push(row);
            continue;
        }
        citedRows.push({ row, line });
        if (!header && headers.has(row)) header = headers.get(row);
    }
    return { citedRows, header, unknownRows };
}

/** Builds the blackboard from the analyst reports produced in scorecard mode. */
export function buildBlackboard(p: {
    brief: string;
    data: string;
    analysts: Agent[];
    allAnalystReports: any[][];
    degraded: string[];
}): Blackboard {
    const scorecards: BlackboardScorecard[] = [];
    p.analysts.forEach((a, i) => {
        for (const r of p.allAnalystReports[i] || []) {
            if (!r || typeof r !== 'object') continue;
            const seat = r.seat || (a as any).id || a.role;
            const chunk = typeof r._chunkIndex === 'number' ? r._chunkIndex : undefined;
            if (r.scorecard) {
                scorecards.push({
                    ...r.scorecard,
                    seat,
                    role: a.role,
                    ...(chunk !== undefined ? { chunk } : {})
                });
            } else if (r.unstructured) {
                scorecards.push({
                    seat,
                    role: a.role,
                    ...(chunk !== undefined ? { chunk } : {}),
                    unstructured: true,
                    text: String(r.summary || '')
                });
            }
        }
    });
    const { citedRows, header, unknownRows } = buildCitedRows(p.data, collectCitedRowIds(scorecards));
    return {
        brief: p.brief,
        scorecards,
        degraded: [...p.degraded],
        citedRows,
        ...(header ? { header } : {}),
        unknownRows
    };
}

/** Compact one-line-per-seat rendering used by the critic and manager prompts. */
export function renderScorecardLines(scorecards: BlackboardScorecard[]): string {
    if (scorecards.length === 0) return '(none)';
    return scorecards.map(sc => {
        if (sc.unstructured) return `${sc.seat} (unstructured): ${sc.text}`;
        const { role: _role, chunk: _chunk, unstructured: _u, ...card } = sc as any;
        return JSON.stringify(card);
    }).join('\n');
}

export function renderCitedRows(bb: Pick<Blackboard, 'citedRows' | 'header'>): string {
    if (bb.citedRows.length === 0) return '(no rows cited)';
    return [bb.header, ...bb.citedRows.map(r => r.line)].filter(Boolean).join('\n');
}
