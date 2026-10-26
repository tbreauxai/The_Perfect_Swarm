import type { MorningArgument, MorningJudgeOutput, SlateGame } from './types.ts';
import { parseDeriveAndValidateJudgmentV2, type JudgmentV2, type JudgmentV2Result } from './judgment.ts';

/**
 * Builds a single-line columnar representation for a slate game.
 */
export function formatGameToColumnar(game: SlateGame): string {
  const weatherStr = game.weatherSnapshot?.displayValue 
    ? `${game.weatherSnapshot.temperature ?? ''}F ${game.weatherSnapshot.displayValue}`
    : 'Dome/Indoor/N/A';
  const oddsStr = game.oddsSnapshot?.details || (game.oddsSnapshot?.spread != null ? `Spread ${game.oddsSnapshot.spread}` : 'No Lines');
  return `#GAME:EVENT_ID|SPORT|MATCHUP|COMMENCE|WEATHER|POSTED_ODDS\n${game.eventId}|${game.sport}|${game.awayTeam} @ ${game.homeTeam}|${game.commenceTime}|${weatherStr}|${oddsStr}`;
}

/**
 * Lean debater/proposer task prompt containing the game board, matchup, and baseline.
 * Does NOT contain the JSON pick schema contract (which is only needed by the GodView Compiler / manager).
 */
export function buildProposerPrompt(game: SlateGame): string {
  const weatherStr = game.weatherSnapshot?.displayValue 
    ? `${game.weatherSnapshot.temperature ?? ''}°F, ${game.weatherSnapshot.displayValue}` 
    : 'Indoor/Dome/Standard';
  const oddsStr = game.oddsSnapshot?.details || (game.oddsSnapshot?.spread != null ? `Spread ${game.oddsSnapshot.spread}, Total ${game.oddsSnapshot.overUnder ?? 'N/A'}` : 'No Lines Posted');

  return `EVENT: ${game.awayTeam} @ ${game.homeTeam}
SPORT: ${game.sport}
COMMENCE: ${game.commenceTime}
WEATHER: ${weatherStr}
POSTED BOARD: ${oddsStr}

Analyze this matchup thoroughly. Evaluate team strengths, injuries, market movement, and tempo to assess fair lines, spread, total, and win probability from your specialist perspective.`;
}

/**
 * Judgment v2 (JUDGMENT_SCHEMA_V2): same board, but proposers project the score; no probabilities or fair lines.
 */
export function buildProposerPromptV2(game: SlateGame): string {
  return buildProposerPrompt(game).replace(
    'to assess fair lines, spread, total, and win probability from your specialist perspective.',
    'to project the final margin (home minus away) and the game total from your specialist perspective. Do not give probabilities, fair lines, odds or stakes.'
  );
}

/**
 * Clean judge prompt matching DuelOdds buildJudgePrompt.
 * Raw game data only; no prior verdict.
 */
export function buildJudgePrompt(
  game: SlateGame,
  transcriptA: string = '',
  transcriptB: string = '',
  criticReport: string = ''
): string {
  const weatherStr = game.weatherSnapshot?.displayValue 
    ? `${game.weatherSnapshot.temperature ?? ''}°F, ${game.weatherSnapshot.displayValue}` 
    : 'Indoor/Dome/Standard';

  return `You are the Morning Swarm Judge (GodView Compiler) for DuelOdds.
You must synthesize the full debate for ${game.awayTeam} @ ${game.homeTeam} (${game.sport}) and determine fair lines and win probabilities.

EVENT: ${game.awayTeam} @ ${game.homeTeam}
SPORT: ${game.sport}
COMMENCE: ${game.commenceTime}
WEATHER: ${weatherStr}

--- DEBATER A (Home + Over Case) ---
${transcriptA}

--- DEBATER B (Away + Under Case) ---
${transcriptB}

--- RISK CRITIC REPORT ---
${criticReport}

OUTPUT REQUIREMENT:
Output STRICT JSON ONLY. Do NOT wrap in markdown codeblocks (no \`\`\`json). Output a single raw JSON object matching this exact schema:

{
  "likelyWinner": "${game.homeTeam} or ${game.awayTeam}",
  "winProbHome": 0.55,
  "winProbAway": 0.45,
  "fairSpread": -3.5,
  "fairTotal": null,
  "totalLean": "over",
  "arguments": [
    {
      "claim": "Brief description of key claim that survived critic review",
      "advocate": "quant",
      "weight": "high",
      "supportingData": "Specific metric or injury evidence"
    }
  ],
  "invalidationConditions": [
    "Condition that would immediately nullify this judgment (e.g. key player scratch)"
  ],
  "dataAsOf": "${new Date().toISOString()}"
}

STRICT CONVENTIONS:
1. "fairSpread": MUST be from the HOME perspective (${game.homeTeam}).
   - Negative means HOME is favored (e.g., -4.5 means ${game.homeTeam} favored by 4.5).
   - Positive means AWAY is favored (e.g., +3.5 means ${game.awayTeam} favored by 3.5).
2. "winProbHome" and "winProbAway": Clamped between 0.01 and 0.99, summing to 1.00.
3. "fairTotal": Must be a realistic game total appropriate to this sport (e.g. NFL: 30-65, NCAAF: 30-80, NBA: 190-260, NCAAB: 110-180, MLB: 5-14, NHL: 4-8) or null if unable to estimate.
4. "totalLean": Must be strictly "over", "under", or "none".
5. "likelyWinner": Must strictly equal "${game.homeTeam}" or "${game.awayTeam}".
6. Do NOT output any explanatory text before or after the JSON.`;
}

