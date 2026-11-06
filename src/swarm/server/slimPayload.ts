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
