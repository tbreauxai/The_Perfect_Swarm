export const VALID_DOMAINS = ['odds', 'injury', 'lineup', 'fantasy', 'general'] as const;
export type SwarmDomain = typeof VALID_DOMAINS[number];

export type MemoryType = 'fact' | 'judgment';

export function normalizeDomain(domain?: string | null, fallbackText?: string): string {
    if (domain && typeof domain === 'string') {
        const d = domain.trim().toLowerCase();
        if ((VALID_DOMAINS as readonly string[]).includes(d)) {
            return d;
        }
        return d;
    }
    if (fallbackText && typeof fallbackText === 'string') {
        const lower = fallbackText.toLowerCase();
        for (const vd of ['odds', 'injury', 'lineup', 'fantasy']) {
            if (lower.includes(vd)) return vd;
        }
    }
    return 'general';
}

export function normalizeMemoryType(type?: string | null, meta?: any): MemoryType {
    if (type === 'fact' || type === 'judgment') return type;
    if (meta?.memoryType === 'fact' || meta?.memoryType === 'judgment') return meta.memoryType;
    if (meta?.verified === true || meta?.graded === true || meta?.outcome !== undefined || (typeof meta?.qualityRating === 'number' && meta.qualityRating >= 0.8)) {
        return 'fact';
    }
    return 'judgment';
}

export function extractEntityIds(text?: string | null, explicitIds?: (string | undefined)[]): string[] {
    const ids = new Set<string>();
    if (Array.isArray(explicitIds)) {
        for (const id of explicitIds) {
            if (typeof id === 'string' && id.trim()) {
                ids.add(id.trim().toLowerCase());
            }
        }
    }
    if (text && typeof text === 'string') {
        const directMatches = text.matchAll(/\b((?:team|player|game|entity)-[a-zA-Z0-9_]+)\b/gi);
        for (const m of directMatches) {
            if (m[1]) ids.add(m[1].toLowerCase());
        }
        const entityMarkerMatches = text.matchAll(/\bentity[:\s]+([a-zA-Z0-9_-]+)\b/gi);
        for (const m of entityMarkerMatches) {
            if (m[1]) ids.add(m[1].toLowerCase());
        }
    }
    return Array.from(ids);
}

export interface NormalizedMemoryTags {
    originApp: string;
    appId: string;
    domain: string;
    memoryType: MemoryType;
    entityIds: string[];
}

/**
 * Normalizes memory payload tags.
 * Legacy points without tags are treated as:
 * originApp = payload.appId || 'default'
 * domain = 'general'
 * memoryType = 'judgment'
 * entityIds = []
 */
export function normalizeMemoryPayload(payload: any, defaultAppId: string = 'default'): NormalizedMemoryTags {
    const rawApp = payload?.originApp || payload?.appId || defaultAppId;
    const originApp = String(rawApp).trim() || defaultAppId;
    const domain = payload?.domain ? normalizeDomain(payload.domain) : 'general';
    const memoryType = (payload?.memoryType === 'fact' || payload?.memoryType === 'judgment')
        ? payload.memoryType
        : normalizeMemoryType(payload?.memoryType, payload);
    const entityIds = Array.isArray(payload?.entityIds)
        ? payload.entityIds.map((id: any) => String(id).trim().toLowerCase()).filter(Boolean)
        : [];

    return {
        originApp,
        appId: originApp,
        domain,
        memoryType,
        entityIds
    };
}

export interface ScoredMemoryCandidate {
    id: string;
    payload: any;
    vectorScore: number;
}

/**
 * Computes retrieval blend weight according to swarm policy:
 * - Same originApp and same domain: weight 1.0
 * - Different originApp, same domain, and at least one shared entityId: weight 0.45
 * - Everything else: weight 0 (excluded)
 * - includeShared=false limits to same originApp only
 */
export function computeBlendWeight(
    pointTags: NormalizedMemoryTags,
    readerApp: string,
    requestedDomain: string | undefined,
    queryEntityIds: string[],
    includeShared: boolean = true
): number {
    const isSameOriginApp = pointTags.originApp.toLowerCase() === readerApp.toLowerCase();
    const effectiveReaderDomain = requestedDomain ? requestedDomain.toLowerCase() : 'general';
    const pointDomain = pointTags.domain.toLowerCase();
    const isSameDomain = requestedDomain
        ? (pointDomain === effectiveReaderDomain)
        : (isSameOriginApp ? true : pointDomain === effectiveReaderDomain);

    if (isSameOriginApp && isSameDomain) {
        return 1.0;
    }

    if (!isSameOriginApp && includeShared) {
        if (pointTags.originApp.toLowerCase() === 'global' || pointTags.originApp.toLowerCase() === 'shared') {
            return 0.45;
        }
        if (isSameDomain && queryEntityIds.length > 0 && pointTags.entityIds.length > 0) {
            const hasShared = pointTags.entityIds.some(id =>
                queryEntityIds.some(qid => qid.toLowerCase() === id.toLowerCase())
            );
            if (hasShared) {
                return 0.45;
            }
        }
    }

    return 0;
}