/**
 * Judgment v2 manager contract (JUDGMENT_SCHEMA_V2). Code derives probabilities, fair lines and EV.
 * Keep it no longer than JUDGE_MANAGER_INSTRUCTION (Groq 7000 TPM limiter in morningCacheBypass).
 */
export const JUDGE_MANAGER_INSTRUCTION_V2 = `You are the Morning Swarm Judge (GodView Compiler) for DuelOdds.
Synthesize the debate into a score projection. Code computes probabilities, fair lines and EV.
Output STRICT JSON ONLY, no markdown, one raw object with exactly these keys:
{
  "side": "home",
  "projMargin": 3.5,
  "projTotal": 47.5,
  "totalLean": "over",
  "confidence": 0.6,
  "reasons": ["Key claim that survived critic review"]
}
RULES:
1. "projMargin": projected home score minus away score. Positive = home wins.
2. "side": "home" if projMargin >= 0.5, "away" if <= -0.5, else "pass".
3. "projTotal": projected combined score, realistic for the sport.
4. "totalLean": "over" if projTotal is 0.5+ above the posted total, "under" if 0.5+ below, else "pass".
5. "confidence": 0 to 1. "reasons": 1 to 3 strings, max 140 chars each.
6. No other keys: no probabilities, fair lines, odds, EV or stakes. No text outside the JSON.`;

export const JUDGE_MANAGER_INSTRUCTION = `You are the Morning Swarm Judge (GodView Compiler) for DuelOdds.
You must synthesize the full debate and determine fair lines and win probabilities.
OUTPUT REQUIREMENT:
Output STRICT JSON ONLY. Do NOT wrap in markdown codeblocks (no \`\`\`json). Output a single raw JSON object matching this exact schema:
{
  "likelyWinner": "<Home Team> or <Away Team>",
  "winProbHome": 0.55,
  "winProbAway": 0.45,
  "fairSpread": -3.5,
  "fairTotal": null,
  "totalLean": "over",
  "arguments": [
    {
      "claim": "Key claim that survived critic review",
      "advocate": "quant",
      "weight": "high",
      "supportingData": "Evidence"
    }
  ],
  "invalidationConditions": [
    "Condition that would immediately nullify this judgment"
  ],
  "dataAsOf": "${new Date().toISOString()}"
}

STRICT CONVENTIONS:
1. "fairSpread": MUST be from the HOME perspective. Negative means HOME favored, positive means AWAY favored.
2. "winProbHome" and "winProbAway": Must be numbers between 0.01 and 0.99, summing to 1.00.
3. "fairTotal": Realistic total inside the sport range in prompt rule 3, or null.
4. "totalLean": "over", "under", or "none".
5. Do NOT output any explanatory text before or after the JSON.`;

/**
 * Normalizes a team name for comparison.
 */
export function normalizeTeamName(name: string): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Compares two team names for loose equality.
 */
export function areTeamsEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const normA = normalizeTeamName(a);
  const normB = normalizeTeamName(b);
  if (normA === normB) return true;
  return normA.length > 2 && (normA.includes(normB) || normB.includes(normA));
}

/**
 * Helper to extract candidate judge JSON object from objects, results, judgments, or strings.
 */
