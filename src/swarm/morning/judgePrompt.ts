import type { MorningArgument, MorningJudgeOutput, SlateGame } from './types.ts';

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
  "fairTotal": 215.5,
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
3. "fairTotal": Must be a realistic game total appropriate to this sport (e.g. NFL: 30-65, NBA: 190-260, MLB: 5-14, NHL: 4-8) or null if unable to estimate.
4. "totalLean": Must be strictly "over", "under", or "none".
5. "likelyWinner": Must strictly equal "${game.homeTeam}" or "${game.awayTeam}".
6. Do NOT output any explanatory text before or after the JSON.`;
}

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
 * Safely parses and validates the judge output from the Swarm analysis.
 */
export function parseAndValidateJudgeOutput(
  rawResponse: string,
  homeTeam: string,
  awayTeam: string,
  sportKey?: string,
  swarmWorkflowId?: string | null
): MorningJudgeOutput | null {
  if (!rawResponse || typeof rawResponse !== 'string') return null;

  let parsed: any = null;
  try {
    parsed = JSON.parse(rawResponse);
  } catch {
    const match = rawResponse.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object') return null;

  const normHome = homeTeam.trim();
  const normAway = awayTeam.trim();

  // Likely Winner
  let likelyWinner = String(parsed.likelyWinner || parsed.winner || '').trim();
  if (areTeamsEqual(likelyWinner, normHome)) {
    likelyWinner = normHome;
  } else if (areTeamsEqual(likelyWinner, normAway)) {
    likelyWinner = normAway;
  } else {
    const homeP = Number(parsed.winProbHome ?? 0.5);
    likelyWinner = homeP >= 0.5 ? normHome : normAway;
  }

  // Win probabilities
  let winProbHome = Number(parsed.winProbHome);
  let winProbAway = Number(parsed.winProbAway);
  if (isNaN(winProbHome) || winProbHome <= 0) winProbHome = 0.5;
  if (isNaN(winProbAway) || winProbAway <= 0) winProbAway = 1 - winProbHome;

  winProbHome = Math.min(0.99, Math.max(0.01, winProbHome));
  winProbAway = Math.min(0.99, Math.max(0.01, winProbAway));
  const sum = winProbHome + winProbAway;
  winProbHome = Math.round((winProbHome / sum) * 1000) / 1000;
  winProbAway = Math.round((1 - winProbHome) * 1000) / 1000;

  // Fair spread
  let fairSpread = Number(parsed.fairSpread);
  if (isNaN(fairSpread)) fairSpread = 0;

  // Fair total
  let fairTotal: number | null = null;
  if (parsed.fairTotal != null && !isNaN(Number(parsed.fairTotal)) && Number(parsed.fairTotal) > 0) {
    fairTotal = Number(parsed.fairTotal);
  }

  // Total lean
  let totalLean: 'over' | 'under' | 'none' = 'none';
  const rawLean = String(parsed.totalLean || '').toLowerCase().trim();
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
  if (Array.isArray(parsed.invalidationConditions)) {
    for (const c of parsed.invalidationConditions) {
      if (typeof c === 'string' && c.trim()) {
        invalidationConditions.push(c.trim());
      }
    }
  }

  const dataAsOf = parsed.dataAsOf && !isNaN(new Date(parsed.dataAsOf).getTime())
    ? new Date(parsed.dataAsOf).toISOString()
    : new Date().toISOString();

  let workflowId: string | null = null;
  if (typeof swarmWorkflowId === 'string' && swarmWorkflowId.trim() && !swarmWorkflowId.trim().startsWith('wf-judgment-')) {
    workflowId = swarmWorkflowId.trim();
  }

  return {
    likelyWinner,
    winProbHome,
    winProbAway,
    fairSpread,
    fairTotal,
    totalLean,
    arguments: args,
    invalidationConditions,
    dataAsOf,
    workflowId
  };
}

/**
 * Computes model snapshot metrics for game_judgments.
 */
export function computeModelSnapshot(game: SlateGame, winProbHome: number = 0.5): Record<string, any> {
  const spread = game.oddsSnapshot?.spread ?? null;
  const total = game.oddsSnapshot?.overUnder ?? null;

  return {
    model_win_prob_home: winProbHome,
    projected_margin: spread != null ? -spread : (winProbHome >= 0.5 ? 3.5 : -3.5),
    projected_total: total ?? 44.5,
    derived_from: 'swarm_analysis_composite'
  };
}
