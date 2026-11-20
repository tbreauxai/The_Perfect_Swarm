import { getSupabaseConfig } from '../morning/supabase.ts';
import { getRunDebugRecord, isRunDebugEnabled, type RunDebugRecord } from './runDebugRecord.ts';

const MAX_PAYLOAD_BYTES = 200_000;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 1500;

export function isRunDebugPersistEnabled(): boolean {
  return isRunDebugEnabled() && typeof process !== 'undefined' && process.env?.SWARM_RUN_DEBUG_PERSIST === '1';
}

function scrubSecrets(text: string): string {
  if (!text) return '';
  return text
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|gsk_[a-zA-Z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z._-]{15,}|ghp_[0-9A-Za-z]{20,})\b/g, '[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|token|secret)\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]');
}

function cloneAndCapPayload(rec: RunDebugRecord): RunDebugRecord {
  const copy: RunDebugRecord = JSON.parse(scrubSecrets(JSON.stringify(rec)));
  let serialized = JSON.stringify(copy);
  if (serialized.length <= MAX_PAYLOAD_BYTES) {
    return copy;
  }

  const seatKeys = Object.keys(copy.seats || {});
  const excess = serialized.length - MAX_PAYLOAD_BYTES;
  let remainingToTrim = excess + 64;

  // Trim toolResultsSent first, labeling with [trimmed]
  for (const key of seatKeys) {
    if (remainingToTrim <= 0) break;
    const seat = copy.seats[key];
    if (seat && typeof seat.toolResultsSent === 'string' && seat.toolResultsSent.length > 0) {
      const label = ' [trimmed]';
      const cutAmt = Math.min(seat.toolResultsSent.length, remainingToTrim + label.length);
      const nextLen = Math.max(0, seat.toolResultsSent.length - cutAmt);
      seat.toolResultsSent = nextLen > 0
        ? `${seat.toolResultsSent.slice(0, nextLen)}${label}`
        : '[trimmed]';
      remainingToTrim -= cutAmt;
    }
  }

  serialized = JSON.stringify(copy);
  if (serialized.length > MAX_PAYLOAD_BYTES) {
    // Hard fallback if still over 200KB: clear toolResultsSent across all seats
    for (const key of seatKeys) {
      const seat = copy.seats[key];
      if (seat && typeof seat.toolResultsSent === 'string') {
        seat.toolResultsSent = '[trimmed]';
      }
    }
  }

  return copy;
}

export async function persistRunDebugRecord(workflowId: string | undefined): Promise<void> {
  if (!isRunDebugPersistEnabled() || !workflowId) return;

  try {
    const rec = getRunDebugRecord(workflowId);
    if (!rec) return;

    const cfg = getSupabaseConfig();
    if (!cfg) return;

    const payload = cloneAndCapPayload(rec);
    const body = JSON.stringify({
      workflow_id: rec.workflowId,
      created_at: rec.createdAt,
      payload
    });

    const headers: Record<string, string> = {
      apikey: cfg.supabaseServiceKey,
      Authorization: `Bearer ${cfg.supabaseServiceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    };

    const postController = new AbortController();
    const postTimer = setTimeout(() => postController.abort(), REQUEST_TIMEOUT_MS);
    try {
      const postRes = await fetch(`${cfg.supabaseUrl}/rest/v1/swarm_run_debug`, {
        method: 'POST',
        headers,
        body,
        signal: postController.signal
      });
      if (postRes && !postRes.ok) {
        console.warn(`[RunDebugPersist] POST swarm_run_debug status=${postRes.status}`);
      }
    } finally {
      clearTimeout(postTimer);
    }

    const cutoffIso = new Date(Date.now() - TTL_MS).toISOString();
    const delController = new AbortController();
    const delTimer = setTimeout(() => delController.abort(), REQUEST_TIMEOUT_MS);
    try {
      const delRes = await fetch(
        `${cfg.supabaseUrl}/rest/v1/swarm_run_debug?created_at=lt.${encodeURIComponent(cutoffIso)}`,
        {
          method: 'DELETE',
          headers: {
            apikey: cfg.supabaseServiceKey,
            Authorization: `Bearer ${cfg.supabaseServiceKey}`
          },
          signal: delController.signal
        }
      );
      if (delRes && !delRes.ok) {
        console.warn(`[RunDebugPersist] DELETE swarm_run_debug status=${delRes.status}`);
      }
    } finally {
      clearTimeout(delTimer);
    }
  } catch {
    // Fire-and-forget: never throw on debug persistence failure
  }
}