function extractCandidateObject(raw: unknown): any {
  if (!raw) return null;

  // 1. Direct object inspection
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, any>;

    // Direct match if winProbHome / fairSpread exist on this object
    if ((obj.winProbHome !== undefined || obj.win_prob_home !== undefined) &&
        (obj.fairSpread !== undefined || obj.fair_spread !== undefined)) {
      return obj;
    }

    // Check obj.judgment
    if (obj.judgment && typeof obj.judgment === 'object') {
      const nested = extractCandidateObject(obj.judgment);
      if (nested) return nested;
    }

    // Check obj.result
    if (obj.result && typeof obj.result === 'object') {
      const nested = extractCandidateObject(obj.result);
      if (nested) return nested;
    }

    // Check obj.finalAnalysis
    if (obj.finalAnalysis && typeof obj.finalAnalysis === 'object') {
      const nested = extractCandidateObject(obj.finalAnalysis);
      if (nested) return nested;
    }

    // If components exist (e.g. Generative UI ManagerResponse)
    if (Array.isArray(obj.components)) {
      for (const comp of obj.components) {
        if (comp?.props) {
          if (Array.isArray(comp.props.insights)) {
            for (const ins of comp.props.insights) {
              const msg = typeof ins === 'string' ? ins : ins?.message;
              if (typeof msg === 'string') {
                const parsedFromMsg = extractCandidateFromString(msg);
                if (parsedFromMsg) return parsedFromMsg;
              }
            }
          }
          if (typeof comp.props.value === 'string') {
            const parsedVal = extractCandidateFromString(comp.props.value);
            if (parsedVal) return parsedVal;
          }
        }
      }
    }

    // Check obj.summary
    if (typeof obj.summary === 'string') {
      const parsedFromSummary = extractCandidateFromString(obj.summary);
      if (parsedFromSummary) return parsedFromSummary;
    }

    // If obj has string property judgment or result
    if (typeof obj.judgment === 'string') {
      const parsedStr = extractCandidateFromString(obj.judgment);
      if (parsedStr) return parsedStr;
    }
    if (typeof obj.result === 'string') {
      const parsedStr = extractCandidateFromString(obj.result);
      if (parsedStr) return parsedStr;
    }
    if (typeof obj.finalAnalysis === 'string') {
      const parsedStr = extractCandidateFromString(obj.finalAnalysis);
      if (parsedStr) return parsedStr;
    }
  }

  // 2. String inspection
  if (typeof raw === 'string') {
    return extractCandidateFromString(raw);
  }

  return null;
}

function extractCandidateFromString(str: string): any {
  if (!str || typeof str !== 'string') return null;

  // Check fenced code block ```json ... ```
  const fenced = str.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) {
    try {
      const parsed = JSON.parse(fenced[1]);
      if (parsed && typeof parsed === 'object') {
        const nested = extractCandidateObject(parsed);
        if (nested) return nested;
      }
    } catch {
      // continue
    }
  }

  // Direct JSON parse
  try {
    const direct = JSON.parse(str);
    if (direct && typeof direct === 'object') {
      const nested = extractCandidateObject(direct);
      if (nested) return nested;
    }
  } catch {
    // continue
  }

  // Match largest { ... } substring
  const bracketMatch = str.match(/\{[\s\S]*\}/);
  if (bracketMatch) {
    try {
      const parsed = JSON.parse(bracketMatch[0]);
      if (parsed && typeof parsed === 'object') {
        const nested = extractCandidateObject(parsed);
        if (nested) return nested;
      }
    } catch {
      // continue
    }
  }

  return null;
}

/**
 * Livetest 2026-10-24 bug 1: per-sport total ranges (same numbers as DuelOdds src/utils/meritVerdict.ts SPORT_TOTAL_SANITY_RANGES).
 */
export const JUDGE_TOTAL_RANGES: Record<string, { min: number; max: number }> = {
  americanfootball_nfl: { min: 30, max: 65 },
  americanfootball_ncaaf: { min: 30, max: 80 },
  basketball_nba: { min: 190, max: 260 },
  basketball_ncaab: { min: 110, max: 180 },
  basketball_wnba: { min: 130, max: 190 },
  baseball_mlb: { min: 5, max: 14 },
  baseball_ncaa: { min: 5, max: 18 },
  icehockey_nhl: { min: 4, max: 8 },
};

