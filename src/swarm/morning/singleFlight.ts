/**
 * R3-S1 morning dedupe (hotfix for doubled LLM cost).
 * In-process only, per the plan: Render runs ONE instance of the web service, so a module-level lock and a
 * claim map are enough. No DB/KV table and no migration. If the service is ever scaled past one instance,
 * this must move to a DB/KV claim (see the deploy notes).
 */

/** A game claimed by a run is skipped by any other run for 20 minutes (one Worker trigger interval). */
export const MORNING_CLAIM_TTL_MS = 20 * 60 * 1000;

let morningRunInFlight = false;

/** Returns true and takes the lock if no morning run is in flight; false if one already is. */
export function tryAcquireMorningLock(): boolean {
  if (morningRunInFlight) return false;
  morningRunInFlight = true;
  return true;
}

export function releaseMorningLock(): void {
  morningRunInFlight = false;
}

export function isMorningRunInFlight(): boolean {
  return morningRunInFlight;
}

export interface MorningClaimStore {
  /** True if the key was claimed less than the TTL ago. */
  isClaimed(key: string, now?: number): boolean;
  /** Records a claim at `now` (defaults to Date.now()). */
  claim(key: string, now?: number): void;
}

export function morningClaimKey(gameDate: string, eventId: string): string {
  return `${gameDate}|${eventId}`;
}

export function createMorningClaimStore(
  ttlMs: number = MORNING_CLAIM_TTL_MS,
): MorningClaimStore & { size(): number; clear(): void } {
  const claims = new Map<string, number>();
  const prune = (now: number) => {
    for (const [key, at] of claims) {
      if (now - at >= ttlMs) claims.delete(key);
    }
  };
  return {
    isClaimed(key: string, now: number = Date.now()): boolean {
      prune(now);
      const at = claims.get(key);
      return at !== undefined && now - at < ttlMs;
    },
    claim(key: string, now: number = Date.now()): void {
      claims.set(key, now);
    },
    size(): number {
      return claims.size;
    },
    clear(): void {
      claims.clear();
    },
  };
}

/** The claim store POST /api/swarm/morning passes to runMorningSlate. */
export const morningClaims = createMorningClaimStore();

/** Test helper: drop the lock and every claim. */
export function resetMorningSingleFlight(): void {
  morningRunInFlight = false;
  morningClaims.clear();
}
