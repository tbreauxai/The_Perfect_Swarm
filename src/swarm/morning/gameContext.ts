import type {
    HistoryContextSectionKey,
    RetrievalContextGroup,
    SnapshotRef,
    TrustedRetrievalScope
} from '../engine/historyScope.ts';
import {
    HISTORY_CONTEXT_SECTIONS,
    isValidCalendarDate,
    utf8ByteLength
} from '../engine/historyScope.ts';

export interface SupabaseReadOnlyConfig {
    supabaseUrl: string;
    supabasePublishableKey: string;
}

export type UnavailableContextReason =
    | 'no_snapshot'
    | 'not_yet_observed'
    | 'no_snapshot_before_cutoff'
    | 'invalid_source_time'
    | 'integrity_mismatch'
    | 'sections_incomplete';

export type SectionSourceStatusValue =
    | 'ok'
    | 'ready'
    | 'empty'
    | 'empty_valid'
    | 'missing'
    | 'stale'
    | 'error'
    | 'not_applicable';

export interface SectionSourceStatusEntry {
    status: SectionSourceStatusValue;
    observed_at: string | null;
    source_ref: string | null;
}

export type SectionSourceStatusMap = Record<HistoryContextSectionKey, SectionSourceStatusEntry>;

export interface GameSectionData {
    event_id: string;
    sport: string;
    league?: string;
    season?: string;
    game_date: string;
    scheduled_start: string;
    status_at_capture?: 'scheduled' | 'in_progress' | 'postponed' | 'cancelled';
    home_team_id: string;
    home_team: string;
    away_team_id: string;
    away_team: string;
    neutral_site: boolean;
}

export interface VenueSectionData {
    venue_id: string | null;
    name: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
    surface: string | null;
    indoor: boolean | null;
    timezone: string | null;
    altitude_m: number | null;
}

export interface FormItemData {
    team_id: string;
    event_id: string;
    completed_at: string;
    opponent_id: string;
    is_home: boolean;
    points_for: number;
    points_against: number;
    margin: number;
    result: 'W' | 'L' | 'T';
    rest_days: number | null;
}

export interface H2HItemData {
    event_id: string;
    completed_at: string;
    home_team_id: string;
    away_team_id: string;
    home_score: number;
    away_score: number;
    winner_team_id: string | null;
    margin_home: number;
    total_points: number;
}

export interface InjuryItemData {
    team_id: string;
    player_id: string;
    player_name: string;
    position: string | null;
    status: 'out' | 'doubtful' | 'questionable' | 'probable' | 'active';
    reason: string | null;
    reported_at: string | null;
}

export interface WeatherSectionData {
    condition: string | null;
    temp_c: number | null;
    wind_kph: number | null;
    wind_dir: string | null;
    precip_prob: number | null;
    humidity_pct: number | null;
    dome_closed: boolean | null;
}

export interface OddsItemData {
    book: string;
    captured_at: string;
    is_opening: boolean;
    spread_home: number | null;
    spread_away: number | null;
    spread_price_home: number | null;
    spread_price_away: number | null;
    total: number | null;
    over_price: number | null;
    under_price: number | null;
    ml_home: number | null;
    ml_away: number | null;
    draw_price: number | null;
}

export interface GameContextSections {
    game: GameSectionData;
    venue: VenueSectionData | null;
    form: FormItemData[];
    h2h: H2HItemData[];
    injuries: InjuryItemData[];
    weather: WeatherSectionData | null;
    odds: OddsItemData[];
}

export interface ValidatedEventContextRow {
    event_id: string;
    game_date: string;
    sport: string;
    status: 'ready' | 'partial' | 'unavailable';
    unavailable_reason: UnavailableContextReason | null;
    snapshot_id: string | null;
    content_hash: string | null;
    version: string | null;
    schema_ver: 1;
    created_at: string | null;
    observed_at: string | null;
    decision_as_of: string | null;
    sections: GameContextSections | null;
    source_status: SectionSourceStatusMap | null;
    integrity_source: 'db_rpc_verified' | 'none';
    freshness_violations: HistoryContextSectionKey[];
    available_sections: HistoryContextSectionKey[];
    snapshot_ref_matched?: boolean;
}

export type GameContextStoreReadResult =
    | {
          status: 'ok';
          asOf: string;
          results: ValidatedEventContextRow[];
          byEventId: Map<string, ValidatedEventContextRow>;
          allReadyForSlim: boolean;
          missingRequiredSectionsByEvent: Record<string, HistoryContextSectionKey[]>;
          formattedBlock: string;
      }
    | {
          status: 'store_not_ready';
          reason: string;
          detail: string;
      }
    | {
          status: 'invalid_scope';
          httpStatus: 400;
          error: string;
          detail: string;
      }
    | {
          status: 'outage';
          httpStatus: 503;
          error: 'history_context_read_failed';
          detail: string;
      };

export const MAX_SNAPSHOT_ROW_BYTES = 65536;
export const MAX_SOURCE_STATUS_BYTES = 8192;
export const MAX_SECTION_STRING_BYTES = 256;
export const MAX_SOURCE_REF_BYTES = 512;
export const MAX_PROMPT_HISTORY_BYTES = 6000;
export const MAX_PROMPT_CHARS_PER_EVENT = 1200;

export const FRESHNESS_WINDOW_MS: Readonly<Record<'form' | 'h2h' | 'injuries' | 'weather' | 'odds', number>> = {
    form: 24 * 60 * 60 * 1000,
    h2h: 24 * 60 * 60 * 1000,
    injuries: 6 * 60 * 60 * 1000,
    weather: 3 * 60 * 60 * 1000,
    odds: 15 * 60 * 1000
};

const UNAVAILABLE_REASONS = new Set<string>([
    'no_snapshot',
    'not_yet_observed',
    'no_snapshot_before_cutoff',
    'invalid_source_time',
    'integrity_mismatch',
    'sections_incomplete'
]);

const SOURCE_STATUS_VALUES = new Set<string>([
    'ok',
    'ready',
    'empty',
    'empty_valid',
    'missing',
    'stale',
    'error',
    'not_applicable'
]);

const GAME_CAPTURE_STATUSES = new Set<string>([
    'scheduled',
    'in_progress',
    'postponed',
    'cancelled'
]);

const INJURY_STATUSES = new Set<string>([
    'out',
    'doubtful',
    'questionable',
    'probable',
    'active'
]);

const FORM_RESULTS = new Set<string>(['W', 'L', 'T']);
const SHA256_LOWER_HEX_REGEX = /^[0-9a-f]{64}$/;
const DECIMAL_BIGINT_REGEX = /^\d+$/;
const RFC3339_REGEX =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Resolves the read-only publishable Supabase configuration.
 * Never falls back to SUPABASE_SERVICE_ROLE_KEY or accepts client-supplied keys.
 */
export function getSupabaseReadOnlyConfig(
    env: Record<string, string | undefined> = process.env
): SupabaseReadOnlyConfig | null {
    const supabaseUrl = env.SUPABASE_URL?.trim();
    const publishableKey = (
        env.SUPABASE_PUBLISHABLE_KEY ||
        env.SUPABASE_ANON_KEY ||
        env.SUPABASE_READ_ONLY_KEY ||
        env.PUBLIC_SUPABASE_ANON_KEY ||
        ''
    ).trim();
    const serviceRoleKey = (
        env.SUPABASE_SERVICE_ROLE_KEY ||
        env.SUPABASE_SERVICE_KEY ||
        ''
    ).trim();

    if (!supabaseUrl || !supabaseUrl.startsWith('http') || !publishableKey) {
        return null;
    }
    // Reject if the configured publishable key is actually the service-role write key
    if (
        (serviceRoleKey && publishableKey === serviceRoleKey) ||
        publishableKey.includes('service_role')
    ) {
        return null;
    }
    return {
        supabaseUrl,
        supabasePublishableKey: publishableKey
    };
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
    return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function parseTimestampMs(raw: unknown): number | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!RFC3339_REGEX.test(trimmed)) return null;
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? ms : null;
}