/** Max |fair - market| before a judgment is rejected (same caps as DuelOdds MODEL_DISAGREEMENT_CAPS). */
export const JUDGE_MARKET_CAPS = { spread: 10, total: 12 };

/** Posted market lines for the cross-check. spread is HOME perspective (negative = home favored), like fairSpread. */
export type JudgeMarketLines = { spread?: number | null; total?: number | null } | null | undefined;

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Cross-checks a judgment's fields against each other, the sport and the market.
 * Returns the reason it must be rejected, or null when it is coherent.
 * - sign(fairSpread) (home perspective) must agree with winProbHome (> 0.5 = home favored) and with an explicitly named winner;
 * - |fairSpread - market spread| <= 10;
 * - fairTotal (when given) inside the sport's range and |fairTotal - market total| <= 12.
 */
export function crossCheckJudgeOutput(
  judgment: { winProbHome: number; fairSpread: number; fairTotal: number | null; namedWinner: 'home' | 'away' | null },
  sportKey?: string,
  market?: JudgeMarketLines
): string | null {
  const { winProbHome, fairSpread, fairTotal, namedWinner } = judgment;
  if (winProbHome > 0.5 && fairSpread > 0) {
    return `fairSpread ${fairSpread} favors the away team but winProbHome is ${winProbHome}`;
  }
  if (winProbHome < 0.5 && fairSpread < 0) {
    return `fairSpread ${fairSpread} favors the home team but winProbHome is ${winProbHome}`;
  }
  if (namedWinner === 'home' && winProbHome < 0.5) {
    return `likelyWinner is the home team but winProbHome is ${winProbHome}`;
  }
  if (namedWinner === 'away' && winProbHome > 0.5) {
    return `likelyWinner is the away team but winProbHome is ${winProbHome}`;
  }
  const marketSpread = finiteOrNull(market?.spread);
  if (marketSpread !== null && Math.abs(fairSpread - marketSpread) > JUDGE_MARKET_CAPS.spread) {
    return `fairSpread ${fairSpread} is ${Math.abs(fairSpread - marketSpread)} from the market ${marketSpread} (cap ${JUDGE_MARKET_CAPS.spread})`;
  }
  if (fairTotal !== null) {
    const range = sportKey ? JUDGE_TOTAL_RANGES[sportKey.toLowerCase().trim()] : undefined;
    if (range && (fairTotal < range.min || fairTotal > range.max)) {
      return `fairTotal ${fairTotal} is outside the ${sportKey} range ${range.min}-${range.max}`;
    }
    const marketTotal = finiteOrNull(market?.total);
    if (marketTotal !== null && Math.abs(fairTotal - marketTotal) > JUDGE_MARKET_CAPS.total) {
      return `fairTotal ${fairTotal} is ${Math.abs(fairTotal - marketTotal)} from the market ${marketTotal} (cap ${JUDGE_MARKET_CAPS.total})`;
    }
  }
  return null;
}

/**
 * Safely parses and validates the judge output from the Swarm analysis.
 * Strict validation: never defaults missing probabilities or fair spread to 50%/0.
 */