export interface CandidateRankingOptions {
    appId?: string;
    originApp?: string;
    domain?: string;
    entityIds?: string[];
    entityId?: string;
    limit?: number;
    minRating?: number;
    verifiedOnly?: boolean;
    agentRole?: string;
    includeShared?: boolean;
    [key: string]: any;
}

/**
 * Filters and ranks candidate memories using the blended retrieval policy:
 * 1. Filter out weight 0 candidates.
 * 2. Calculate weighted score = vectorScore * weight.
 * 3. Sort where facts outrank judgments at the same weight, then by weighted score.
 * 4. Slice to limit.
 */
export function rankAndFilterCandidates(
    candidates: ScoredMemoryCandidate[],
    options: CandidateRankingOptions,
    query: string,
    defaultAppId: string = 'default'
): any[] {
    const readerApp = options.appId || options.originApp || defaultAppId;
    const requestedDomain = options.domain ? normalizeDomain(options.domain) : undefined;
    const includeShared = options.includeShared !== false;
    const explicitEntities = options.entityIds || (options.entityId ? [options.entityId] : []);
    const queryEntities = extractEntityIds(query, explicitEntities);

    const scored: {
        id: string;
        payload: any;
        vectorScore: number;
        weight: number;
        finalScore: number;
        memoryType: MemoryType;
    }[] = [];

    for (const c of candidates) {
        const tags = normalizeMemoryPayload(c.payload, defaultAppId);
        const weight = computeBlendWeight(tags, readerApp, requestedDomain, queryEntities, includeShared);
        if (weight <= 0) continue;

        if (options.minRating !== undefined && (c.payload.qualityRating ?? 0) < options.minRating) continue;
        if (options.verifiedOnly && tags.memoryType !== 'fact') continue;
        if (options.agentRole && c.payload.agentRole !== options.agentRole) continue;

        const finalScore = c.vectorScore * weight;
        scored.push({
            id: c.id,
            payload: {
                ...c.payload,
                originApp: tags.originApp,
                appId: tags.originApp,
                domain: tags.domain,
                memoryType: tags.memoryType,
                entityIds: tags.entityIds,
                retrievalWeight: weight,
                retrievalScore: finalScore,
                rawSimilarity: c.vectorScore
            },
            vectorScore: c.vectorScore,
            weight,
            finalScore,
            memoryType: tags.memoryType
        });
    }

    scored.sort((a, b) => {
        // At the same blend weight (e.g. both same-app 1.0 or both sibling 0.45):
        if (Math.abs(a.weight - b.weight) < 1e-4) {
            // 1. Facts outrank judgments at the same weight.
            // Graded outcomes are facts, so placeholder 0.85 judgments do NOT outrank a graded loss.
            if (a.memoryType !== b.memoryType) {
                return a.memoryType === 'fact' ? -1 : 1;
            }

            // 2. For the same domain and entity (or between graded outcomes), retrieval uses the outcome score:
            // win (1.0) ranks above push (0.5), which ranks above loss (0.0).
            const sameDomain = a.payload.domain === b.payload.domain;
            const sharedEntity = (a.payload.entityIds || []).some((id: string) => (b.payload.entityIds || []).includes(id)) ||
                (queryEntities.length > 0 &&
                    (a.payload.entityIds || []).some((id: string) => queryEntities.includes(id)) &&
                    (b.payload.entityIds || []).some((id: string) => queryEntities.includes(id)));

            if (sameDomain && (sharedEntity || (a.payload.outcome && b.payload.outcome))) {
                const aRating = typeof a.payload.qualityRating === 'number' ? a.payload.qualityRating : 0.5;
                const bRating = typeof b.payload.qualityRating === 'number' ? b.payload.qualityRating : 0.5;
                if (Math.abs(bRating - aRating) > 1e-4) {
                    return bRating - aRating;
                }
            }

            // 3. Otherwise rank by vector similarity / finalScore
            const diff = b.finalScore - a.finalScore;
            if (Math.abs(diff) > 1e-6) {
                return diff;
            }
            return b.vectorScore - a.vectorScore;
        }

        // When blend weights differ (e.g. same-app 1.0 vs sibling 0.45):
        // 1. Sibling weight 0.45 scales finalScore (vectorScore * weight), so same-app outranks sibling for similar relevance.
        const diff = b.finalScore - a.finalScore;
        if (Math.abs(diff) > 1e-4) {
            return diff;
        }

        // 2. Fact outranks judgment if finalScores are tied across apps
        if (a.memoryType !== b.memoryType) {
            return a.memoryType === 'fact' ? -1 : 1;
        }

        return b.vectorScore - a.vectorScore;
    });

    const limit = options.limit || 3;
    return scored.slice(0, limit).map(s => s.payload);
}

