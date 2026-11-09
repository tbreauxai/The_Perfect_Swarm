import type { StoredMemoryPoint, SparseVector } from '../types.ts';
import type { VectorIndexMetrics } from '../../vectorIndex.ts';

export interface StorageFilterOptions {
    originApp?: string;
    appId?: string;
    domain?: string;
    sport?: string;
    entityIds?: string[];
    entityId?: string;
    eventIds?: string[];
    eventId?: string;
    asOf?: string;
    publicOnly?: boolean;
    snapshotHash?: string;
    agentRole?: string;
    minRating?: number;
    verifiedOnly?: boolean;
    includeShared?: boolean;
    targetApps?: string | string[];
    maxPoints?: number;
    ruleType?: string;
    marketType?: string;
}

export interface StorageQueryOptions extends StorageFilterOptions {
    limit?: number;
    scoreThreshold?: number;
    queryText?: string;
    rrfK?: number;
    prefetchLimit?: number;
    prefetchFactor?: number;
    hnswEf?: number;
}

export interface StorageQueryResult {
    id: string;
    payload: Record<string, any>;
    vectorScore: number;
}

export interface StorageBackend {
    readonly isAvailable: boolean;
    readonly size: number;
    initialize(appId?: string): Promise<boolean>;
    store(point: StoredMemoryPoint, deduplicate?: boolean): Promise<string | null>;
    storeBatch(points: StoredMemoryPoint[], options?: { deduplicate?: boolean }): Promise<string[]>;
    get(id: string): Promise<StoredMemoryPoint | null>;
    setPayload(id: string, payload: Partial<Record<string, any>>): Promise<boolean>;
    search(queryDense: number[], options: StorageQueryOptions, querySparse?: SparseVector): Promise<StorageQueryResult[]>;
    delete(ids: string[]): Promise<boolean>;
    wipe(appId?: string): Promise<boolean>;
    scroll(filter?: StorageFilterOptions): Promise<StoredMemoryPoint[]>;
    getIndexMetrics?(): VectorIndexMetrics;
}

const TIMESTAMP_FIELDS = [
    'available_at',
    'availableAt',
    'updated_at',
    'updatedAt',
    'graded_at',
    'gradedAt',
    'source_available_at',
    'sourceAvailableAt',
    'created_at',
    'createdAt',
    'timestamp',
    'date'
] as const;

export function normalizeMemorySportToken(raw: unknown): string {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return '';
    if (s === 'americanfootball_nfl' || s === 'nfl') return 'nfl';
    if (s === 'basketball_nba' || s === 'nba') return 'nba';
    if (s === 'baseball_mlb' || s === 'mlb') return 'mlb';
    if (s === 'icehockey_nhl' || s === 'nhl') return 'nhl';
    if (s === 'americanfootball_ncaaf' || s === 'ncaaf') return 'ncaaf';
    if (s === 'basketball_ncaab' || s === 'ncaab') return 'ncaab';
    return s;
}