export function parseAndValidateJudgeOutput(
  rawResponse: unknown,
  homeTeam: string,
  awayTeam: string,
  sportKey?: string,
  swarmWorkflowId?: string | null,
  market?: JudgeMarketLines
): MorningJudgeOutput | null {
  if (!rawResponse) return null;

  const parsed = extractCandidateObject(rawResponse);
  if (!parsed || typeof parsed !== 'object') return null;

  // 1. Validate winProbHome: must be present, number, within 0.01 - 0.99
  const rawWinProbHome = parsed.winProbHome ?? parsed.win_prob_home;
  if (rawWinProbHome === undefined || rawWinProbHome === null || rawWinProbHome === '') {
    return null;
  }
  const winProbHomeNum = typeof rawWinProbHome === 'number' ? rawWinProbHome : Number(rawWinProbHome);
  if (!Number.isFinite(winProbHomeNum) || isNaN(winProbHomeNum) || winProbHomeNum < 0.01 || winProbHomeNum > 0.99) {
    return null;
  }

  // 2. Validate fairSpread: must be present, valid finite number
  const rawFairSpread = parsed.fairSpread ?? parsed.fair_spread;
  if (rawFairSpread === undefined || rawFairSpread === null || rawFairSpread === '') {
    return null;
  }
  const fairSpreadNum = typeof rawFairSpread === 'number' ? rawFairSpread : Number(rawFairSpread);
  if (!Number.isFinite(fairSpreadNum) || isNaN(fairSpreadNum)) {
    return null;
  }

  // Win probability normalization & clamping
  let winProbAway = Number(parsed.winProbAway ?? parsed.win_prob_away);
  if (isNaN(winProbAway) || winProbAway <= 0 || winProbAway >= 1) {
    winProbAway = 1 - winProbHomeNum;
  }
  const sum = winProbHomeNum + winProbAway;
  const winProbHome = Math.round((winProbHomeNum / sum) * 1000) / 1000;
  const finalWinProbAway = Math.round((1 - winProbHome) * 1000) / 1000;

  const normHome = homeTeam.trim();
  const normAway = awayTeam.trim();

  // Likely Winner
  let likelyWinner = String(parsed.likelyWinner || parsed.winner || parsed.likely_winner || '').trim();
  let namedWinner: 'home' | 'away' | null = null;
  if (areTeamsEqual(likelyWinner, normHome)) {
    likelyWinner = normHome;
    namedWinner = 'home';
  } else if (areTeamsEqual(likelyWinner, normAway)) {
    likelyWinner = normAway;
    namedWinner = 'away';
  } else {
    // Names neither team (e.g. a verdict copied from another game): keep the probability-based pick, but say so.
    if (likelyWinner) {
      console.warn(`[MorningJudge] likelyWinner "${likelyWinner}" matches neither ${normAway} nor ${normHome}; using the winProbHome side instead.`);
    }
    likelyWinner = winProbHome >= 0.5 ? normHome : normAway;
  }

  // Fair total: null when absent or not a number (the prompt allows null); a numeric total must be > 0 and
  // inside the sport's range (cross-check below), so 135.5 for NCAAF is rejected instead of accepted as "> 0".
  let fairTotal: number | null = null;
  const rawTotal = parsed.fairTotal ?? parsed.fair_total;
  const totalNum = rawTotal == null || rawTotal === "" ? NaN : Number(rawTotal);
  if (Number.isFinite(totalNum)) {
    if (totalNum <= 0) {
      console.warn(
        `[MorningJudge] Rejected judgment for ${normAway} @ ${normHome}: fairTotal ${totalNum} is not positive`,
      );
      return null;
    }
    fairTotal = totalNum;
  }

  // Livetest 2026-10-24 bug 1: cross-check spread / win probability / winner / totals before anything is written
  const rejection = crossCheckJudgeOutput(
    { winProbHome, fairSpread: fairSpreadNum, fairTotal, namedWinner },
    sportKey,
    market,
  );
  if (rejection) {
    console.warn(
      `[MorningJudge] Rejected judgment for ${normAway} @ ${normHome}: ${rejection}`,
    );
    return null;
  }

  // Total lean
  let totalLean: 'over' | 'under' | 'none' = 'none';
  const rawLean = String(parsed.totalLean || parsed.total_lean || '').toLowerCase().trim();
  if (rawLean === 'over' || rawLean === 'under') totalLean = rawLean;

  // Arguments
  const args: MorningArgument[] = [];
  if (Array.isArray(parsed.arguments)) {
    for (const a of parsed.arguments) {
      if (a && typeof a === 'object' && a.claim) {
        args.push({
          claim: String(a.claim).trim(),
          advocate: ['quant', 'market', 'critic', 'judge'].includes(a.advocate) ? a.advocate : 'judge',
          weight: ['high', 'medium', 'low'].includes(a.weight) ? a.weight : 'medium',
          supportingData: a.supportingData ? String(a.supportingData).trim() : undefined
        });
      }
    }
  }

  // Invalidation conditions
  const invalidationConditions: string[] = [];
  const rawInvalidations = parsed.invalidationConditions || parsed.invalidation_conditions;
  if (Array.isArray(rawInvalidations)) {
    for (const c of rawInvalidations) {
      if (typeof c === 'string' && c.trim()) {
        invalidationConditions.push(c.trim());
      }
    }
  }

  const rawDataAsOf = parsed.dataAsOf || parsed.data_as_of;
  const dataAsOf = rawDataAsOf && !isNaN(new Date(rawDataAsOf).getTime())
    ? new Date(rawDataAsOf).toISOString()
    : new Date().toISOString();

  let workflowId: string | null = null;
  if (typeof swarmWorkflowId === 'string' && swarmWorkflowId.trim() && !swarmWorkflowId.trim().startsWith('wf-judgment-')) {
    workflowId = swarmWorkflowId.trim();
  }

  return {
    likelyWinner,
    winProbHome,
    winProbAway: finalWinProbAway,
    fairSpread: fairSpreadNum,
    fairTotal,
    totalLean,
    arguments: args,
    invalidationConditions,
    dataAsOf,
    workflowId,
    isExplicit: true
  };
}

