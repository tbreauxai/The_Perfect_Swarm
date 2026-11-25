import type { SwarmEvent } from '../types.ts';
import { estimateTokens } from '../providers/limiter.ts';
import { redactErrorSnippet, extractHttpStatus } from '../agent.ts';

export interface SeatTimingDiagnostic {
    seat: string;
    role: string;
    provider: string;
    model: string;
    durationMs: number;
    inputTokens: number;
    status: 'ok' | 'failover' | 'error' | 'timeout';
}

export interface FailoverDiagnostic {
    seat: string;
    from: string;
    to: string;
    status: number | null;
    error: string;
    durationMs: number;
}

export interface CompactRunDiagnostics {
    totalMs: number;
    hop1ToolsMs: number;
    seatTimings: SeatTimingDiagnostic[];
    failovers: FailoverDiagnostic[];
}

export interface InFlightSeatSnapshot {
    seat: string;
    provider?: string | null;
    model?: string | null;
    startedAt?: number;
}

export const MAX_DIAGNOSTICS_BYTES = 1950;

export function canonicalizeSeatId(role: string): string {
    const raw = String(role || '').trim();
    const lower = raw.toLowerCase();
    if (!lower) return 'unknown';
    if (lower === 'a1' || lower.includes('quant')) return 'a1';
    if (lower === 'a2' || lower.includes('market')) return 'a2';
    if (lower.includes('verification') || lower.includes('verifier')) return 'verifier';
    if (lower.includes('critic') || lower.includes('risk')) return 'critic';
    if (lower.includes('manager') || lower.includes('compiler')) return 'manager';
    if (lower.includes('grader')) return 'grader';
    return lower.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'seat';
}

function parseProviderAndModel(modelName?: string): { provider: string; model: string } {
    const raw = String(modelName || '').trim();
    if (!raw) return { provider: 'unknown', model: 'unknown' };
    const arrowIdx = raw.lastIndexOf('->');
    const segment = arrowIdx >= 0 ? raw.slice(arrowIdx + 2).trim() : raw;
    const spacedSlash = segment.match(/^([a-z0-9_-]+)\s+\/\s+(.+)$/i);
    if (spacedSlash) {
        return { provider: spacedSlash[1].trim(), model: spacedSlash[2].trim() };
    }
    const tightSlash = segment.match(/^(gemini|groq|cloudflare|mistral|openrouter|nvidia|github|simulated)\/(.+)$/i);
    if (tightSlash) {
        return { provider: tightSlash[1].trim(), model: tightSlash[2].trim() };
    }
    return { provider: 'unknown', model: segment };
}

function utf8ByteLength(str: string): number {
    if (typeof TextEncoder !== 'undefined') {
        return new TextEncoder().encode(str).length;
    }
    return str.length;
}

function formatEndpoint(provider?: string | null, model?: string | null): string {
    const p = String(provider || '').trim();
    const m = String(model || '').trim();
    if (p && m) return `${p}/${m}`;
    if (p) return p;
    if (m) return m;
    return 'unknown';
}

/**
 * S4: Builds a compact, strictly bounded (< 2 KB) diagnostics object from SwarmContext events
 * for inline emission on `rawFinalAnalysisPayload` (`finalAnalysis.diagnostics`) and `run_timeout`
 * error payloads. Redacts any keys/tokens and caps each error string to <= 160 chars.
 */
