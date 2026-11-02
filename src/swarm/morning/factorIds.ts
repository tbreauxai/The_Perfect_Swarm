/**
 * Confidence factor registry v1 (plan_confidence_calibration_2026-11-02). The judge may only NAME factor ids
 * from this list and cite evidence; it never supplies a magnitude or direction. DuelOdds code derives the sign,
 * applies the weight (logit), clamps each delta to FACTOR_CAP and the sum to FACTOR_TOTAL_CAP.
 *
 * MIRROR: factor_registry.v1.json is the shared copy, kept byte-identical in DuelOdds
 * (factorIds.test.ts checks these constants against it). Change ids only with a REGISTRY_VERSION bump.
 * Self-contained on purpose: no imports.
 */

export const REGISTRY_VERSION = 1;

export const REGISTRY_IDS = [
    "inj_qb_out",
    "inj_star_out",
    "inj_goalie_backup",
    "sp_scratch",
    "wind_high",
    "precip_heavy",
    "cold_extreme",
    "rest_b2b",
    "travel_long",
] as const;
export type FactorId = (typeof REGISTRY_IDS)[number];

const FOOTBALL = ["americanfootball_nfl", "americanfootball_ncaaf"];
const OUTDOOR = ["americanfootball_nfl", "americanfootball_ncaaf", "baseball_mlb"];
const NBA_NHL = ["basketball_nba", "icehockey_nhl"];

/** Sport keys (odds-api style, as SlateGame.sport) each factor is allowed for. */
export const FACTOR_SPORTS: Record<FactorId, readonly string[]> = {
    inj_qb_out: FOOTBALL,
    inj_star_out: ["basketball_nba", "basketball_wnba", "basketball_ncaab"],
    inj_goalie_backup: ["icehockey_nhl"],
    sp_scratch: ["baseball_mlb"],
    wind_high: OUTDOOR,
    precip_heavy: OUTDOOR,
    cold_extreme: FOOTBALL,
    rest_b2b: NBA_NHL,
    travel_long: NBA_NHL,
};

/** Default logit weights (Tyler decision 5: 0.05-0.10). Used by DuelOdds; the swarm only carries them for parity. */
export const FACTOR_DEFAULT_WEIGHTS: Record<FactorId, number> = {
    inj_qb_out: 0.1,
    inj_star_out: 0.08,
    inj_goalie_backup: 0.08,
    sp_scratch: 0.08,
    wind_high: 0.06,
    precip_heavy: 0.05,
    cold_extreme: 0.05,
    rest_b2b: 0.05,
    travel_long: 0.05,
};

/** Per-factor |delta| cap and |sum| cap, in logit. */
export const FACTOR_CAP = 0.15;
export const FACTOR_TOTAL_CAP = 0.35;
/** Max factors one judgment may name. */
export const FACTOR_MAX_PER_JUDGMENT = 4;

export const FACTOR_EVIDENCE_KINDS = ["espn_field", "url"] as const;
/** Allowed hosts for url evidence (a host or any subdomain of it). */
export const FACTOR_URL_HOSTS: readonly string[] = ["espn.com", "api.weather.gov", "open-meteo.com"];

/** JUDGMENT_FACTORS gate. Off unless the env value is exactly "1" or "true". Only used when JUDGMENT_SCHEMA_V2 is on. */
export function isJudgmentFactors(env: Record<string, string | undefined> | undefined): boolean {
    const v = String(env?.JUDGMENT_FACTORS ?? "").trim().toLowerCase();
    return v === "1" || v === "true";
}

/** True when the url is https and its host is on FACTOR_URL_HOSTS. */
export function isAllowedEvidenceUrl(ref: string): boolean {
    let u: URL;
    try {
        u = new URL(ref);
    } catch {
        return false;
    }
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return FACTOR_URL_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}