export function matchesScopedMemoryFilter(
    payload: Record<string, any> | undefined | null,
    options?: StorageFilterOptions
): boolean {
    if (!payload || typeof payload !== 'object') return false;

    // 1. Always reject private, user-scoped, or unknown-ownership memory points
    if (payload.private === true || payload.isPrivate === true) {
        return false;
    }
    if (
        (typeof payload.userId === 'string' && payload.userId.trim()) ||
        (typeof payload.user_id === 'string' && payload.user_id.trim()) ||
        (typeof payload.ownerId === 'string' && payload.ownerId.trim()) ||
        (typeof payload.owner_id === 'string' && payload.owner_id.trim())
    ) {
        return false;
    }
    if (payload.visibility !== undefined && payload.visibility !== null) {
        if (String(payload.visibility).trim().toLowerCase() !== 'public') {
            return false;
        }
    }
    if (payload.ownership !== undefined && payload.ownership !== null) {
        const own = String(payload.ownership).trim().toLowerCase();
        if (own !== 'public' && own !== 'shared' && own !== 'system') {
            return false;
        }
    }
    if (payload.scope !== undefined && payload.scope !== null) {
        const sc = String(payload.scope).trim().toLowerCase();
        if (sc === 'private' || sc === 'user' || sc === 'personal' || sc === 'unknown') {
            return false;
        }
    }

    if (!options) return true;

    const reqEntities = [
        ...(Array.isArray(options.entityIds) ? options.entityIds : []),
        ...(typeof options.entityId === 'string' ? [options.entityId] : [])
    ]
        .map((e) => String(e || '').trim().toUpperCase())
        .filter(Boolean);

    const reqEvents = [
        ...(Array.isArray(options.eventIds) ? options.eventIds : []),
        ...(typeof options.eventId === 'string' ? [options.eventId] : [])
    ]
        .map((e) => String(e || '').trim())
        .filter(Boolean);

    const strictScopeActive =
        options.includeShared === false ||
        options.publicOnly === true ||
        options.asOf !== undefined ||
        options.sport !== undefined ||
        reqEvents.length > 0;

    // 2. Enforce appId / originApp binding when strict scope is active
    const readerApp = options.appId || options.originApp;
    if (strictScopeActive && readerApp) {
        const itemApp = payload.originApp || payload.appId || payload.app_id;
        if (!itemApp || String(itemApp).trim() !== readerApp.trim()) {
            return false;
        }
    }

    // 3. Enforce explicit public visibility when publicOnly is requested
    if (options.publicOnly === true) {
        if (payload.visibility !== undefined && String(payload.visibility).toLowerCase() !== 'public') {
            return false;
        }
        if (payload.ownership !== undefined && String(payload.ownership).toLowerCase() !== 'public') {
            return false;
        }
    }

    // 4. Enforce sport filter
    if (options.sport !== undefined && options.sport.trim() !== '') {
        const itemSport = payload.sport || payload.sportKey || payload.sport_key;
        if (
            !itemSport ||
            normalizeMemorySportToken(itemSport) !== normalizeMemorySportToken(options.sport)
        ) {
            return false;
        }
    }

    // 5. Enforce entityIds / eventIds filter
    if (reqEntities.length > 0 || reqEvents.length > 0) {
        const ptEntities = new Set<string>();
        if (Array.isArray(payload.entityIds)) {
            for (const ent of payload.entityIds) {
                const t = String(ent || '').trim().toUpperCase();
                if (t) ptEntities.add(t);
            }
        }
        for (const k of ['entityId', 'team_id', 'home_team_id', 'away_team_id'] as const) {
            if (typeof payload[k] === 'string' && payload[k].trim()) {
                ptEntities.add(payload[k].trim().toUpperCase());
            }
        }

        const ptEvents = new Set<string>();
        if (Array.isArray(payload.eventIds)) {
            for (const ev of payload.eventIds) {
                const t = String(ev || '').trim();
                if (t) ptEvents.add(t);
            }
        }
        for (const k of ['eventId', 'event_id'] as const) {
            if (typeof payload[k] === 'string' && payload[k].trim()) {
                ptEvents.add(payload[k].trim());
            }
        }

        if (reqEntities.length > 0 && reqEvents.length > 0) {
            if (ptEntities.size > 0) {
                const entityHit = reqEntities.some((e) => ptEntities.has(e));
                if (!entityHit) return false;
            } else if (ptEvents.size > 0) {
                const eventHit = reqEvents.some((ev) => ptEvents.has(ev));
                if (!eventHit) return false;
            } else {
                return false;
            }
        } else if (reqEntities.length > 0) {
            if (ptEntities.size === 0) return false;
            const entityHit = reqEntities.some((e) => ptEntities.has(e));
            if (!entityHit) return false;
        } else if (reqEvents.length > 0) {
            if (ptEvents.size === 0) return false;
            const eventHit = reqEvents.some((ev) => ptEvents.has(ev));
            if (!eventHit) return false;
        }
    }

    // 6. Enforce asOf temporal cutoff across all availability/update/grading timestamps
    if (options.asOf !== undefined) {
        const asOfMs = Date.parse(String(options.asOf).trim());
        if (!Number.isFinite(asOfMs)) return false;

        let hasTimestamp = false;
        for (const field of TIMESTAMP_FIELDS) {
            const rawTs = payload[field];
            if (rawTs === undefined || rawTs === null || rawTs === '') continue;
            const tsMs = typeof rawTs === 'number' ? rawTs : Date.parse(String(rawTs).trim());
            if (!Number.isFinite(tsMs) || tsMs > asOfMs) {
                return false;
            }
            hasTimestamp = true;
        }
        if (!hasTimestamp) {
            return false;
        }
    }

    // 7. Enforce ruleType and marketType filters
    if (options.ruleType !== undefined && options.ruleType.trim() !== '') {
        const itemRuleType = payload.rule_type || payload.ruleType;
        if (itemRuleType !== options.ruleType) return false;
    }
    if (options.marketType !== undefined && options.marketType.trim() !== '') {
        const itemMarketType = payload.market_type || payload.marketType;
        if (itemMarketType !== options.marketType) return false;
    }

    return true;
}
