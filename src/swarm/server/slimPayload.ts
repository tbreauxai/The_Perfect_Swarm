/**
 * Slim-v1 analyze/stream contract (Manager-resolved Nov 6 2026 + fidelity review).
 * DuelOdds: /workspace/tmp/slim_ids_contract.md + ide_duelodds_slim_ids.txt S.3/S.4
 * Wire body omits `data`. Empty/failed pulls → HTTP 422 { error: "slim_pull_empty"|"slim_pull_failed", payload:"slim-v1" }.
 */

export const SLIM_PAYLOAD_VERSION = 'slim-v1' as const;

export interface SlimSwarmRequest {
  payload: typeof SLIM_PAYLOAD_VERSION;
  task: string;
  date: string;
  eventIds: string[];
  sport: string;
}

export function isSlimSwarmRequest(body: unknown): body is SlimSwarmRequest {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return (
    b.payload === SLIM_PAYLOAD_VERSION &&
    typeof b.task === 'string' &&
    typeof b.date === 'string' &&
    typeof b.sport === 'string' &&
    Array.isArray(b.eventIds) &&
    (b.eventIds as unknown[]).length > 0 &&
    (b.eventIds as unknown[]).every((id) => typeof id === 'string' && String(id).trim().length > 0)
  );
}

/** Validate slim fields; returns slim_pull_failed detail or null if ok. */
export function validateSlimSwarmRequest(body: SlimSwarmRequest): string | null {
  const date = String(body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return 'slim_pull_failed';
  }
  if (!String(body.sport || '').trim()) {
    return 'slim_pull_failed';
  }
  const ids = (body.eventIds || []).map((id) => String(id).trim()).filter(Boolean);
  if (ids.length === 0) {
    return 'slim_pull_failed';
  }
  return null;
}

export function slimIdsStubData(body: SlimSwarmRequest): string {
  const ids = body.eventIds.map((id) => String(id).trim()).filter(Boolean);
  return [
    '[SLIM_V1_IDS]',
    `date=${body.date}`,
    `sport=${body.sport}`,
    `eventIds=${ids.join(',')}`
  ].join('\n');
}

export const SEED_MANIFEST_VERSION = 'v2-seed' as const;

export interface SeedManifestPricing {
  selection: string;
  book_odds: number;
  fair_prob: number;
  line?: number;
}

export interface SeedManifestFlags {
  is_dome: boolean;
  hours_to_kickoff: number;
  has_active_injury_tags: boolean;
}

export interface SeedManifest {
  manifest_version: typeof SEED_MANIFEST_VERSION;
  candidate_id: string;
  game_id: string;
  sport: string;
  market_type: string;
  pricing: SeedManifestPricing;
  flags: SeedManifestFlags;
  available_tools: string[];
  task?: string;
  settings?: Record<string, unknown>;
  [key: string]: unknown;
}

export function isSeedManifestRequest(body: unknown): body is SeedManifest {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return b.manifest_version === SEED_MANIFEST_VERSION;
}

export function validateSeedManifestRequest(body: SeedManifest): string | null {
  if (!body || typeof body !== 'object') {
    return 'invalid_seed_manifest: body must be an object';
  }
  if (body.manifest_version !== SEED_MANIFEST_VERSION) {
    return `invalid_seed_manifest: manifest_version must be '${SEED_MANIFEST_VERSION}'`;
  }
  if (typeof body.candidate_id !== 'string' || !body.candidate_id.trim()) {
    return 'invalid_seed_manifest: missing or empty candidate_id';
  }
  if (typeof body.game_id !== 'string' || !body.game_id.trim()) {
    return 'invalid_seed_manifest: missing or empty game_id';
  }
  if (typeof body.sport !== 'string' || !body.sport.trim()) {
    return 'invalid_seed_manifest: missing or empty sport';
  }
  if (typeof body.market_type !== 'string' || !body.market_type.trim()) {
    return 'invalid_seed_manifest: missing or empty market_type';
  }

  // Validate pricing
  if (!body.pricing || typeof body.pricing !== 'object') {
    return 'invalid_seed_manifest: missing or invalid pricing';
  }
  if (typeof body.pricing.selection !== 'string' || !body.pricing.selection.trim()) {
    return 'invalid_seed_manifest: missing or empty pricing.selection';
  }
  if (typeof body.pricing.book_odds !== 'number' || !Number.isFinite(body.pricing.book_odds)) {
    return 'invalid_seed_manifest: pricing.book_odds must be a finite number';
  }
  if (typeof body.pricing.fair_prob !== 'number' || !Number.isFinite(body.pricing.fair_prob)) {
    return 'invalid_seed_manifest: pricing.fair_prob must be a finite number';
  }
  if (body.pricing.line !== undefined && (typeof body.pricing.line !== 'number' || !Number.isFinite(body.pricing.line))) {
    return 'invalid_seed_manifest: pricing.line must be a finite number when provided';
  }

  // Validate flags
  if (!body.flags || typeof body.flags !== 'object') {
    return 'invalid_seed_manifest: missing or invalid flags';
  }
  if (typeof body.flags.is_dome !== 'boolean') {
    return 'invalid_seed_manifest: flags.is_dome must be a boolean';
  }
  if (typeof body.flags.hours_to_kickoff !== 'number' || !Number.isFinite(body.flags.hours_to_kickoff)) {
    return 'invalid_seed_manifest: flags.hours_to_kickoff must be a finite number';
  }
  if (typeof body.flags.has_active_injury_tags !== 'boolean') {
    return 'invalid_seed_manifest: flags.has_active_injury_tags must be a boolean';
  }

  // Validate available_tools
  if (!Array.isArray(body.available_tools) || !body.available_tools.every((t) => typeof t === 'string')) {
    return 'invalid_seed_manifest: available_tools must be an array of strings';
  }

  return null;
}

export function seedManifestStubData(manifest: SeedManifest): string {
  return [
    '[SEED_MANIFEST_V2]',
    `candidate_id=${manifest.candidate_id}`,
    `game_id=${manifest.game_id}`,
    `sport=${manifest.sport}`,
    `market_type=${manifest.market_type}`,
    `selection=${manifest.pricing.selection}`,
    `book_odds=${manifest.pricing.book_odds}`,
    `fair_prob=${manifest.pricing.fair_prob}`,
    manifest.pricing.line !== undefined ? `line=${manifest.pricing.line}` : '',
    `is_dome=${manifest.flags.is_dome}`,
    `hours_to_kickoff=${manifest.flags.hours_to_kickoff}`,
    `has_active_injury_tags=${manifest.flags.has_active_injury_tags}`,
    `available_tools=${manifest.available_tools.join(',')}`
  ].filter(Boolean).join('\n');
}
