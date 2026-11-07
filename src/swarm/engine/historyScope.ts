export const HISTORY_CONTEXT_SECTIONS = [
    'game',
    'venue',
    'form',
    'h2h',
    'injuries',
    'weather',
    'odds'
] as const;

export const HISTORY_OPTIONAL_CONTEXT = ['lessons'] as const;

export const HISTORY_PURPOSES = ['parlay', 'bet-chat', 'morning'] as const;

export type HistoryContextSectionKey = (typeof HISTORY_CONTEXT_SECTIONS)[number];
export type HistoryOptionalContextKey = (typeof HISTORY_OPTIONAL_CONTEXT)[number];
export type HistoryPurpose = (typeof HISTORY_PURPOSES)[number];

export const MAX_RETRIEVAL_GROUPS = 4;
export const MAX_UNIQUE_EVENTS = 20;
export const MAX_UNIQUE_ENTITIES = 40;
export const MAX_ENVELOPE_METADATA_BYTES = 4096;
export const MAX_REQUEST_ID_LENGTH = 128;
export const MAX_ID_BYTE_LENGTH = 128;
export const MAX_SPORT_BYTE_LENGTH = 64;
export const PUBLIC_DUELODDS_APP_ID = 'duelodds';

export interface RetrievalContextGroup {
    sport: string;
    date: string;
    eventIds: string[];
    entityIds?: string[];
}

export interface RetrievalContextEnvelope {
    version: 1;
    requestId?: string;
    purpose?: HistoryPurpose;
    asOf?: string;
    groups: RetrievalContextGroup[];
    requiredContext?: HistoryContextSectionKey[];
    optionalContext?: HistoryOptionalContextKey[];
}

export interface SnapshotRef {
    event_id: string;
    game_date: string;
    sport: string;
    snapshot_id: string;
    content_hash: string;
}

export interface TrustedRetrievalScope {
    callerAppId: string;
    asOf: string;
    asOfMs: number;
    requestReceivedAt: string;
    requestReceivedAtMs: number;
    requestId?: string;
    purpose?: HistoryPurpose;
    groups: RetrievalContextGroup[];
    eventIds: string[];
    entityIds: string[];
    sport?: string;
    date?: string;
    requiredContext: HistoryContextSectionKey[];
    optionalContext: HistoryOptionalContextKey[];
    snapshotRefs: SnapshotRef[];
    hasExplicitRetrievalContext: boolean;
    usesContextStore: boolean;
}

export type RetrievalScopeValidationResult =
    | {
          ok: true;
          scope: TrustedRetrievalScope;
          retrievalContext?: RetrievalContextEnvelope;
          snapshotRefs?: SnapshotRef[];
          status?: 400;
          error?: string;
          reason?: string;
      }
    | {
          ok: false;
          status: 400;
          error: string;
          reason: string;
      };

const ALLOWED_ENVELOPE_KEYS = new Set<string>([
    'version',
    'requestId',
    'purpose',
    'asOf',
    'groups',
    'requiredContext',
    'optionalContext',
    'snapshotRefs'
]);

const ALLOWED_GROUP_KEYS = new Set<string>(['sport', 'date', 'eventIds', 'entityIds']);

const ALLOWED_SNAPSHOT_REF_KEYS = new Set<string>([
    'event_id',
    'game_date',
    'sport',
    'snapshot_id',
    'content_hash'
]);

const SECTION_SET = new Set<string>(HISTORY_CONTEXT_SECTIONS);
const OPTIONAL_SECTION_SET = new Set<string>(HISTORY_OPTIONAL_CONTEXT);
const PURPOSE_SET = new Set<string>(HISTORY_PURPOSES);

const RFC3339_UTC_REGEX =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const DATE_YYYY_MM_DD_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const REQUEST_ID_ASCII_REGEX = /^[\x20-\x7E]{1,128}$/;
const SAFE_TOKEN_REGEX = /^[\x21-\x7E]+$/;
const SAFE_ENTITY_REGEX = /^[\x20-\x7E]+$/;
const SHA256_HEX_LOWER_REGEX = /^[0-9a-f]{64}$/;