function isBoundedString(val: unknown, maxBytes: number = MAX_SECTION_STRING_BYTES): val is string {
    if (typeof val !== 'string') return false;
    if (utf8ByteLength(val) > maxBytes) return false;
    // Disallow control characters
    for (let i = 0; i < val.length; i++) {
        const code = val.charCodeAt(i);
        if (code < 0x20 || code === 0x7f) return false;
    }
    return true;
}

function isNullableBoundedString(
    val: unknown,
    maxBytes: number = MAX_SECTION_STRING_BYTES
): val is string | null {
    if (val === null) return true;
    return isBoundedString(val, maxBytes);
}

function isFiniteNumber(val: unknown): val is number {
    return typeof val === 'number' && Number.isFinite(val);
}

function isNullableFiniteNumber(val: unknown): val is number | null {
    return val === null || isFiniteNumber(val);
}

function isNullableBoolean(val: unknown): val is boolean | null {
    return val === null || typeof val === 'boolean';
}

function sanitizePromptValue(val: string): string {
    return val.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function validateGameSection(
    raw: unknown,
    expectedEventId: string,
    expectedSport: string,
    expectedDate: string
): GameSectionData | null {
    if (!isPlainObject(raw)) return null;
    const scheduledStart = raw.scheduled_start ?? raw.commence_time;
    if (
        !isBoundedString(raw.event_id) ||
        raw.event_id !== expectedEventId ||
        !isBoundedString(raw.sport) ||
        raw.sport !== expectedSport ||
        (raw.league !== undefined && !isBoundedString(raw.league)) ||
        (raw.season !== undefined && !isBoundedString(raw.season)) ||
        !isBoundedString(raw.game_date) ||
        raw.game_date !== expectedDate ||
        !isValidCalendarDate(raw.game_date) ||
        parseTimestampMs(scheduledStart) === null ||
        (raw.status_at_capture !== undefined &&
            (typeof raw.status_at_capture !== 'string' ||
                !GAME_CAPTURE_STATUSES.has(raw.status_at_capture))) ||
        !isBoundedString(raw.home_team_id) ||
        !isBoundedString(raw.home_team) ||
        !isBoundedString(raw.away_team_id) ||
        !isBoundedString(raw.away_team) ||
        (typeof raw.neutral_site !== 'boolean' && raw.neutral_site !== null && raw.neutral_site !== undefined)
    ) {
        return null;
    }
    return {
        event_id: raw.event_id,
        sport: raw.sport,
        ...(typeof raw.league === 'string' ? { league: raw.league } : {}),
        ...(typeof raw.season === 'string' ? { season: raw.season } : {}),
        game_date: raw.game_date,
        scheduled_start: scheduledStart as string,
        ...(raw.status_at_capture !== undefined
            ? { status_at_capture: raw.status_at_capture as GameSectionData['status_at_capture'] }
            : {}),
        home_team_id: raw.home_team_id,
        home_team: raw.home_team,
        away_team_id: raw.away_team_id,
        away_team: raw.away_team,
        neutral_site: raw.neutral_site === true
    };
}

function validateVenueSection(raw: unknown): { ok: true; data: VenueSectionData | null } | { ok: false } {
    if (raw === null) return { ok: true, data: null };
    if (!isPlainObject(raw)) return { ok: false };
    const region = raw.region !== undefined ? raw.region : (raw.state !== undefined ? raw.state : null);
    if (
        !isNullableBoundedString(raw.venue_id) ||
        !isNullableBoundedString(raw.name) ||
        !isNullableBoundedString(raw.city) ||
        !isNullableBoundedString(region) ||
        !isNullableBoundedString(raw.country) ||
        (raw.surface !== undefined && !isNullableBoundedString(raw.surface)) ||
        !isNullableBoolean(raw.indoor) ||
        (raw.timezone !== undefined && !isNullableBoundedString(raw.timezone)) ||
        (raw.altitude_m !== undefined && !isNullableFiniteNumber(raw.altitude_m))
    ) {
        return { ok: false };
    }
    return {
        ok: true,
        data: {
            venue_id: (raw.venue_id as string) ?? null,
            name: (raw.name as string) ?? null,
            city: (raw.city as string) ?? null,
            region: (region as string) ?? null,
            country: (raw.country as string) ?? null,
            surface: (raw.surface as string) ?? null,
            indoor: typeof raw.indoor === 'boolean' ? raw.indoor : null,
            timezone: (raw.timezone as string) ?? null,
            altitude_m: typeof raw.altitude_m === 'number' ? raw.altitude_m : null
        }
    };
}

function validateFormSection(
    raw: unknown,
    targetEventId: string,
    asOfMs: number
):
    | { ok: true; data: FormItemData[]; reason?: UnavailableContextReason }
    | { ok: false; reason: UnavailableContextReason } {
    if (!Array.isArray(raw) || raw.length > 10) {
        return { ok: false, reason: 'sections_incomplete' };
    }
    const items: FormItemData[] = [];
    for (const item of raw) {
        if (!isPlainObject(item)) return { ok: false, reason: 'sections_incomplete' };
        if (
            !isBoundedString(item.team_id) ||
            !isBoundedString(item.event_id) ||
            !isBoundedString(item.opponent_id) ||
            typeof item.is_home !== 'boolean' ||
            !isFiniteNumber(item.points_for) ||
            !isFiniteNumber(item.points_against) ||
            !isFiniteNumber(item.margin) ||
            typeof item.result !== 'string' ||
            !FORM_RESULTS.has(item.result) ||
            !isNullableFiniteNumber(item.rest_days)
        ) {
            return { ok: false, reason: 'sections_incomplete' };
        }
        // Prevent target-game outcome leak or post-cutoff game leak
        if (item.event_id === targetEventId) {
            return { ok: false, reason: 'invalid_source_time' };
        }
        const completedMs = parseTimestampMs(item.completed_at);
        if (completedMs === null || completedMs > asOfMs) {
            return { ok: false, reason: 'invalid_source_time' };
        }
        items.push({
            team_id: item.team_id,
            event_id: item.event_id,
            completed_at: item.completed_at as string,
            opponent_id: item.opponent_id,
            is_home: item.is_home,
            points_for: item.points_for,
            points_against: item.points_against,
            margin: item.margin,
            result: item.result as FormItemData['result'],
            rest_days: item.rest_days
        });
    }
    return { ok: true, data: items };
}

function validateH2HSection(
    raw: unknown,
    targetEventId: string,
    asOfMs: number
):
    | { ok: true; data: H2HItemData[]; reason?: UnavailableContextReason }
    | { ok: false; reason: UnavailableContextReason } {
    if (!Array.isArray(raw) || raw.length > 5) {
        return { ok: false, reason: 'sections_incomplete' };
    }
    const items: H2HItemData[] = [];
    for (const item of raw) {
        if (!isPlainObject(item)) return { ok: false, reason: 'sections_incomplete' };
        if (
            !isBoundedString(item.event_id) ||
            !isBoundedString(item.home_team_id) ||
            !isBoundedString(item.away_team_id) ||
            !isFiniteNumber(item.home_score) ||
            !isFiniteNumber(item.away_score) ||
            !isNullableBoundedString(item.winner_team_id) ||
            !isFiniteNumber(item.margin_home) ||
            !isFiniteNumber(item.total_points)
        ) {
            return { ok: false, reason: 'sections_incomplete' };
        }
        if (item.event_id === targetEventId) {
            return { ok: false, reason: 'invalid_source_time' };
        }
        const completedMs = parseTimestampMs(item.completed_at);
        if (completedMs === null || completedMs > asOfMs) {
            return { ok: false, reason: 'invalid_source_time' };
        }
        items.push({
            event_id: item.event_id,
            completed_at: item.completed_at as string,
            home_team_id: item.home_team_id,
            away_team_id: item.away_team_id,
            home_score: item.home_score,
            away_score: item.away_score,
            winner_team_id: item.winner_team_id,
            margin_home: item.margin_home,
            total_points: item.total_points
        });
    }
    return { ok: true, data: items };
}

function validateInjuriesSection(
    raw: unknown,
    asOfMs: number
):
    | { ok: true; data: InjuryItemData[]; reason?: UnavailableContextReason }
    | { ok: false; reason: UnavailableContextReason } {
    if (!Array.isArray(raw) || raw.length > 30) {
        return { ok: false, reason: 'sections_incomplete' };
    }
    const items: InjuryItemData[] = [];
    for (const item of raw) {
        if (!isPlainObject(item)) return { ok: false, reason: 'sections_incomplete' };
        if (
            !isBoundedString(item.team_id) ||
            !isBoundedString(item.player_id) ||
            !isBoundedString(item.player_name) ||
            !isNullableBoundedString(item.position) ||
            typeof item.status !== 'string' ||
            !INJURY_STATUSES.has(item.status) ||
            !isNullableBoundedString(item.reason)
        ) {
            return { ok: false, reason: 'sections_incomplete' };
        }
        let reportedAt: string | null = null;
        if (item.reported_at !== null && item.reported_at !== undefined) {
            const repMs = parseTimestampMs(item.reported_at);
            if (repMs === null || repMs > asOfMs) {
                return { ok: false, reason: 'invalid_source_time' };
            }
            reportedAt = item.reported_at as string;
        }
        items.push({
            team_id: item.team_id,
            player_id: item.player_id,
            player_name: item.player_name,
            position: item.position,
            status: item.status as InjuryItemData['status'],
            reason: item.reason,
            reported_at: reportedAt
        });
    }
    return { ok: true, data: items };
}

function validateWeatherSection(
    raw: unknown
): { ok: true; data: WeatherSectionData | null } | { ok: false } {
    if (raw === null) return { ok: true, data: null };
    if (!isPlainObject(raw)) return { ok: false };
    const cond = raw.condition !== undefined ? raw.condition : (raw.summary !== undefined ? raw.summary : null);
    const tempC = raw.temp_c !== undefined ? raw.temp_c : (raw.temperature_c !== undefined ? raw.temperature_c : null);
    const windKph = raw.wind_kph !== undefined ? raw.wind_kph : (typeof raw.wind_mps === 'number' ? Math.round(raw.wind_mps * 3.6 * 10) / 10 : null);
    const precipProb = raw.precip_prob !== undefined ? raw.precip_prob : (raw.precip_probability !== undefined ? raw.precip_probability : null);
    if (
        !isNullableBoundedString(cond) ||
        !isNullableFiniteNumber(tempC) ||
        !isNullableFiniteNumber(windKph) ||
        (raw.wind_dir !== undefined && !isNullableBoundedString(raw.wind_dir)) ||
        !isNullableFiniteNumber(precipProb) ||
        (raw.humidity_pct !== undefined && !isNullableFiniteNumber(raw.humidity_pct)) ||
        (raw.dome_closed !== undefined && !isNullableBoolean(raw.dome_closed))
    ) {
        return { ok: false };
    }
    return {
        ok: true,
        data: {
            condition: (cond as string) ?? null,
            temp_c: typeof tempC === 'number' ? tempC : null,
            wind_kph: typeof windKph === 'number' ? windKph : null,
            wind_dir: (raw.wind_dir as string) ?? null,
            precip_prob: typeof precipProb === 'number' ? precipProb : null,
            humidity_pct: typeof raw.humidity_pct === 'number' ? raw.humidity_pct : null,
            dome_closed: typeof raw.dome_closed === 'boolean' ? raw.dome_closed : null
        }
    };
}

function validateOddsSection(
    raw: unknown,
    asOfMs: number
):
    | { ok: true; data: OddsItemData[]; latestCapturedMs: number | null; reason?: UnavailableContextReason }
    | { ok: false; reason: UnavailableContextReason } {
    if (!Array.isArray(raw) || raw.length > 12) {
        return { ok: false, reason: 'sections_incomplete' };
    }
    const items: OddsItemData[] = [];
    let latestCapturedMs: number | null = null;
    for (const item of raw) {
        if (!isPlainObject(item)) return { ok: false, reason: 'sections_incomplete' };
        if (
            !isBoundedString(item.book) ||
            typeof item.is_opening !== 'boolean' ||
            !isNullableFiniteNumber(item.spread_home) ||
            !isNullableFiniteNumber(item.spread_away) ||
            !isNullableFiniteNumber(item.spread_price_home) ||
            !isNullableFiniteNumber(item.spread_price_away) ||
            !isNullableFiniteNumber(item.total) ||
            !isNullableFiniteNumber(item.over_price) ||
            !isNullableFiniteNumber(item.under_price) ||
            !isNullableFiniteNumber(item.ml_home) ||
            !isNullableFiniteNumber(item.ml_away) ||
            !isNullableFiniteNumber(item.draw_price)
        ) {
            return { ok: false, reason: 'sections_incomplete' };
        }
        const capMs = parseTimestampMs(item.captured_at);
        if (capMs === null || capMs > asOfMs) {
            return { ok: false, reason: 'invalid_source_time' };
        }
        if (latestCapturedMs === null || capMs > latestCapturedMs) {
            latestCapturedMs = capMs;
        }
        items.push({
            book: item.book,
            captured_at: item.captured_at as string,
            is_opening: item.is_opening,
            spread_home: item.spread_home,
            spread_away: item.spread_away,
            spread_price_home: item.spread_price_home,
            spread_price_away: item.spread_price_away,
            total: item.total,
            over_price: item.over_price,
            under_price: item.under_price,
            ml_home: item.ml_home,
            ml_away: item.ml_away,
            draw_price: item.draw_price
        });
    }
    return { ok: true, data: items, latestCapturedMs };
}

function validateSourceStatusMap(
    raw: unknown,
    asOfMs: number
):
    | { ok: true; map: SectionSourceStatusMap; reason?: UnavailableContextReason }
    | { ok: false; reason: UnavailableContextReason } {
    if (!isPlainObject(raw)) return { ok: false, reason: 'sections_incomplete' };
    const serialized = JSON.stringify(raw);
    if (utf8ByteLength(serialized) > MAX_SOURCE_STATUS_BYTES) {
        return { ok: false, reason: 'sections_incomplete' };
    }
    const result: Partial<SectionSourceStatusMap> = {};
    for (const key of HISTORY_CONTEXT_SECTIONS) {
        const entry = raw[key];
        if (!isPlainObject(entry)) {
            return { ok: false, reason: 'sections_incomplete' };
        }
        if (typeof entry.status !== 'string' || !SOURCE_STATUS_VALUES.has(entry.status)) {
            return { ok: false, reason: 'sections_incomplete' };
        }
        let observedAt: string | null = null;
        if (entry.observed_at !== null && entry.observed_at !== undefined) {
            const obsMs = parseTimestampMs(entry.observed_at);
            if (obsMs === null || obsMs > asOfMs) {
                return { ok: false, reason: 'invalid_source_time' };
            }
            observedAt = entry.observed_at as string;
        }
        let sourceRef: string | null = null;
        if (entry.source_ref !== null && entry.source_ref !== undefined) {
            if (!isBoundedString(entry.source_ref, MAX_SOURCE_REF_BYTES)) {
                return { ok: false, reason: 'sections_incomplete' };
            }
            sourceRef = entry.source_ref;
        }
        result[key] = {
            status: entry.status as SectionSourceStatusValue,
            observed_at: observedAt,
            source_ref: sourceRef
        };
    }
    return { ok: true, map: result as SectionSourceStatusMap };
}

export function adaptContextEnvelope(rawRow: unknown): Record<string, unknown> | null {
    if (!isPlainObject(rawRow)) {
        console.warn('[HistoryContextStore] Invalid raw row: expected object');
        return null;
    }

    if (!isPlainObject(rawRow.sections)) {
        console.warn('[HistoryContextStore] Malformed row: missing sections object');
        return null;
    }

    const adaptedSections: Record<string, unknown> = {};
    const existingSourceStatus: Record<string, unknown> = isPlainObject(rawRow.source_status)
        ? { ...rawRow.source_status }
        : {};

    const rawSections = rawRow.sections as Record<string, unknown>;

    // Locate game item first so dependent sections can reference home/away team
    let gameItem: Record<string, unknown> | null = null;
    if (isPlainObject(rawSections.game)) {
        if (Array.isArray(rawSections.game.items) && rawSections.game.items.length > 0 && isPlainObject(rawSections.game.items[0])) {
            gameItem = rawSections.game.items[0] as Record<string, unknown>;
        } else if (!('items' in rawSections.game) && !('status' in rawSections.game)) {
            gameItem = rawSections.game as Record<string, unknown>;
        }
    }

    for (const key of HISTORY_CONTEXT_SECTIONS) {
        const rawSec = rawSections[key];
        if (rawSec === undefined || rawSec === null) {
            adaptedSections[key] = (key === 'game' || key === 'venue' || key === 'weather') ? null : [];
            if (!existingSourceStatus[key]) {
                existingSourceStatus[key] = { status: 'missing', observed_at: null, source_ref: null };
            }
            continue;
        }

        // If not in envelope shape (legacy format), pass through
        if (!isPlainObject(rawSec) || (!('status' in rawSec) && !('items' in rawSec))) {
            adaptedSections[key] = rawSec;
            continue;
        }

        const secStatus = typeof rawSec.status === 'string' ? rawSec.status : 'empty';
        if (rawSec.items !== undefined && !Array.isArray(rawSec.items)) {
            console.warn(`[HistoryContextStore] Malformed section envelope for ${key}: items is not an array`);
            return null;
        }
        const items = Array.isArray(rawSec.items) ? rawSec.items : [];

        if (!existingSourceStatus[key]) {
            existingSourceStatus[key] = {
                status: secStatus === 'ready' ? 'ok' : secStatus,
                observed_at: typeof rawSec.observed_at === 'string' ? rawSec.observed_at : null,
                source_ref: typeof rawSec.source === 'string' ? rawSec.source : (typeof rawSec.source_ref === 'string' ? rawSec.source_ref : null)
            };
        }

        if (secStatus === 'empty' || items.length === 0) {
            adaptedSections[key] = (key === 'game' || key === 'venue' || key === 'weather') ? null : [];
            continue;
        }

        if (key === 'game') {
            const item = items[0];
            if (!isPlainObject(item)) {
                console.warn('[HistoryContextStore] Malformed game section item: not an object');
                return null;
            }
            adaptedSections.game = item;
        } else if (key === 'venue') {
            const item = items[0];
            adaptedSections.venue = isPlainObject(item) ? item : null;
        } else if (key === 'weather') {
            const item = items[0];
            adaptedSections.weather = isPlainObject(item) ? item : null;
        } else if (key === 'form') {
            const formItems: Array<Record<string, unknown>> = [];
            for (const item of items) {
                if (!isPlainObject(item)) continue;
                if (typeof item.team_id === 'string') {
                    formItems.push(item);
                } else if (gameItem && (typeof item.home_score === 'number' || typeof item.away_score === 'number')) {
                    const hScore = typeof item.home_score === 'number' ? item.home_score : 0;
                    const aScore = typeof item.away_score === 'number' ? item.away_score : 0;
                    const homeId = item.home_team_id;
                    const awayId = item.away_team_id;
                    const compAt = item.completed_at || (typeof item.game_date === 'string' ? `${item.game_date}T23:59:59.000Z` : null);

                    if (homeId === gameItem.home_team_id || homeId === gameItem.away_team_id) {
                        const margin = hScore - aScore;
                        formItems.push({
                            team_id: homeId,
                            event_id: item.event_id,
                            completed_at: compAt,
                            opponent_id: awayId,
                            is_home: true,
                            points_for: hScore,
                            points_against: aScore,
                            margin,
                            result: margin > 0 ? 'W' : margin < 0 ? 'L' : 'D',
                            rest_days: typeof item.rest_days === 'number' ? item.rest_days : null
                        });
                    }
                    if (awayId === gameItem.home_team_id || awayId === gameItem.away_team_id) {
                        const margin = aScore - hScore;
                        formItems.push({
                            team_id: awayId,
                            event_id: item.event_id,
                            completed_at: compAt,
                            opponent_id: homeId,
                            is_home: false,
                            points_for: aScore,
                            points_against: hScore,
                            margin,
                            result: margin > 0 ? 'W' : margin < 0 ? 'L' : 'D',
                            rest_days: typeof item.rest_days === 'number' ? item.rest_days : null
                        });
                    }
                } else {
                    formItems.push(item);
                }
            }
            adaptedSections.form = formItems;
        } else if (key === 'h2h') {
            const h2hItems: Array<Record<string, unknown>> = [];
            for (const item of items) {
                if (!isPlainObject(item)) continue;
                if (typeof item.margin_home === 'number' && typeof item.total_points === 'number') {
                    h2hItems.push(item);
                } else if (typeof item.home_score === 'number' && typeof item.away_score === 'number') {
                    const hScore = item.home_score;
                    const aScore = item.away_score;
                    const compAt = item.completed_at || (typeof item.game_date === 'string' ? `${item.game_date}T23:59:59.000Z` : null);
                    h2hItems.push({
                        event_id: item.event_id,
                        completed_at: compAt,
                        home_team_id: item.home_team_id,
                        away_team_id: item.away_team_id,
                        home_score: hScore,
                        away_score: aScore,
                        winner_team_id: item.winner_team_id ?? (hScore > aScore ? item.home_team_id : aScore > hScore ? item.away_team_id : null),
                        margin_home: hScore - aScore,
                        total_points: hScore + aScore
                    });
                } else {
                    h2hItems.push(item);
                }
            }
            adaptedSections.h2h = h2hItems;
        } else if (key === 'injuries') {
            const injuryItems: Array<Record<string, unknown>> = [];
            for (const item of items) {
                if (!isPlainObject(item)) continue;
                injuryItems.push({
                    team_id: item.team_id,
                    player_id: typeof item.player_id === 'string' && item.player_id ? item.player_id : (typeof item.player_name === 'string' ? item.player_name : 'unknown'),
                    player_name: item.player_name,
                    position: item.position ?? null,
                    status: item.status,
                    reason: item.reason ?? item.detail ?? null,
                    reported_at: item.reported_at ?? null
                });
            }
            adaptedSections.injuries = injuryItems;
        } else if (key === 'odds') {
            const hasSpreadOrMl = items.some((it) => isPlainObject(it) && (it.spread_home !== undefined || it.ml_home !== undefined));
            if (hasSpreadOrMl) {
                adaptedSections.odds = items;
            } else {
                const byBook = new Map<string, Record<string, unknown>>();
                for (const item of items) {
                    if (!isPlainObject(item)) continue;
                    const book = typeof item.book === 'string' ? item.book : 'unknown';
                    let entry = byBook.get(book);
                    if (!entry) {
                        entry = {
                            book,
                            captured_at: item.snapshot_at || item.captured_at || new Date().toISOString(),
                            is_opening: false,
                            spread_home: null,
                            spread_away: null,
                            spread_price_home: null,
                            spread_price_away: null,
                            total: null,
                            over_price: null,
                            under_price: null,
                            ml_home: null,
                            ml_away: null,
                            draw_price: null
                        };
                        byBook.set(book, entry);
                    }
                    const mkt = item.market;
                    const sel = item.selection;
                    const price = typeof item.american_price === 'number' ? item.american_price : null;
                    const line = typeof item.line === 'number' ? item.line : null;
                    if (mkt === 'h2h') {
                        if (sel === gameItem?.home_team || sel === gameItem?.home_team_id) {
                            entry.ml_home = price;
                        } else if (sel === gameItem?.away_team || sel === gameItem?.away_team_id) {
                            entry.ml_away = price;
                        }
                    } else if (mkt === 'spreads') {
                        if (sel === gameItem?.home_team || sel === gameItem?.home_team_id) {
                            entry.spread_home = line;
                            entry.spread_price_home = price;
                        } else if (sel === gameItem?.away_team || sel === gameItem?.away_team_id) {
                            entry.spread_away = line;
                            entry.spread_price_away = price;
                        }
                    } else if (mkt === 'totals') {
                        entry.total = line;
                        if (typeof sel === 'string' && sel.toLowerCase().includes('over')) {
                            entry.over_price = price;
                        } else if (typeof sel === 'string' && sel.toLowerCase().includes('under')) {
                            entry.under_price = price;
                        }
                    }
                }
                adaptedSections.odds = Array.from(byBook.values());
            }
        }
    }

    return {
        ...rawRow,
        sections: adaptedSections,
        source_status: existingSourceStatus
    };
}

export function validateRpcResultRow(
    rawRow: unknown,
    expected: { sport: string; game_date: string; event_id: string },
    asOfMs: number,
    snapshotRefMap: ReadonlyMap<string, SnapshotRef>
): ValidatedEventContextRow {
    const baseUnavailable = (reason: UnavailableContextReason): ValidatedEventContextRow => ({
        event_id: expected.event_id,
        game_date: expected.game_date,
        sport: expected.sport,
        status: 'unavailable',
        unavailable_reason: reason,
        snapshot_id: null,
        content_hash: null,
        version: null,
        schema_ver: 1,
        created_at: null,
        observed_at: null,
        decision_as_of: null,
        sections: null,
        source_status: null,
        integrity_source: 'none',
        freshness_violations: [],
        available_sections: []
    });

    if (!isPlainObject(rawRow)) {
        return baseUnavailable('sections_incomplete');
    }

    const rowBytes = utf8ByteLength(JSON.stringify(rawRow));
    if (rowBytes > MAX_SNAPSHOT_ROW_BYTES) {
        return baseUnavailable('sections_incomplete');
    }

    if (
        rawRow.event_id !== expected.event_id ||
        rawRow.game_date !== expected.game_date ||
        rawRow.sport !== expected.sport ||
        rawRow.schema_ver !== 1
    ) {
        return baseUnavailable('integrity_mismatch');
    }

    const rawStatus = rawRow.status;
    if (rawStatus === 'unavailable' || rawStatus === 'empty') {
        const reason =
            typeof rawRow.unavailable_reason === 'string' &&
            UNAVAILABLE_REASONS.has(rawRow.unavailable_reason)
                ? (rawRow.unavailable_reason as UnavailableContextReason)
                : 'no_snapshot';
        return baseUnavailable(reason);
    }

    if (rawStatus !== 'ready' && rawStatus !== 'partial') {
        return baseUnavailable('sections_incomplete');
    }

    const snapshotId = typeof rawRow.snapshot_id === 'string' ? rawRow.snapshot_id.trim() : '';
    const contentHash = typeof rawRow.content_hash === 'string' ? rawRow.content_hash.trim() : '';
    const version = typeof rawRow.version === 'string' ? rawRow.version.trim() : '';

    if (
        !snapshotId ||
        !SHA256_LOWER_HEX_REGEX.test(contentHash) ||
        !DECIMAL_BIGINT_REGEX.test(version)
    ) {
        return baseUnavailable('integrity_mismatch');
    }

    const createdMs = parseTimestampMs(rawRow.created_at);
    const observedMs = parseTimestampMs(rawRow.observed_at);
    const decisionAsOfMs = parseTimestampMs(rawRow.decision_as_of);

    if (createdMs === null || observedMs === null || decisionAsOfMs === null) {
        return baseUnavailable('invalid_source_time');
    }
    if (createdMs > asOfMs || observedMs > asOfMs || decisionAsOfMs > asOfMs) {
        return baseUnavailable('not_yet_observed');
    }

    const adaptedRow = adaptContextEnvelope(rawRow);
    if (!adaptedRow) {
        return baseUnavailable('sections_incomplete');
    }

    const sourceStatusValidation = validateSourceStatusMap(adaptedRow.source_status, asOfMs);
    if (!sourceStatusValidation.ok) {
        return baseUnavailable(sourceStatusValidation.reason);
    }
    const sourceStatus = sourceStatusValidation.map;

    if (!isPlainObject(adaptedRow.sections)) {
        return baseUnavailable('sections_incomplete');
    }
    const rawSections = adaptedRow.sections as Record<string, unknown>;
    for (const k of Object.keys(rawSections)) {
        if (!HISTORY_CONTEXT_SECTIONS.includes(k as HistoryContextSectionKey)) {
            return baseUnavailable('sections_incomplete');
        }
    }

    const gameSec = validateGameSection(
        rawSections.game,
        expected.event_id,
        expected.sport,
        expected.game_date
    );
    if (!gameSec) {
        return baseUnavailable('sections_incomplete');
    }

    const venueSec = validateVenueSection(rawSections.venue ?? null);
    if (!venueSec.ok) {
        return baseUnavailable('sections_incomplete');
    }

    const formSec = validateFormSection(rawSections.form, expected.event_id, asOfMs);
    if (!formSec.ok) {
        return baseUnavailable(formSec.reason);
    }

    const h2hSec = validateH2HSection(rawSections.h2h, expected.event_id, asOfMs);
    if (!h2hSec.ok) {
        return baseUnavailable(h2hSec.reason);
    }

    const injuriesSec = validateInjuriesSection(rawSections.injuries, asOfMs);
    if (!injuriesSec.ok) {
        return baseUnavailable(injuriesSec.reason);
    }

    const weatherSec = validateWeatherSection(rawSections.weather ?? null);
    if (!weatherSec.ok) {
        return baseUnavailable('sections_incomplete');
    }

    const oddsSec = validateOddsSection(rawSections.odds, asOfMs);
    if (!oddsSec.ok) {
        return baseUnavailable(oddsSec.reason);
    }

    // Evaluate per-section availability and freshness relative to asOfMs
    const freshnessViolations: HistoryContextSectionKey[] = [];
    const availableSections: HistoryContextSectionKey[] = [];

    for (const secKey of HISTORY_CONTEXT_SECTIONS) {
        const st = sourceStatus[secKey];
        const statusOk =
            st.status === 'ok' ||
            st.status === 'empty_valid' ||
            (secKey === 'weather' &&
                st.status === 'not_applicable' &&
                (venueSec.data?.indoor === true || weatherSec.data?.dome_closed === true));

        if (!statusOk) {
            if (st.status === 'stale') {
                freshnessViolations.push(secKey);
            }
            continue;
        }

        if (secKey === 'odds' && oddsSec.data.length === 0) {
            continue;
        }

        // Check freshness window against asOfMs
        if (secKey in FRESHNESS_WINDOW_MS) {
            const maxAgeMs = FRESHNESS_WINDOW_MS[secKey as keyof typeof FRESHNESS_WINDOW_MS];
            let secObsMs = st.observed_at ? parseTimestampMs(st.observed_at) : null;
            if (secKey === 'odds' && oddsSec.latestCapturedMs !== null) {
                secObsMs =
                    secObsMs !== null
                        ? Math.min(secObsMs, oddsSec.latestCapturedMs)
                        : oddsSec.latestCapturedMs;
            }
            if (secObsMs === null) {
                if (st.status === 'ok' && secKey !== 'weather') {
                    freshnessViolations.push(secKey);
                    continue;
                }
            } else if (asOfMs - secObsMs > maxAgeMs) {
                freshnessViolations.push(secKey);
                continue;
            }
        }

        availableSections.push(secKey);
    }

    const allSevenAvailable =
        availableSections.length === HISTORY_CONTEXT_SECTIONS.length &&
        freshnessViolations.length === 0 &&
        oddsSec.data.length > 0;

    const effectiveStatus: 'ready' | 'partial' =
        rawStatus === 'ready' && allSevenAvailable ? 'ready' : 'partial';

    const refKey = `${expected.sport}|${expected.game_date}|${expected.event_id}`;
    const suppliedRef = snapshotRefMap.get(refKey);
    const snapshotRefMatched = suppliedRef
        ? suppliedRef.snapshot_id === snapshotId && suppliedRef.content_hash === contentHash
        : undefined;

    return {
        event_id: expected.event_id,
        game_date: expected.game_date,
        sport: expected.sport,
        status: effectiveStatus,
        unavailable_reason:
            effectiveStatus === 'ready'
                ? null
                : (rawRow.unavailable_reason as UnavailableContextReason | null) ??
                  'sections_incomplete',
        snapshot_id: snapshotId,
        content_hash: contentHash,
        version,
        schema_ver: 1,
        created_at: rawRow.created_at as string,
        observed_at: rawRow.observed_at as string,
        decision_as_of: rawRow.decision_as_of as string,
        sections: {
            game: gameSec,
            venue: venueSec.data,
            form: formSec.data,
            h2h: h2hSec.data,
            injuries: injuriesSec.data,
            weather: weatherSec.data,
            odds: oddsSec.data
        },
        source_status: sourceStatus,
        integrity_source: 'db_rpc_verified',
        freshness_violations: freshnessViolations,
        available_sections: availableSections,
        ...(snapshotRefMatched !== undefined ? { snapshot_ref_matched: snapshotRefMatched } : {})
    };
}

export interface FormatPromptContextOptions {
    rows: ValidatedEventContextRow[];
    requiredContext?: HistoryContextSectionKey[];
    asOf: string;
    maxTotalBytes?: number;
    maxCharsPerEvent?: number;
}

export function formatGameContextForPrompt(
    options: FormatPromptContextOptions
):
    | { ok: true; formattedBlock: string; byteLength: number; reason?: string; detail?: string }
    | { ok: false; reason: string; detail: string } {
    const maxTotalBytes = options.maxTotalBytes ?? MAX_PROMPT_HISTORY_BYTES;
    const maxCharsPerEvent = options.maxCharsPerEvent ?? MAX_PROMPT_CHARS_PER_EVENT;
    const requiredSet = new Set<HistoryContextSectionKey>(options.requiredContext ?? []);

    const validRows = options.rows.filter(
        (r) => (r.status === 'ready' || r.status === 'partial') && r.sections !== null
    );
    if (validRows.length === 0) {
        return { ok: true, formattedBlock: '', byteLength: 0 };
    }

    const header = `[IMMUTABLE GAME CONTEXT SNAPSHOTS | asOf=${options.asOf} | integrity=db_rpc_verified]`;
    const eventBlocks: string[] = [];

    for (const row of validRows) {
        const sec = row.sections!;
        const g = sec.game;
        const lines: string[] = [];

        const statusPart = g.status_at_capture ? ` | status=${g.status_at_capture}` : '';
        lines.push(
            `EVENT ${sanitizePromptValue(g.event_id)} (${sanitizePromptValue(g.sport)} | ${sanitizePromptValue(g.game_date)} | start=${sanitizePromptValue(g.scheduled_start)}${statusPart}): ${sanitizePromptValue(g.away_team)} (${sanitizePromptValue(g.away_team_id)}) @ ${sanitizePromptValue(g.home_team)} (${sanitizePromptValue(g.home_team_id)}) [snapshot_id=${row.snapshot_id}, content_hash=${row.content_hash}]`
        );

        if (sec.venue) {
            const v = sec.venue;
            lines.push(
                `  Venue: ${sanitizePromptValue(v.name || 'N/A')}, ${sanitizePromptValue(v.city || 'N/A')}, ${sanitizePromptValue(v.country || 'N/A')} (indoor=${String(v.indoor)}, surface=${sanitizePromptValue(v.surface || 'N/A')})`
            );
        }

        if (sec.odds.length > 0) {
            const oddsSummaries = sec.odds.slice(0, 4).map((o) => {
                const tag = o.is_opening ? 'open' : 'curr';
                return `${sanitizePromptValue(o.book)}(${tag}): spread=${o.spread_home ?? 'N/A'}/${o.spread_away ?? 'N/A'}, total=${o.total ?? 'N/A'}, ml=${o.ml_home ?? 'N/A'}/${o.ml_away ?? 'N/A'} @${sanitizePromptValue(o.captured_at)}`;
            });
            lines.push(`  Odds: ${oddsSummaries.join(' | ')}`);
        }

        if (sec.form.length > 0) {
            const homeForm = sec.form
                .filter((f) => f.team_id === g.home_team_id)
                .slice(0, 5)
                .map((f) => `${f.result}(${f.points_for}-${f.points_against})`)
                .join(',');
            const awayForm = sec.form
                .filter((f) => f.team_id === g.away_team_id)
                .slice(0, 5)
                .map((f) => `${f.result}(${f.points_for}-${f.points_against})`)
                .join(',');
            lines.push(
                `  Form(<=5): ${sanitizePromptValue(g.home_team_id)}=[${homeForm || 'none'}] | ${sanitizePromptValue(g.away_team_id)}=[${awayForm || 'none'}]`
            );
        }

        if (sec.h2h.length > 0) {
            const h2hSummaries = sec.h2h.slice(0, 5).map((h) => {
                return `${sanitizePromptValue(h.completed_at.slice(0, 10))}:${sanitizePromptValue(h.home_team_id)} ${h.home_score}-${h.away_score} ${sanitizePromptValue(h.away_team_id)}`;
            });
            lines.push(`  H2H(<=5): ${h2hSummaries.join(', ')}`);
        }

        if (sec.injuries.length > 0) {
            const injSummaries = sec.injuries.slice(0, 8).map((inj) => {
                return `${sanitizePromptValue(inj.team_id)}:${sanitizePromptValue(inj.player_name)}(${inj.status})`;
            });
            lines.push(`  Injuries: ${injSummaries.join(', ')}`);
        }

        if (sec.weather) {
            const w = sec.weather;
            lines.push(
                `  Weather: ${sanitizePromptValue(w.condition || 'N/A')}, tempC=${w.temp_c ?? 'N/A'}, windKph=${w.wind_kph ?? 'N/A'}, precip=${w.precip_prob ?? 'N/A'}`
            );
        }

        let block = lines.join('\n');
        if (block.length > maxCharsPerEvent) {
            if (requiredSet.size > 0) {
                return {
                    ok: false,
                    reason: 'required_context_budget_exceeded',
                    detail: `Event ${g.event_id} context exceeds ${maxCharsPerEvent} character limit with required sections`
                };
            }
            block = block.slice(0, maxCharsPerEvent);
        }
        eventBlocks.push(block);
    }

    const fullText = `${header}\n${eventBlocks.join('\n')}`;
    const totalBytes = utf8ByteLength(fullText);
    if (totalBytes > maxTotalBytes) {
        if (requiredSet.size > 0) {
            return {
                ok: false,
                reason: 'required_context_budget_exceeded',
                detail: `Total context exceeds ${maxTotalBytes} UTF-8 byte cap with required sections`
            };
        }
        // Drop optional trailing event blocks cleanly without partial line corruption
        const fittedBlocks: string[] = [];
        for (const b of eventBlocks) {
            const candidate = `${header}\n${[...fittedBlocks, b].join('\n')}`;
            if (utf8ByteLength(candidate) <= maxTotalBytes) {
                fittedBlocks.push(b);
            } else {
                break;
            }
        }
        const fittedText = fittedBlocks.length > 0 ? `${header}\n${fittedBlocks.join('\n')}` : '';
        return {
            ok: true,
            formattedBlock: fittedText,
            byteLength: utf8ByteLength(fittedText)
        };
    }

    return {
        ok: true,
        formattedBlock: fullText,
        byteLength: totalBytes
    };
}

export async function readGameContextFromStore(
    cfg: SupabaseReadOnlyConfig | null,
    scope: TrustedRetrievalScope,
    fetchFn: typeof fetch = fetch
): Promise<GameContextStoreReadResult> {
    if (!cfg || !cfg.supabaseUrl.startsWith('http') || !cfg.supabasePublishableKey) {
        return {
            status: 'store_not_ready',
            reason: 'missing_readonly_key',
            detail: 'SUPABASE_URL or publishable read-only key is not configured'
        };
    }

    const HEX_32_REGEX = /^[0-9a-f]{32}$/i;
    const resolvedGroups: Array<{
        sport: string;
        date: string;
        eventIds: string[];
        entityIds?: string[];
    }> = [];

    for (const g of scope.groups) {
        const hexEventIds = g.eventIds.filter((id) => HEX_32_REGEX.test(id));
        const hexEntityIds = (g.entityIds || []).filter((id) => HEX_32_REGEX.test(id));
        const allHex = Array.from(new Set([...hexEventIds, ...hexEntityIds]));

        const aliasMap = new Map<string, string>();
        if (allHex.length > 0) {
            try {
                const aliasUrl = `${cfg.supabaseUrl}/rest/v1/canonical_game_aliases?provider=eq.Odds%20API&game_date=eq.${encodeURIComponent(g.date)}&provider_event_id=in.(${allHex.map((id) => encodeURIComponent(id)).join(',')})&select=provider_event_id,event_id`;
                const aliasRes = await fetchFn(aliasUrl, {
                    method: 'GET',
                    headers: {
                        apikey: cfg.supabasePublishableKey,
                        Authorization: `Bearer ${cfg.supabasePublishableKey}`,
                        Accept: 'application/json'
                    }
                });
                if (aliasRes.ok) {
                    const aliasData = await aliasRes.json();
                    if (Array.isArray(aliasData)) {
                        for (const row of aliasData) {
                            if (
                                isPlainObject(row) &&
                                typeof row.provider_event_id === 'string' &&
                                typeof row.event_id === 'string'
                            ) {
                                aliasMap.set(row.provider_event_id, row.event_id);
                            }
                        }
                    }
                } else {
                    console.warn(`[HistoryContextStore] canonical_game_aliases lookup returned status ${aliasRes.status}`);
                }
            } catch (err: any) {
                console.warn(`[HistoryContextStore] canonical_game_aliases lookup error: ${String(err?.message || err)}`);
            }
        }

        const resolvedEventIds: string[] = [];
        for (const evId of g.eventIds) {
            if (HEX_32_REGEX.test(evId)) {
                const canonical = aliasMap.get(evId);
                if (canonical) {
                    resolvedEventIds.push(canonical);
                } else {
                    console.warn(`[HistoryContextStore] Unresolved 32-hex id skipped: count=1, id=${evId}`);
                }
            } else {
                resolvedEventIds.push(evId);
            }
        }

        let resolvedEntityIds: string[] | undefined = undefined;
        if (g.entityIds) {
            resolvedEntityIds = [];
            for (const entId of g.entityIds) {
                if (HEX_32_REGEX.test(entId)) {
                    const canonical = aliasMap.get(entId);
                    if (canonical) {
                        resolvedEntityIds.push(canonical);
                    } else {
                        console.warn(`[HistoryContextStore] Unresolved 32-hex id skipped: count=1, id=${entId}`);
                    }
                } else {
                    resolvedEntityIds.push(entId);
                }
            }
        }

        resolvedGroups.push({
            sport: g.sport,
            date: g.date,
            eventIds: resolvedEventIds,
            ...(resolvedEntityIds ? { entityIds: resolvedEntityIds } : {})
        });
    }

    const expectedOrder: Array<{ sport: string; game_date: string; event_id: string }> = [];
    for (const g of resolvedGroups) {
        for (const evId of g.eventIds) {
            expectedOrder.push({
                sport: g.sport,
                game_date: g.date,
                event_id: evId
            });
        }
    }

    if (expectedOrder.length === 0) {
        return {
            status: 'ok',
            asOf: scope.asOf,
            results: [],
            byEventId: new Map(),
            allReadyForSlim: false,
            missingRequiredSectionsByEvent: {},
            formattedBlock: ''
        };
    }

    const rpcBody = {
        groups: resolvedGroups.map((g) => ({
            sport: g.sport,
            date: g.date,
            eventIds: g.eventIds,
            ...(g.entityIds && g.entityIds.length > 0 ? { entityIds: g.entityIds } : {})
        })),
        as_of: scope.asOf
    };

    let res: Response;
    try {
        res = await fetchFn(`${cfg.supabaseUrl}/rest/v1/rpc/read_game_context_v1`, {
            method: 'POST',
            headers: {
                apikey: cfg.supabasePublishableKey,
                Authorization: `Bearer ${cfg.supabasePublishableKey}`,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify(rpcBody)
        });
    } catch (err: any) {
        return {
            status: 'outage',
            httpStatus: 503,
            error: 'history_context_read_failed',
            detail: String(err?.message || err)
        };
    }

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        let errCode = '';
        let errMessage = errText;
        try {
            const parsedErr = JSON.parse(errText);
            if (isPlainObject(parsedErr)) {
                errCode = typeof parsedErr.code === 'string' ? parsedErr.code : '';
                errMessage =
                    typeof parsedErr.message === 'string' ? parsedErr.message : errText;
            }
        } catch {
            // non-JSON error text
        }

        if (errCode === '22023' || (res.status === 400 && /22023|as_of|scope/i.test(errText))) {
            return {
                status: 'invalid_scope',
                httpStatus: 400,
                error: 'invalid_retrieval_scope',
                detail: errMessage || 'Database rejected scope or as_of cutoff (22023)'
            };
        }

        if (
            res.status === 404 ||
            errCode === 'PGRST202' ||
            errCode === '42883' ||
            errCode === '42P01'
        ) {
            return {
                status: 'store_not_ready',
                reason: 'rpc_not_found',
                detail: errMessage || `RPC read_game_context_v1 not ready (${res.status})`
            };
        }

        return {
            status: 'outage',
            httpStatus: 503,
            error: 'history_context_read_failed',
            detail: `RPC read_game_context_v1 failed [${res.status}]: ${errMessage}`
        };
    }

    let payload: unknown;
    try {
        payload = await res.json();
    } catch (err: any) {
        return {
            status: 'outage',
            httpStatus: 503,
            error: 'history_context_read_failed',
            detail: `Invalid JSON from read_game_context_v1: ${String(err?.message || err)}`
        };
    }

    if (!isPlainObject(payload)) {
        console.warn('[HistoryContextStore] Malformed RPC response envelope: payload is not an object');
        return {
            status: 'outage',
            httpStatus: 503,
            error: 'history_context_read_failed',
            detail: 'Malformed RPC response envelope from read_game_context_v1'
        };
    }

    // Top-level status "empty" or items: [] is a valid no-context result, not an error
    if (
        payload.status === 'empty' ||
        (payload.status === 'ready' && Array.isArray(payload.items) && payload.items.length === 0) ||
        (payload.schema_ver === 1 && Array.isArray(payload.results) && payload.results.length === 0)
    ) {
        return {
            status: 'ok',
            asOf: scope.asOf,
            results: expectedOrder.map((exp) => ({
                event_id: exp.event_id,
                game_date: exp.game_date,
                sport: exp.sport,
                status: 'unavailable',
                unavailable_reason: 'no_snapshot',
                snapshot_id: null,
                content_hash: null,
                version: null,
                schema_ver: 1,
                created_at: null,
                observed_at: null,
                decision_as_of: null,
                sections: null,
                source_status: null,
                integrity_source: 'none',
                freshness_violations: [],
                available_sections: []
            })),
            byEventId: new Map(),
            allReadyForSlim: false,
            missingRequiredSectionsByEvent: {},
            formattedBlock: ''
        };
    }

    let rawResults: unknown[];
    if (Array.isArray(payload.items)) {
        rawResults = payload.items;
    } else if (Array.isArray(payload.results)) {
        rawResults = payload.results;
    } else {
        console.warn('[HistoryContextStore] Malformed RPC response envelope from read_game_context_v1: missing results or items array');
        return {
            status: 'outage',
            httpStatus: 503,
            error: 'history_context_read_failed',
            detail: 'Malformed RPC response envelope from read_game_context_v1'
        };
    }

    const acceptedAsOfMs = typeof payload.as_of === 'string' ? parseTimestampMs(payload.as_of) : scope.asOfMs;
    if (acceptedAsOfMs === null || acceptedAsOfMs > scope.asOfMs) {
        return {
            status: 'outage',
            httpStatus: 503,
            error: 'history_context_read_failed',
            detail: 'RPC response as_of exceeds requested cutoff'
        };
    }

    if (rawResults.length !== expectedOrder.length) {
        return {
            status: 'outage',
            httpStatus: 503,
            error: 'history_context_read_failed',
            detail: `RPC results count (${rawResults.length}) does not match requested event count (${expectedOrder.length})`
        };
    }

    const refMap = new Map<string, SnapshotRef>();
    for (const ref of scope.snapshotRefs) {
        refMap.set(`${ref.sport}|${ref.game_date}|${ref.event_id}`, ref);
    }

    const validatedRows: ValidatedEventContextRow[] = [];
    const byEventId = new Map<string, ValidatedEventContextRow>();
    const missingRequiredSectionsByEvent: Record<string, HistoryContextSectionKey[]> = {};

    for (let i = 0; i < expectedOrder.length; i++) {
        const exp = expectedOrder[i];
        const rawRow = rawResults[i];
        const validated = validateRpcResultRow(rawRow, exp, scope.asOfMs, refMap);
        validatedRows.push(validated);
        byEventId.set(exp.event_id, validated);

        if (scope.requiredContext.length > 0) {
            const availSet = new Set<HistoryContextSectionKey>(validated.available_sections);
            const missingReq = scope.requiredContext.filter((sec) => !availSet.has(sec));
            if (missingReq.length > 0 || validated.status === 'unavailable') {
                missingRequiredSectionsByEvent[exp.event_id] =
                    missingReq.length > 0 ? missingReq : [...scope.requiredContext];
            }
        }
    }

    const allReadyForSlim =
        validatedRows.length > 0 &&
        validatedRows.every(
            (r) =>
                r.status === 'ready' &&
                r.integrity_source === 'db_rpc_verified' &&
                r.sections !== null &&
                r.sections.odds.length > 0 &&
                r.freshness_violations.length === 0
        );

    const formatted = formatGameContextForPrompt({
        rows: validatedRows,
        requiredContext: scope.requiredContext,
        asOf: scope.asOf
    });

    if (!formatted.ok) {
        for (const exp of expectedOrder) {
            if (!missingRequiredSectionsByEvent[exp.event_id]) {
                missingRequiredSectionsByEvent[exp.event_id] = [...scope.requiredContext];
            }
        }
    }

    return {
        status: 'ok',
        asOf: new Date(acceptedAsOfMs).toISOString(),
        results: validatedRows,
        byEventId,
        allReadyForSlim,
        missingRequiredSectionsByEvent,
        formattedBlock: formatted.ok ? formatted.formattedBlock : ''
    };
}

/**
 * Attaches supplied snapshot provenance (context_snapshot_id, context_hash) to a judgment output,
 * and rejects any echoed IDs/hashes that do not match the validated supplied snapshot set.
 */
export function verifyAndAttachJudgmentProvenance(
    judgment: Record<string, unknown>,
    snapshotsByEventId: ReadonlyMap<string, ValidatedEventContextRow>
):
    | { ok: true; judgment: Record<string, unknown>; reason?: 'mismatched_context_provenance'; message?: string }
    | { ok: false; reason: 'mismatched_context_provenance'; message: string } {
    const eventId = typeof judgment.event_id === 'string' ? judgment.event_id.trim() : '';
    const supplied = eventId ? snapshotsByEventId.get(eventId) : undefined;

    const echoedId =
        typeof judgment.context_snapshot_id === 'string'
            ? judgment.context_snapshot_id.trim()
            : undefined;
    const echoedHash =
        typeof judgment.context_hash === 'string'
            ? judgment.context_hash.trim()
            : typeof judgment.content_hash === 'string'
              ? judgment.content_hash.trim()
              : undefined;

    if (!supplied || !supplied.snapshot_id || !supplied.content_hash) {
        if (echoedId || echoedHash) {
            return {
                ok: false,
                reason: 'mismatched_context_provenance',
                message: `Judgment echoed provenance for event ${eventId || 'unknown'} when no validated snapshot was supplied`
            };
        }
        return { ok: true, judgment: { ...judgment } };
    }

    if (echoedId && echoedId !== supplied.snapshot_id) {
        return {
            ok: false,
            reason: 'mismatched_context_provenance',
            message: `Echoed context_snapshot_id (${echoedId}) does not match supplied snapshot_id (${supplied.snapshot_id})`
        };
    }

    if (echoedHash && echoedHash !== supplied.content_hash) {
        return {
            ok: false,
            reason: 'mismatched_context_provenance',
            message: `Echoed context_hash (${echoedHash}) does not match supplied content_hash (${supplied.content_hash})`
        };
    }

    return {
        ok: true,
        judgment: {
            ...judgment,
            context_snapshot_id: supplied.snapshot_id,
            context_hash: supplied.content_hash
        }
    };
}
