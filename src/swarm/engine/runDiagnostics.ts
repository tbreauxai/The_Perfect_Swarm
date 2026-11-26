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
    status: 'ok' | 'failover' | 'error' | 'timeout' | 'parse_failed';
}

export interface FailoverDiagnostic {
    seat: string;
    from: string;
    to: string;
    status: number | null;
    reason?: string;
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
    if (p && m) {
        if (m.toLowerCase().startsWith(`${p.toLowerCase()}/`)) return m;
        return `${p}/${m}`;
    }
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

    interface PendingSeatFailure {
        from: string;
        to: string;
        status: number | null;
        reason?: string;
        error: string;
        durationMs: number;
        failoverIdx?: number;
        isCooldownSkip?: boolean;
    }

    const configuredEndpointBySeat = new Map<string, string>();
    const episodeStartFailoverIdxBySeat = new Map<string, number>();
    const pendingFailuresBySeat = new Map<string, PendingSeatFailure[]>();

    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (!ev || typeof ev !== 'object') continue;
        const action = String(ev.action || '');
        const role = String(ev.agentRole || '').trim();
        const seat = canonicalizeSeatId(role);

        if (action === 'Started execution') {
            const { provider, model } = parseProviderAndModel(ev.modelName);
            const configured = formatEndpoint(provider, model);
            if (configured !== 'unknown' && configured !== 'unknown/unknown') {
                configuredEndpointBySeat.set(seat, configured);
            }
            episodeStartFailoverIdxBySeat.set(seat, failovers.length);
            pendingFailuresBySeat.set(seat, []);
            continue;
        }

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
            const isParseFailedErr =
                typeof ev.error === 'string' && /parse_failed|unparsed_json|unparsed output|max_tokens/i.test(ev.error);

            const executedEndpoint = formatEndpoint(provider, model);
            const configuredEndpoint = configuredEndpointBySeat.get(seat);
            const shiftedFromConfigured = Boolean(
                action !== 'Failed execution' &&
                configuredEndpoint &&
                configuredEndpoint !== 'unknown' &&
                configuredEndpoint !== 'unknown/unknown' &&
                executedEndpoint !== 'unknown' &&
                executedEndpoint !== 'unknown/unknown' &&
                configuredEndpoint !== executedEndpoint
            );

            const status: SeatTimingDiagnostic['status'] = action === 'Failed execution'
                ? (isParseFailedErr ? 'parse_failed' : 'error')
                : ((action.includes('failover') || shiftedFromConfigured) ? 'failover' : 'ok');

            seatTimings.push({
                seat,
                role: role || seat,
                provider,
                model,
                durationMs,
                inputTokens,
                status
            });

            if (action !== 'Failed execution') {
                const episodeStartIdx = episodeStartFailoverIdxBySeat.get(seat) ?? 0;
                const episodeFailovers = failovers
                    .slice(episodeStartIdx)
                    .filter(f => f.seat === seat);

                // Backfill any unresolved 'to: "none"' records in this episode with actual executed endpoint
                for (const fo of episodeFailovers) {
                    if ((!fo.to || fo.to === 'none' || fo.to === 'unknown') && executedEndpoint !== 'unknown') {
                        fo.to = executedEndpoint;
                    }
                }

                // Safeguard: if this seat completed via failover or executed on a different provider/model than
                // configured and still has no failover entry for this episode, promote its skip/failure event
                // or synthesize one so diagnostics.failovers is never [] when a seat failed over.
                if (status === 'failover' && episodeFailovers.length === 0) {
                    const seatFailures = pendingFailuresBySeat.get(seat) || [];
                    const preferredFailure =
                        seatFailures.find(pf => configuredEndpoint && pf.from === configuredEndpoint) ||
                        seatFailures[0];
                    if (preferredFailure) {
                        const foEntry: FailoverDiagnostic = {
                            seat,
                            from: preferredFailure.from,
                            to: (preferredFailure.to && preferredFailure.to !== 'none' && preferredFailure.to !== 'unknown')
                                ? preferredFailure.to
                                : executedEndpoint,
                            status: preferredFailure.status,
                            ...(preferredFailure.reason ? { reason: preferredFailure.reason } : {}),
                            error: preferredFailure.error,
                            durationMs: preferredFailure.durationMs
                        };
                        failovers.push(foEntry);
                    } else {
                        failovers.push({
                            seat,
                            from: configuredEndpoint || 'unknown',
                            to: executedEndpoint,
                            status: null,
                            error: redactErrorSnippet(ev.error || 'Failover transition executed without failure event', 160),
                            durationMs: 0
                        });
                    }
                }
            }