export function utf8ByteLength(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

export function isValidCalendarDate(dateStr: string): boolean {
    const match = DATE_YYYY_MM_DD_REGEX.exec(dateStr);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    const dt = new Date(Date.UTC(year, month - 1, day));
    return (
        dt.getUTCFullYear() === year &&
        dt.getUTCMonth() === month - 1 &&
        dt.getUTCDate() === day
    );
}

export function parseAndValidateAsOf(
    rawAsOf: unknown,
    requestReceivedAt: Date = new Date()
):
    | { ok: true; asOf: string; asOfMs: number; reason?: string; message?: string }
    | { ok: false; reason: string; message: string } {
    const receivedMs = requestReceivedAt.getTime();
    if (rawAsOf === undefined || rawAsOf === null) {
        return {
            ok: true,
            asOf: requestReceivedAt.toISOString(),
            asOfMs: receivedMs
        };
    }
    if (typeof rawAsOf !== 'string') {
        return {
            ok: false,
            reason: 'invalid_as_of_format',
            message: 'asOf must be an RFC3339 UTC timestamp string'
        };
    }
    const trimmed = rawAsOf.trim();
    if (!trimmed || trimmed.length > 64) {
        return {
            ok: false,
            reason: 'invalid_as_of_format',
            message: 'asOf must be a non-empty RFC3339 UTC timestamp string'
        };
    }
    const match = RFC3339_UTC_REGEX.exec(trimmed);
    if (!match) {
        return {
            ok: false,
            reason: 'invalid_as_of_format',
            message: 'asOf must be a valid RFC3339 timestamp with explicit UTC/offset'
        };
    }
    const datePart = `${match[1]}-${match[2]}-${match[3]}`;
    if (!isValidCalendarDate(datePart)) {
        return {
            ok: false,
            reason: 'invalid_as_of_calendar_date',
            message: 'asOf contains an invalid calendar date'
        };
    }
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    if (hour > 23 || minute > 59 || second > 59) {
        return {
            ok: false,
            reason: 'invalid_as_of_time',
            message: 'asOf contains an invalid clock time'
        };
    }
    const offsetPart = match[8];
    if (offsetPart !== 'Z') {
        const offHour = Number(offsetPart.slice(1, 3));
        const offMin = Number(offsetPart.slice(4, 6));
        if (offHour > 23 || offMin > 59) {
            return {
                ok: false,
                reason: 'invalid_as_of_offset',
                message: 'asOf contains an invalid timezone offset'
            };
        }
    }

    const parsedMs = Date.parse(trimmed);
    if (!Number.isFinite(parsedMs)) {
        return {
            ok: false,
            reason: 'invalid_as_of_format',
            message: 'asOf could not be parsed as a valid timestamp'
        };
    }
    if (parsedMs > receivedMs) {
        return {
            ok: false,
            reason: 'future_as_of_cutoff',
            message: 'asOf timestamp cannot be in the future'
        };
    }
    return {
        ok: true,
        asOf: new Date(parsedMs).toISOString(),
        asOfMs: parsedMs
    };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateIdArray(
    raw: unknown,
    fieldName: string,
    allowSpaces: boolean
):
    | { ok: true; values: string[]; reason?: string; message?: string }
    | { ok: false; reason: string; message: string } {
    if (!Array.isArray(raw)) {
        return {
            ok: false,
            reason: `invalid_${fieldName}`,
            message: `${fieldName} must be an array of strings`
        };
    }
    const result: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        if (typeof item !== 'string') {
            return {
                ok: false,
                reason: `invalid_${fieldName}`,
                message: `${fieldName} entries must be strings`
            };
        }
        const trimmed = item.trim();
        if (!trimmed) {
            return {
                ok: false,
                reason: `empty_${fieldName}_entry`,
                message: `${fieldName} entries must be non-empty strings`
            };
        }
        if (utf8ByteLength(trimmed) > MAX_ID_BYTE_LENGTH) {
            return {
                ok: false,
                reason: `${fieldName}_entry_too_long`,
                message: `${fieldName} entry exceeds ${MAX_ID_BYTE_LENGTH} bytes`
            };
        }
        const pattern = allowSpaces ? SAFE_ENTITY_REGEX : SAFE_TOKEN_REGEX;
        if (!pattern.test(trimmed)) {
            return {
                ok: false,
                reason: `invalid_${fieldName}_chars`,
                message: `${fieldName} entry contains invalid characters`
            };
        }
        if (!seen.has(trimmed)) {
            seen.add(trimmed);
            result.push(trimmed);
        }
    }
    return { ok: true, values: result };
}

function validateSnapshotRefs(
    rawRefs: unknown,
    groups: RetrievalContextGroup[]
):
    | { ok: true; refs: SnapshotRef[]; reason?: string; message?: string }
    | { ok: false; reason: string; message: string } {
    if (rawRefs === undefined) {
        return { ok: true, refs: [] };
    }
    if (!Array.isArray(rawRefs)) {
        return {
            ok: false,
            reason: 'invalid_snapshot_refs',
            message: 'snapshotRefs must be an array'
        };
    }
    if (rawRefs.length > MAX_UNIQUE_EVENTS) {
        return {
            ok: false,
            reason: 'snapshot_refs_limit_exceeded',
            message: `snapshotRefs cannot exceed ${MAX_UNIQUE_EVENTS} items`
        };
    }
    const allowedEventKeys = new Set<string>();
    for (const g of groups) {
        for (const evId of g.eventIds) {
            allowedEventKeys.add(`${g.sport}|${g.date}|${evId}`);
        }
    }

    const refs: SnapshotRef[] = [];
    const seenEvents = new Set<string>();
    for (const item of rawRefs) {
        if (!isPlainObject(item)) {
            return {
                ok: false,
                reason: 'invalid_snapshot_ref_item',
                message: 'Each snapshotRef must be an object'
            };
        }
        for (const k of Object.keys(item)) {
            if (!ALLOWED_SNAPSHOT_REF_KEYS.has(k)) {
                return {
                    ok: false,
                    reason: 'unexpected_snapshot_ref_field',
                    message: `Unexpected field in snapshotRefs: ${k}`
                };
            }
        }
        const eventId = typeof item.event_id === 'string' ? item.event_id.trim() : '';
        const gameDate = typeof item.game_date === 'string' ? item.game_date.trim() : '';
        const sport = typeof item.sport === 'string' ? item.sport.trim() : '';
        const snapshotId = typeof item.snapshot_id === 'string' ? item.snapshot_id.trim() : '';
        const contentHash = typeof item.content_hash === 'string' ? item.content_hash.trim() : '';

        if (
            !eventId ||
            utf8ByteLength(eventId) > MAX_ID_BYTE_LENGTH ||
            !SAFE_TOKEN_REGEX.test(eventId)
        ) {
            return {
                ok: false,
                reason: 'invalid_snapshot_ref_event_id',
                message: 'snapshotRef.event_id must be a valid non-empty ID'
            };
        }
        if (!isValidCalendarDate(gameDate)) {
            return {
                ok: false,
                reason: 'invalid_snapshot_ref_date',
                message: 'snapshotRef.game_date must be YYYY-MM-DD'
            };
        }
        if (
            !sport ||
            utf8ByteLength(sport) > MAX_SPORT_BYTE_LENGTH ||
            !SAFE_TOKEN_REGEX.test(sport)
        ) {
            return {
                ok: false,
                reason: 'invalid_snapshot_ref_sport',
                message: 'snapshotRef.sport must be a valid non-empty sport key'
            };
        }
        if (
            !snapshotId ||
            utf8ByteLength(snapshotId) > MAX_ID_BYTE_LENGTH ||
            !SAFE_TOKEN_REGEX.test(snapshotId)
        ) {
            return {
                ok: false,
                reason: 'invalid_snapshot_ref_id',
                message: 'snapshotRef.snapshot_id must be a valid non-empty ID'
            };
        }
        if (!SHA256_HEX_LOWER_REGEX.test(contentHash)) {
            return {
                ok: false,
                reason: 'invalid_snapshot_ref_hash',
                message: 'snapshotRef.content_hash must be 64 lowercase hex characters'
            };
        }
        const compositeKey = `${sport}|${gameDate}|${eventId}`;
        if (allowedEventKeys.size > 0 && !allowedEventKeys.has(compositeKey)) {
            return {
                ok: false,
                reason: 'snapshot_ref_out_of_scope',
                message: `snapshotRef (${sport}, ${gameDate}, ${eventId}) does not match any requested group`
            };
        }
        if (seenEvents.has(compositeKey)) {
            return {
                ok: false,
                reason: 'duplicate_snapshot_ref',
                message: `Duplicate snapshotRef for (${sport}, ${gameDate}, ${eventId})`
            };
        }
        seenEvents.add(compositeKey);
        refs.push({
            event_id: eventId,
            game_date: gameDate,
            sport,
            snapshot_id: snapshotId,
            content_hash: contentHash
        });
    }
    return { ok: true, refs };
}

export interface ResolveRetrievalScopeInput {
    body?: Record<string, unknown> | null;
    callerAppId?: string;
    defaultAppId?: string;
    now?: Date;
}

export function resolveTrustedRetrievalScope(
    input: ResolveRetrievalScopeInput
): RetrievalScopeValidationResult {
    const requestReceivedAt = input.now ?? new Date();
    const requestReceivedAtIso = requestReceivedAt.toISOString();
    const requestReceivedAtMs = requestReceivedAt.getTime();

    const trustedCallerAppId =
        (typeof input.callerAppId === 'string' && input.callerAppId.trim()) ||
        (typeof input.defaultAppId === 'string' && input.defaultAppId.trim()) ||
        'perfect-swarm';

    const body = isPlainObject(input.body) ? input.body : {};
    const hasExplicitRetrievalContext = body.retrievalContext !== undefined;

    // Validate metadata byte size cap (<= 4096 UTF-8 bytes)
    if (hasExplicitRetrievalContext || body.snapshotRefs !== undefined) {
        const envelopePayload: Record<string, unknown> = {};
        if (hasExplicitRetrievalContext) envelopePayload.retrievalContext = body.retrievalContext;
        if (body.snapshotRefs !== undefined) envelopePayload.snapshotRefs = body.snapshotRefs;
        let serializedMeta = '';
        try {
            serializedMeta = JSON.stringify(envelopePayload);
        } catch {
            return {
                ok: false,
                status: 400,
                error: 'Invalid retrievalContext metadata',
                reason: 'unserializable_envelope'
            };
        }
        if (utf8ByteLength(serializedMeta) > MAX_ENVELOPE_METADATA_BYTES) {
            return {
                ok: false,
                status: 400,
                error: `retrievalContext metadata exceeds ${MAX_ENVELOPE_METADATA_BYTES} UTF-8 bytes`,
                reason: 'envelope_metadata_too_large'
            };
        }
    }

    // Parse root fields if present
    let rootSport: string | undefined;
    if (body.sport !== undefined) {
        if (typeof body.sport !== 'string' || !body.sport.trim()) {
            return {
                ok: false,
                status: 400,
                error: 'Invalid sport parameter',
                reason: 'invalid_root_sport'
            };
        }
        rootSport = body.sport.trim();
        if (utf8ByteLength(rootSport) > MAX_SPORT_BYTE_LENGTH || !SAFE_TOKEN_REGEX.test(rootSport)) {
            return {
                ok: false,
                status: 400,
                error: 'Invalid sport parameter',
                reason: 'invalid_root_sport'
            };
        }
    }

    let rootDate: string | undefined;
    if (body.date !== undefined) {
        if (typeof body.date !== 'string' || !isValidCalendarDate(body.date.trim())) {
            return {
                ok: false,
                status: 400,
                error: 'Invalid date parameter (expected YYYY-MM-DD)',
                reason: 'invalid_root_date'
            };
        }
        rootDate = body.date.trim();
    }

    let rootEventIds: string[] | undefined;
    if (body.eventIds !== undefined) {
        const parsedEvents = validateIdArray(body.eventIds, 'eventIds', false);
        if (!parsedEvents.ok) {
            return {
                ok: false,
                status: 400,
                error: parsedEvents.message,
                reason: parsedEvents.reason
            };
        }
        if (parsedEvents.values.length === 0) {
            return {
                ok: false,
                status: 400,
                error: 'eventIds must not be empty when provided',
                reason: 'empty_eventIds'
            };
        }
        if (parsedEvents.values.length > MAX_UNIQUE_EVENTS) {
            return {
                ok: false,
                status: 400,
                error: `eventIds cannot exceed ${MAX_UNIQUE_EVENTS} unique events`,
                reason: 'event_ids_limit_exceeded'
            };
        }
        rootEventIds = parsedEvents.values;
    }

    let rootEntityIds: string[] | undefined;
    if (body.entityIds !== undefined) {
        const parsedEntities = validateIdArray(body.entityIds, 'entityIds', true);
        if (!parsedEntities.ok) {
            return {
                ok: false,
                status: 400,
                error: parsedEntities.message,
                reason: parsedEntities.reason
            };
        }
        if (parsedEntities.values.length > MAX_UNIQUE_ENTITIES) {
            return {
                ok: false,
                status: 400,
                error: `entityIds cannot exceed ${MAX_UNIQUE_ENTITIES} unique entities`,
                reason: 'entity_ids_limit_exceeded'
            };
        }
        rootEntityIds = parsedEntities.values;
    }

    // Validate root asOf if provided
    let rootAsOfIso: string | undefined;
    let rootAsOfMs: number | undefined;
    if (body.asOf !== undefined) {
        const parsedRootAsOf = parseAndValidateAsOf(body.asOf, requestReceivedAt);
        if (!parsedRootAsOf.ok) {
            return {
                ok: false,
                status: 400,
                error: parsedRootAsOf.message,
                reason: parsedRootAsOf.reason
            };
        }
        rootAsOfIso = parsedRootAsOf.asOf;
        rootAsOfMs = parsedRootAsOf.asOfMs;
    }

    let groups: RetrievalContextGroup[] = [];
    let requestId: string | undefined;
    let purpose: HistoryPurpose | undefined;
    let requiredContext: HistoryContextSectionKey[] = [];
    let optionalContext: HistoryOptionalContextKey[] = [];
    let asOfIso = rootAsOfIso ?? requestReceivedAtIso;
    let asOfMs = rootAsOfMs ?? requestReceivedAtMs;
    let envelopeSnapshotRefsRaw: unknown = undefined;

    if (hasExplicitRetrievalContext) {
        const rc = body.retrievalContext;
        if (!isPlainObject(rc)) {
            return {
                ok: false,
                status: 400,
                error: 'retrievalContext must be an object',
                reason: 'invalid_retrieval_context'
            };
        }
        for (const k of Object.keys(rc)) {
            if (!ALLOWED_ENVELOPE_KEYS.has(k)) {
                return {
                    ok: false,
                    status: 400,
                    error: `Unsupported or untrusted field in retrievalContext: ${k}`,
                    reason: 'unexpected_retrieval_context_field'
                };
            }
        }
        if (rc.version !== 1) {
            return {
                ok: false,
                status: 400,
                error: 'retrievalContext.version must be 1',
                reason: 'unsupported_retrieval_context_version'
            };
        }
        if (rc.requestId !== undefined) {
            if (
                typeof rc.requestId !== 'string' ||
                !REQUEST_ID_ASCII_REGEX.test(rc.requestId)
            ) {
                return {
                    ok: false,
                    status: 400,
                    error: `retrievalContext.requestId must be 1..${MAX_REQUEST_ID_LENGTH} printable ASCII characters`,
                    reason: 'invalid_request_id'
                };
            }
            requestId = rc.requestId;
        }
        if (rc.purpose !== undefined) {
            if (typeof rc.purpose !== 'string' || !PURPOSE_SET.has(rc.purpose)) {
                return {
                    ok: false,
                    status: 400,
                    error: 'retrievalContext.purpose must be parlay, bet-chat, or morning',
                    reason: 'invalid_purpose'
                };
            }
            purpose = rc.purpose as HistoryPurpose;
        }
        if (rc.asOf !== undefined) {
            const parsedEnvAsOf = parseAndValidateAsOf(rc.asOf, requestReceivedAt);
            if (!parsedEnvAsOf.ok) {
                return {
                    ok: false,
                    status: 400,
                    error: parsedEnvAsOf.message,
                    reason: parsedEnvAsOf.reason
                };
            }
            if (rootAsOfMs !== undefined && rootAsOfMs !== parsedEnvAsOf.asOfMs) {
                return {
                    ok: false,
                    status: 400,
                    error: 'Conflicting root asOf and retrievalContext.asOf',
                    reason: 'conflicting_as_of'
                };
            }
            asOfIso = parsedEnvAsOf.asOf;
            asOfMs = parsedEnvAsOf.asOfMs;
        }

        if (rc.requiredContext !== undefined) {
            if (!Array.isArray(rc.requiredContext)) {
                return {
                    ok: false,
                    status: 400,
                    error: 'retrievalContext.requiredContext must be an array',
                    reason: 'invalid_required_context'
                };
            }
            const reqSet = new Set<HistoryContextSectionKey>();
            for (const sec of rc.requiredContext) {
                if (typeof sec !== 'string' || !SECTION_SET.has(sec)) {
                    return {
                        ok: false,
                        status: 400,
                        error: `Invalid requiredContext section: ${String(sec)}`,
                        reason: 'invalid_required_context_section'
                    };
                }
                reqSet.add(sec as HistoryContextSectionKey);
            }
            requiredContext = Array.from(reqSet);
        }

        if (rc.optionalContext !== undefined) {
            if (!Array.isArray(rc.optionalContext)) {
                return {
                    ok: false,
                    status: 400,
                    error: 'retrievalContext.optionalContext must be an array',
                    reason: 'invalid_optional_context'
                };
            }
            const optSet = new Set<HistoryOptionalContextKey>();
            for (const sec of rc.optionalContext) {
                if (typeof sec !== 'string' || !OPTIONAL_SECTION_SET.has(sec)) {
                    return {
                        ok: false,
                        status: 400,
                        error: `Invalid optionalContext section: ${String(sec)}`,
                        reason: 'invalid_optional_context_section'
                    };
                }
                optSet.add(sec as HistoryOptionalContextKey);
            }
            optionalContext = Array.from(optSet);
        }

        if (
            !Array.isArray(rc.groups) ||
            rc.groups.length === 0 ||
            rc.groups.length > MAX_RETRIEVAL_GROUPS
        ) {
            return {
                ok: false,
                status: 400,
                error: `retrievalContext.groups must contain 1..${MAX_RETRIEVAL_GROUPS} groups`,
                reason: 'invalid_groups_count'
            };
        }

        for (const rawGroup of rc.groups) {
            if (!isPlainObject(rawGroup)) {
                return {
                    ok: false,
                    status: 400,
                    error: 'Each group in retrievalContext.groups must be an object',
                    reason: 'invalid_group_item'
                };
            }
            for (const k of Object.keys(rawGroup)) {
                if (!ALLOWED_GROUP_KEYS.has(k)) {
                    return {
                        ok: false,
                        status: 400,
                        error: `Unexpected field in retrievalContext group: ${k}`,
                        reason: 'unexpected_group_field'
                    };
                }
            }
            const gSport = typeof rawGroup.sport === 'string' ? rawGroup.sport.trim() : '';
            if (
                !gSport ||
                utf8ByteLength(gSport) > MAX_SPORT_BYTE_LENGTH ||
                !SAFE_TOKEN_REGEX.test(gSport)
            ) {
                return {
                    ok: false,
                    status: 400,
                    error: 'Each group must have a valid sport string',
                    reason: 'invalid_group_sport'
                };
            }
            const gDate = typeof rawGroup.date === 'string' ? rawGroup.date.trim() : '';
            if (!isValidCalendarDate(gDate)) {
                return {
                    ok: false,
                    status: 400,
                    error: 'Each group must have a valid date (YYYY-MM-DD)',
                    reason: 'invalid_group_date'
                };
            }
            const parsedGroupEvents = validateIdArray(rawGroup.eventIds, 'group.eventIds', false);
            if (!parsedGroupEvents.ok || parsedGroupEvents.values.length === 0) {
                return {
                    ok: false,
                    status: 400,
                    error: parsedGroupEvents.ok
                        ? 'Each group must specify at least one eventId'
                        : parsedGroupEvents.message,
                    reason: parsedGroupEvents.ok ? 'empty_group_eventIds' : parsedGroupEvents.reason
                };
            }
            let groupEntities: string[] | undefined;
            if (rawGroup.entityIds !== undefined) {
                const parsedGroupEntities = validateIdArray(
                    rawGroup.entityIds,
                    'group.entityIds',
                    true
                );
                if (!parsedGroupEntities.ok) {
                    return {
                        ok: false,
                        status: 400,
                        error: parsedGroupEntities.message,
                        reason: parsedGroupEntities.reason
                    };
                }
                if (parsedGroupEntities.values.length > 0) {
                    groupEntities = parsedGroupEntities.values;
                }
            }
            groups.push({
                sport: gSport,
                date: gDate,
                eventIds: parsedGroupEvents.values,
                ...(groupEntities ? { entityIds: groupEntities } : {})
            });
        }

        envelopeSnapshotRefsRaw = rc.snapshotRefs;
    } else if (rootEventIds && rootDate && rootSport) {
        groups = [
            {
                sport: rootSport,
                date: rootDate,
                eventIds: rootEventIds,
                ...(rootEntityIds && rootEntityIds.length > 0 ? { entityIds: rootEntityIds } : {})
            }
        ];
    }

    // Collect unique eventIds and entityIds across groups
    const uniqueEvents: string[] = [];
    const seenEvents = new Set<string>();
    const uniqueEntities: string[] = [];
    const seenEntities = new Set<string>();
    let anyGroupHasEntities = false;

    for (const g of groups) {
        for (const evId of g.eventIds) {
            if (!seenEvents.has(evId)) {
                seenEvents.add(evId);
                uniqueEvents.push(evId);
            }
        }
        if (g.entityIds && g.entityIds.length > 0) {
            anyGroupHasEntities = true;
            for (const ent of g.entityIds) {
                if (!seenEntities.has(ent)) {
                    seenEntities.add(ent);
                    uniqueEntities.push(ent);
                }
            }
        }
    }

    if (uniqueEvents.length > MAX_UNIQUE_EVENTS) {
        return {
            ok: false,
            status: 400,
            error: `Total unique eventIds across groups cannot exceed ${MAX_UNIQUE_EVENTS}`,
            reason: 'event_ids_limit_exceeded'
        };
    }

    // Conflict checks between root fields and retrievalContext.groups
    if (hasExplicitRetrievalContext) {
        if (rootSport !== undefined) {
            const sportMismatch = groups.some((g) => g.sport !== rootSport);
            if (sportMismatch) {
                return {
                    ok: false,
                    status: 400,
                    error: 'Root sport conflicts with retrievalContext.groups sport',
                    reason: 'conflicting_sport_scope'
                };
            }
        }
        if (rootDate !== undefined) {
            const dateMismatch = groups.some((g) => g.date !== rootDate);
            if (dateMismatch) {
                return {
                    ok: false,
                    status: 400,
                    error: 'Root date conflicts with retrievalContext.groups date',
                    reason: 'conflicting_date_scope'
                };
            }
        }
        if (rootEventIds !== undefined) {
            const sameEvents =
                rootEventIds.length === uniqueEvents.length &&
                rootEventIds.every((id, idx) => id === uniqueEvents[idx]);
            if (!sameEvents) {
                return {
                    ok: false,
                    status: 400,
                    error: 'Root eventIds conflicts with retrievalContext.groups eventIds',
                    reason: 'conflicting_event_ids_scope'
                };
            }
        }
        if (rootEntityIds !== undefined) {
            if (anyGroupHasEntities) {
                const rootSet = new Set(rootEntityIds);
                const sameEntities =
                    rootSet.size === seenEntities.size &&
                    uniqueEntities.every((ent) => rootSet.has(ent));
                if (!sameEntities) {
                    return {
                        ok: false,
                        status: 400,
                        error: 'Root entityIds conflicts with retrievalContext.groups entityIds',
                        reason: 'conflicting_entity_ids_scope'
                    };
                }
            } else {
                for (const ent of rootEntityIds) {
                    if (!seenEntities.has(ent)) {
                        seenEntities.add(ent);
                        uniqueEntities.push(ent);
                    }
                }
            }
        }
    } else {
        if (rootEventIds) {
            for (const evId of rootEventIds) {
                if (!seenEvents.has(evId)) {
                    seenEvents.add(evId);
                    uniqueEvents.push(evId);
                }
            }
        }
        if (rootEntityIds) {
            for (const ent of rootEntityIds) {
                if (!seenEntities.has(ent)) {
                    seenEntities.add(ent);
                    uniqueEntities.push(ent);
                }
            }
        }
    }

    if (uniqueEntities.length > MAX_UNIQUE_ENTITIES) {
        return {
            ok: false,
            status: 400,
            error: `Total unique entityIds cannot exceed ${MAX_UNIQUE_ENTITIES}`,
            reason: 'entity_ids_limit_exceeded'
        };
    }

    // Validate snapshotRefs (from root or retrievalContext)
    if (body.snapshotRefs !== undefined && envelopeSnapshotRefsRaw !== undefined) {
        if (JSON.stringify(body.snapshotRefs) !== JSON.stringify(envelopeSnapshotRefsRaw)) {
            return {
                ok: false,
                status: 400,
                error: 'Conflicting root snapshotRefs and retrievalContext.snapshotRefs',
                reason: 'conflicting_snapshot_refs'
            };
        }
    }
    const rawSnapshotRefs =
        body.snapshotRefs !== undefined ? body.snapshotRefs : envelopeSnapshotRefsRaw;
    const parsedRefs = validateSnapshotRefs(rawSnapshotRefs, groups);
    if (!parsedRefs.ok) {
        return {
            ok: false,
            status: 400,
            error: parsedRefs.message,
            reason: parsedRefs.reason
        };
    }

    // Derive top-level sport/date only when unambiguous (never collapse multi-group heterogeneous sport/date)
    const distinctSports = new Set(groups.map((g) => g.sport));
    const distinctDates = new Set(groups.map((g) => g.date));
    const derivedSport =
        rootSport ?? (distinctSports.size === 1 ? groups[0]?.sport : undefined);
    const derivedDate =
        rootDate ?? (distinctDates.size === 1 ? groups[0]?.date : undefined);

    const normalizedEnvelope: RetrievalContextEnvelope | undefined =
        groups.length > 0
            ? {
                  version: 1,
                  ...(requestId ? { requestId } : {}),
                  ...(purpose ? { purpose } : {}),
                  asOf: asOfIso,
                  groups,
                  ...(requiredContext.length > 0 ? { requiredContext } : {}),
                  ...(optionalContext.length > 0 ? { optionalContext } : {})
              }
            : undefined;

    const usesContextStore =
        hasExplicitRetrievalContext ||
        purpose === 'parlay' ||
        purpose === 'bet-chat' ||
        requiredContext.length > 0 ||
        parsedRefs.refs.length > 0;

    const scope: TrustedRetrievalScope = {
        callerAppId: trustedCallerAppId,
        asOf: asOfIso,
        asOfMs,
        requestReceivedAt: requestReceivedAtIso,
        requestReceivedAtMs,
        ...(requestId ? { requestId } : {}),
        ...(purpose ? { purpose } : {}),
        groups,
        eventIds: uniqueEvents,
        entityIds: uniqueEntities,
        ...(derivedSport ? { sport: derivedSport } : {}),
        ...(derivedDate ? { date: derivedDate } : {}),
        requiredContext,
        optionalContext,
        snapshotRefs: parsedRefs.refs,
        hasExplicitRetrievalContext,
        usesContextStore
    };

    return {
        ok: true,
        scope,
        ...(normalizedEnvelope ? { retrievalContext: normalizedEnvelope } : {}),
        ...(parsedRefs.refs.length > 0 ? { snapshotRefs: parsedRefs.refs } : {})
    };
}