/**
 * Computes model snapshot metrics for game_judgments, including participating Swarm seats
 * and argument advocate breakdown for per-seat Brier and accuracy attribution.
 */
export function computeModelSnapshot(
  game: SlateGame,
  winProbHome: number = 0.5,
  judgment?: MorningJudgeOutput | null,
  participatingSeats?: string[]
): Record<string, any> {
  const spread = game.oddsSnapshot?.spread ?? null;
  const total = game.oddsSnapshot?.overUnder ?? null;

  const advocateCounts: Record<string, number> = {};
  if (judgment?.arguments && Array.isArray(judgment.arguments)) {
    for (const arg of judgment.arguments) {
      const adv = arg.advocate || 'judge';
      advocateCounts[adv] = (advocateCounts[adv] || 0) + 1;
    }
  }

  return {
    model_win_prob_home: winProbHome,
    projected_margin: spread != null ? -spread : (winProbHome >= 0.5 ? 3.5 : -3.5),
    projected_total: total ?? 44.5,
    derived_from: 'swarm_analysis_composite',
    ...(Array.isArray(participatingSeats) && participatingSeats.length > 0
      ? { participating_seats: participatingSeats }
      : {}),
    ...(Object.keys(advocateCounts).length > 0
      ? { advocate_breakdown: advocateCounts }
      : {})
  };
}

/**
 * Judgment v2 parse (rule a) + validate (rules b, c). Replaces parseAndValidateJudgeOutput + crossCheckJudgeOutput
 * when JUDGMENT_SCHEMA_V2 is on. A rejection logs one warning and returns { ok: false }; nothing is retried in-run.
 */
export function parseAndValidateJudgeOutputV2(raw: unknown, game: SlateGame): JudgmentV2Result {
  const market = { spread: game.oddsSnapshot?.spread ?? null, total: game.oddsSnapshot?.overUnder ?? null };
  // side (ATS cover vs the home spread) and totalLean are derived from the numbers; a label mismatch is logged, not rejected.
  const r = parseDeriveAndValidateJudgmentV2(raw, { eventId: game.eventId, sport: game.sport }, market);
  if (r.ok === false) {
    const f = r as { reason: string; detail: string };
    console.warn(`[MorningJudge] Rejected v2 judgment for ${game.awayTeam} @ ${game.homeTeam}: ${f.reason}: ${f.detail}`);
    return r;
  }
  const j = (r as { judgment: JudgmentV2 }).judgment;
  if (r.sideBasis === 'margin_fallback') {
    console.warn('[MorningJudge] v2 side from margin sign (no market spread)', JSON.stringify({
      eventId: game.eventId,
      sport: game.sport,
      matchup: `${game.awayTeam} @ ${game.homeTeam}`,
      projMargin: j.projMargin,
      side: j.side
    }));
  }
  for (const c of r.corrections ?? []) {
    console.warn('[MorningJudge] v2 label corrected', JSON.stringify({
      eventId: game.eventId,
      sport: game.sport,
      matchup: `${game.awayTeam} @ ${game.homeTeam}`,
      field: c.field,
      model: c.model,
      derived: c.derived,
      projMargin: j.projMargin,
      projTotal: j.projTotal,
      marketSpread: market.spread,
      marketTotal: market.total
    }));
  }
  return { ok: true, judgment: j };
}

/**
 * Judgment v2 model snapshot: the judge's own projections, no hardcoded 3.5 / 44.5 fallbacks and no
 * model_win_prob_home (DuelOdds derives win_prob_home_code from proj_margin).
 */
export function computeModelSnapshotV2(judgment: JudgmentV2, participatingSeats?: string[]): Record<string, any> {
  return {
    projected_margin: judgment.projMargin,
    projected_total: judgment.projTotal,
    derived_from: 'swarm_judgment_v2',
    ...(Array.isArray(participatingSeats) && participatingSeats.length > 0
      ? { participating_seats: participatingSeats }
      : {})
  };
}