export function buildCompactRunDiagnostics(params: {
    events: SwarmEvent[];
    totalMs: number;
    hop1ToolsMs?: number;
    maxBytes?: number;
    activeInFlight?: InFlightSeatSnapshot[];
    nowMs?: number;
}): CompactRunDiagnostics {
    const events = Array.isArray(params.events) ? params.events : [];
    const totalMs = Math.max(0, Math.round(Number.isFinite(params.totalMs) ? params.totalMs : 0));
    const maxBytes = Math.min(Math.max(512, params.maxBytes ?? MAX_DIAGNOSTICS_BYTES), 2040);
    const nowMs = params.nowMs ?? Date.now();

    let inferredHop1Ms = 0;
    const seatTimings: SeatTimingDiagnostic[] = [];
    const failovers: FailoverDiagnostic[] = [];

    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (!ev || typeof ev !== 'object') continue;
        const action = String(ev.action || '');
        const role = String(ev.agentRole || '').trim();
        const seat = canonicalizeSeatId(role);

        if (
            action === 'Completed execution' ||
            action.startsWith('Completed execution via failover') ||
            action === 'Failed execution'
        ) {
            const { provider, model } = parseProviderAndModel(ev.modelName);
            const durationMs = typeof ev.durationMs === 'number' && Number.isFinite(ev.durationMs)
                ? Math.max(0, Math.round(ev.durationMs))
                : 0;
            const inputTokens = typeof ev.prompt === 'string' && ev.prompt.length > 0
                ? estimateTokens(ev.prompt)
                : 0;
            const status: SeatTimingDiagnostic['status'] = action === 'Failed execution'
                ? 'error'
                : (action.includes('failover') ? 'failover' : 'ok');

            seatTimings.push({
                seat,
                role: role || seat,
                provider,
                model,
                durationMs,
                inputTokens,
                status
            });
            continue;
        }

        if (action === 'Provider Failover Triggered') {
            const fo = ev.failover || (ev.output && typeof ev.output === 'object' ? ev.output : undefined);
            const fromProvider = String(fo?.fromProvider || fo?.failedProvider || '').trim();
            const fromModel = String(fo?.fromModel || fo?.failedModel || '').trim();
            const toProvider = String(fo?.toProvider || fo?.fallbackProvider || '').trim();
            const toModel = String(fo?.toModel || fo?.fallbackModel || '').trim();

            // Agent.run emits a raw error event followed immediately by a cascade event with toProvider/toModel.
            // Deduplicate by skipping the raw event when the next event is the matching cascade for the same seat/from.
            if (!toProvider) {
                const next = events[i + 1];
                if (next && next.action === 'Provider Failover Triggered' && next.agentRole === ev.agentRole) {
                    const nextFo = next.failover || (next.output && typeof next.output === 'object' ? next.output : undefined);
                    if (
                        nextFo?.toProvider &&
                        String(nextFo.fromProvider || '').trim() === fromProvider &&
                        String(nextFo.fromModel || '').trim() === fromModel
                    ) {
                        continue;
                    }
                }
            }

            const parsedFrom = fromProvider
                ? { provider: fromProvider, model: fromModel }
                : parseProviderAndModel(ev.modelName);
            const rawStatus = fo?.status;
            const status = typeof rawStatus === 'number' && Number.isFinite(rawStatus)
                ? rawStatus
                : extractHttpStatus(ev.error || fo?.errorSnippet || fo?.reason);
            const rawErr = fo?.errorSnippet || ev.error || fo?.reason || '';
            const error = redactErrorSnippet(rawErr, 160);
            const durationMs = typeof fo?.durationMs === 'number' && Number.isFinite(fo.durationMs)
                ? Math.max(0, Math.round(fo.durationMs))
                : (typeof ev.durationMs === 'number' && Number.isFinite(ev.durationMs) ? Math.max(0, Math.round(ev.durationMs)) : 0);

            failovers.push({
                seat,
                from: formatEndpoint(parsedFrom.provider, parsedFrom.model),
                to: toProvider ? formatEndpoint(toProvider, toModel) : 'none',
                status,
                error,
                durationMs
            });
            continue;
        }

        if (
            (action.includes('Tool') || action.includes('Hop 1') || action.includes('Dossier')) &&
            typeof ev.durationMs === 'number' &&
            Number.isFinite(ev.durationMs)
        ) {
            inferredHop1Ms += Math.max(0, Math.round(ev.durationMs));
        }
    }

    if (Array.isArray(params.activeInFlight)) {
        for (const inflight of params.activeInFlight) {
            if (!inflight || !inflight.seat) continue;
            const seat = canonicalizeSeatId(inflight.seat);
            const durationMs = typeof inflight.startedAt === 'number' && Number.isFinite(inflight.startedAt)
                ? Math.max(0, Math.round(nowMs - inflight.startedAt))
                : totalMs;
            seatTimings.push({
                seat,
                role: inflight.seat,
                provider: String(inflight.provider || 'unknown'),
                model: String(inflight.model || 'unknown'),
                durationMs,
                inputTokens: 0,
                status: 'timeout'
            });
        }
    }

    const hop1ToolsMs = typeof params.hop1ToolsMs === 'number' && Number.isFinite(params.hop1ToolsMs)
        ? Math.max(0, Math.round(params.hop1ToolsMs))
        : inferredHop1Ms;

    const result: CompactRunDiagnostics = {
        totalMs,
        hop1ToolsMs,
        seatTimings,
        failovers
    };

    // Enforce hard < 2 KB budget cleanly
    const fits = () => utf8ByteLength(JSON.stringify(result)) <= maxBytes;
    if (!fits()) {
        for (const cap of [100, 60, 32]) {
            for (const f of result.failovers) {
                f.error = redactErrorSnippet(f.error, cap);
            }
            if (fits()) break;
        }
    }
    while (!fits() && result.failovers.length > 4) {
        result.failovers.shift();
    }
    while (!fits() && result.seatTimings.length > 6) {
        result.seatTimings.shift();
    }
    while (!fits() && result.failovers.length > 1) {
        result.failovers.shift();
    }
    while (!fits() && result.seatTimings.length > 1) {
        result.seatTimings.shift();
    }

    return result;
}