            episodeStartFailoverIdxBySeat.set(seat, failovers.length);
            pendingFailuresBySeat.set(seat, []);
            continue;
        }

        if (action === 'Provider Skipped') {
            const fo = ev.failover || (ev.output && typeof ev.output === 'object' ? ev.output : undefined);
            const rawReason = typeof fo?.reason === 'string' ? fo.reason.trim() : '';
            const promptStr = typeof ev.prompt === 'string' ? ev.prompt : '';
            const snippetStr = typeof fo?.errorSnippet === 'string' ? fo.errorSnippet : '';
            const fromProvider = String(fo?.fromProvider || fo?.provider || '').trim();
            const fromModel = String(fo?.fromModel || fo?.model || '').trim();
            const toProvider = String(fo?.toProvider || fo?.fallbackProvider || '').trim();
            const toModel = String(fo?.toModel || fo?.fallbackModel || '').trim();
            const parsedFrom = fromProvider
                ? { provider: fromProvider, model: fromModel }
                : parseProviderAndModel(ev.modelName);
            const isBillingCooldownSkip =
                rawReason === '[BILLING_COOLDOWN_SKIP]' ||
                rawReason.includes('[BILLING_COOLDOWN_SKIP]') ||
                snippetStr.includes('[BILLING_COOLDOWN_SKIP]') ||
                promptStr.includes('[BILLING_COOLDOWN_SKIP]');
            const isCooldownSkip =
                isBillingCooldownSkip ||
                rawReason === '[COOLDOWN_SKIP]' ||
                rawReason.includes('[COOLDOWN_SKIP]') ||
                snippetStr.includes('[COOLDOWN_SKIP]') ||
                promptStr.includes('[COOLDOWN_SKIP]');
            const rawErr = fo?.errorSnippet || rawReason || promptStr || '[SKIPPED]';
            const rawStatus = fo?.status;
            const status = typeof rawStatus === 'number' && Number.isFinite(rawStatus)
                ? rawStatus
                : extractHttpStatus(rawErr);
            const reasonCode = isBillingCooldownSkip
                ? '[BILLING_COOLDOWN_SKIP]'
                : (isCooldownSkip
                    ? '[COOLDOWN_SKIP]'
                    : (/^(?:LIMITER_SKIP|dead_model|unparsed_json|max_tokens|[a-z0-9_:-]{3,40})$/i.test(rawReason) ? rawReason : undefined));
            const skipDurationMs = typeof fo?.durationMs === 'number' && Number.isFinite(fo.durationMs)
                ? Math.max(0, Math.round(fo.durationMs))
                : (typeof ev.durationMs === 'number' && Number.isFinite(ev.durationMs) ? Math.max(0, Math.round(ev.durationMs)) : 0);

            const fromEp = formatEndpoint(parsedFrom.provider, parsedFrom.model);
            const toEp = toProvider ? formatEndpoint(toProvider, toModel) : 'none';
            const errorText = redactErrorSnippet(rawErr, 160);

            const pendingList = pendingFailuresBySeat.get(seat) || [];
            const pendingRec: PendingSeatFailure = {
                from: fromEp,
                to: toEp,
                status,
                ...(reasonCode ? { reason: reasonCode } : {}),
                error: errorText,
                durationMs: skipDurationMs,
                isCooldownSkip
            };

            if (isCooldownSkip) {
                pendingRec.failoverIdx = failovers.length;
                failovers.push({
                    seat,
                    from: fromEp,
                    to: toEp,
                    status,
                    reason: reasonCode || '[COOLDOWN_SKIP]',
                    error: errorText,
                    durationMs: skipDurationMs
                });
            }
            pendingList.push(pendingRec);
            pendingFailuresBySeat.set(seat, pendingList);
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
            const rawReason = typeof fo?.reason === 'string' ? fo.reason.trim() : '';
            const isExplicitReasonCode =
                rawReason === 'unparsed_json' ||
                rawReason === 'max_tokens' ||
                rawReason === '[COOLDOWN_SKIP]' ||
                rawReason === '[BILLING_COOLDOWN_SKIP]' ||
                /^[a-z0-9_:-]{3,40}$/i.test(rawReason);
            const rawErr = fo?.errorSnippet || ev.error || rawReason || '';
            const error = redactErrorSnippet(rawErr, isExplicitReasonCode && (rawReason === 'unparsed_json' || rawReason === 'max_tokens') ? 120 : 160);
            const durationMs = typeof fo?.durationMs === 'number' && Number.isFinite(fo.durationMs)
                ? Math.max(0, Math.round(fo.durationMs))
                : (typeof ev.durationMs === 'number' && Number.isFinite(ev.durationMs) ? Math.max(0, Math.round(ev.durationMs)) : 0);

            const foEntry: FailoverDiagnostic = {
                seat,
                from: formatEndpoint(parsedFrom.provider, parsedFrom.model),
                to: toProvider ? formatEndpoint(toProvider, toModel) : 'none',
                status,
                ...(isExplicitReasonCode ? { reason: rawReason } : {}),
                error,
                durationMs
            };
            const failoverIdx = failovers.length;
            failovers.push(foEntry);

            const pendingList = pendingFailuresBySeat.get(seat) || [];
            pendingList.push({
                from: foEntry.from,
                to: foEntry.to,
                status: foEntry.status,
                ...(foEntry.reason ? { reason: foEntry.reason } : {}),
                error: foEntry.error,
                durationMs: foEntry.durationMs,
                failoverIdx
            });
            pendingFailuresBySeat.set(seat, pendingList);
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

    // Final safeguard: ensure every seatTimings entry with status === 'failover'
    // has a corresponding record in failovers[] (never synthesize when status === 'ok').
    const coveredSeats = new Set<string>(failovers.map(f => f.seat));
    for (const st of seatTimings) {
        const executedEp = formatEndpoint(st.provider, st.model);
        const configuredEp = configuredEndpointBySeat.get(st.seat);
        const needsFailoverRecord = st.status === 'failover';
        if (needsFailoverRecord && !coveredSeats.has(st.seat)) {
            const pendingList = pendingFailuresBySeat.get(st.seat) || [];
            const firstFailure = pendingList[0];
            failovers.push({
                seat: st.seat,
                from: firstFailure?.from || configuredEp || 'unknown',
                to: (firstFailure?.to && firstFailure.to !== 'none' && firstFailure.to !== 'unknown')
                    ? firstFailure.to
                    : executedEp,
                status: firstFailure?.status ?? null,
                ...(firstFailure?.reason ? { reason: firstFailure.reason } : {}),
                error: redactErrorSnippet(firstFailure?.error || 'Failover transition detected from seat execution', 160),
                durationMs: firstFailure?.durationMs ?? 0
            });
            coveredSeats.add(st.seat);
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
