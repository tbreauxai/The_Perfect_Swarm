import { parseGameHeaders, getEventIdForPick, type GameHeader } from '../context/gameHeaders.ts';
import {
  ESPN_TEAMS,
  extractAuthoritativeInjuries,
  matchTeamByLabel,
  normalizeSportHint,
  type AuthoritativeInjury,
  type EspnTeamEntry
} from './injuryAttribution.ts';
import { extractRowOptions, type RowOptionEntry } from './marketRowBinding.ts';

export const GROUNDING_RULE = `GROUNDING:
- Do not cite a score, goals-allowed, or health claim unless it is in a successful tool result.
- If key players on that team are OUT, do not call the team relatively healthy.
- A vetoed leg is removed from picks. Do not rewrite it as a recommended single bet.`;

export const VETO_STICKS_RULE = `VETO STICKS:
- A Critic veto for ungrounded form, missing market, or fatal injury removes that leg.
- Do not repeat the vetoed claim in a later attempt or in the final analysis.
- Do not put a vetoed leg back into picks.
- If every leg is vetoed, the result is a pass.`;

export interface GroundingAuditResult {
  pass: boolean;
  violations: string[];
  flags: string[];
  feedback?: string;
  vetoedLegs?: VetoedLegTarget[];
  vetoedClaims?: string[];
}

export interface VetoedLegTarget {
  rowId?: string;
  eventId?: string;
  teamLabel?: string;
  teamAliases: string[];
  reason: string;
}

interface TeamDescriptor {
  key: string;
  label: string;
  abbr?: string;
  nameAliases: string[];
  abbrAliases: string[];
  allAliases: string[];
  eventIds: string[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value: string): string {
  return value.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-');
}

/**
 * Keeps only successful tool output lines, stripping error/timeout/not-fetched lines.
 */
export function extractSuccessfulEvidenceText(rawEvidence: string): string {
  if (!rawEvidence || typeof rawEvidence !== 'string') return '';
  const failedLineRegex =
    /^\s*(?:\[[^\]]+\]:?\s*)?Error(?:\s+fetching\b[^:\n]*)?:|^\s*\[Not Fetched\]:|^\s*\[TOOL_(?:ERROR|TIMEOUT):|\b(?:rpc_failed(?:_\d+)?|rpc_network_error|supabase_not_configured|invalid_game_id|unresolved_game_id|tool_error|status=failed|success\s*:\s*false|"success"\s*:\s*false)\b|\[tool evidence omitted:\s*over budget\]/i;
  const kept: string[] = [];
  for (const rawLine of rawEvidence.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (failedLineRegex.test(line)) continue;
    const cleaned = line
      .replace(/\|\s*\[Not Fetched\]:.*$/i, '')
      .replace(/\|\s*Error(?:\s+fetching\b[^:\n]*)?:.*$/i, '')
      .trim();
    if (cleaned) kept.push(cleaned);
  }
  return kept.join('\n');
}

function buildCleanEvidenceForNumericCheck(successfulEvidence: string): string {
  if (!successfulEvidence) return '';
  return normalizeText(successfulEvidence)
    .replace(/event_id\s*=\s*[a-z0-9-]+/gi, ' ')
    .replace(/\b(?:nhl|nba|nfl|mlb|ncaab|ncaaf|wnba|epl|mls)-[a-z0-9-]+\b/gi, ' ')
    .replace(/\bR\d+\b/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?\b/g, ' ')
    .replace(/\b(?:W-L|L5|L10|L20|record|ATS)\s*:?\s*\d{1,3}\s*-\s*\d{1,3}(?:\s*-\s*\d{1,3})?\b/gi, ' ')
    .replace(/\b\d{1,3}\s*-\s*\d{1,3}(?:\s*-\s*\d{1,3})?\s*(?:L\d+|ATS|SU|record|last\s+\d+)\b/gi, ' ')
    .replace(/\bTotal\s*:\s*\d+(?:\.\d+)?\b/gi, ' ')
    .replace(/\(\s*[+-]\d{3,4}\s*\)/g, ' ')
    .replace(/\b(?:ml_home|ml_away)\s*(?:[:=]\s*|[A-Za-z.\s]{0,25}?)[+-]\d{3,4}\b/gi, ' ')
    .replace(/\b(?:spread|puckline|runline)\s*(?:[:=]?\s*[A-Za-z.\s]{0,20})?[+-]\d+(?:\.\d+)?\b/gi, ' ')
    .replace(/\b(?:team_id|player_id|game_id)\s*[:=]\s*["']?\d+["']?\b/gi, ' ')
    .replace(/\bconf(?:idence)?\s*:?\s*\d+(?:\.\d+)?%?\b/gi, ' ');
}

const STAT_CONTEXT_KEYWORD_REGEX =
  /(?:^|[^a-zA-Z0-9])(?:goals?|points?|pts|runs?|allowed|against|conceded|surrendered|scored|scoring|pf\/pa|pf|pa|ga|gf|ra|rf|gaa|ga\/g|ppg|oppg|opp_pts|last_game|score|team_score|opponent_score|home_score|away_score|h2h|boxscore|recent_scores)(?:$|[^a-zA-Z0-9])/i;

function isNumericStatGrounded(valueStr: string, cleanEvidence: string): boolean {
  if (!cleanEvidence) return false;
  const escapedVal = escapeRegex(valueStr);
  const tokenRegex = new RegExp(`(?<![\\d.])${escapedVal}(?![\\d.])`, 'g');
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(cleanEvidence)) !== null) {
    const start = Math.max(0, m.index - 45);
    const end = Math.min(cleanEvidence.length, m.index + valueStr.length + 45);
    const window = cleanEvidence.slice(start, end);
    if (STAT_CONTEXT_KEYWORD_REGEX.test(window)) {
      return true;
    }
  }

  // Remaining score pairs (e.g. H2H: ANA vs COL 2-8 (L) — W-L records were stripped)
  const scorePairRegex = /\b(\d{1,3})\s*-\s*(\d{1,3})\b/g;
  while ((m = scorePairRegex.exec(cleanEvidence)) !== null) {
    if (m[1] === valueStr || m[2] === valueStr) return true;
  }

  // Slash average pairs (e.g. PF/PA 2.2 / 3.9)
  const slashPairRegex = /\b(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\b/g;
  while ((m = slashPairRegex.exec(cleanEvidence)) !== null) {
    if (m[1] === valueStr || m[2] === valueStr) return true;
  }

  return false;
}

function isScorePairGrounded(scoreA: string, scoreB: string, cleanEvidence: string): boolean {
  if (!cleanEvidence) return false;
  const aEsc = escapeRegex(scoreA);
  const bEsc = escapeRegex(scoreB);
  const directPair = new RegExp(`\\b(?:${aEsc}\\s*-\\s*${bEsc}|${bEsc}\\s*-\\s*${aEsc})\\b`);
  if (directPair.test(cleanEvidence)) return true;

  const jsonPair = new RegExp(
    `(?:team_score|home_score)["']?\\s*[:=]\\s*${aEsc}[^\\n}]{0,60}(?:opponent_score|away_score)["']?\\s*[:=]\\s*${bEsc}|` +
      `(?:team_score|home_score)["']?\\s*[:=]\\s*${bEsc}[^\\n}]{0,60}(?:opponent_score|away_score)["']?\\s*[:=]\\s*${aEsc}`,
    'i'
  );
  return jsonPair.test(cleanEvidence);
}

interface GroundedRecordSet {
  allRecords: Set<string>;
  recordsByTeamKey: Map<string, Set<string>>;
}

function addGroundedRecordValue(
  targetSet: Set<string>,
  wStr: string | number,
  lStr: string | number,
  otlStr?: string | number
): void {
  const w = String(wStr).trim();
  const l = String(lStr).trim();
  if (!w || !l) return;
  targetSet.add(`${w}-${l}`);
  if (otlStr !== undefined && otlStr !== null && String(otlStr).trim() !== '') {
    const otl = String(otlStr).trim();
    targetSet.add(`${w}-${l}-${otl}`);
    const lNum = parseInt(l, 10);
    const otlNum = parseInt(otl, 10);
    if (Number.isFinite(lNum) && Number.isFinite(otlNum) && otlNum > 0) {
      targetSet.add(`${w}-${lNum + otlNum}`);
    }
  }
}

function extractRecordsFromSegment(seg: string): Set<string> {
  const records = new Set<string>();
  if (!seg) return records;
  const norm = normalizeText(seg);

  const prefixRx =
    /\b(?:W-L|L\d{1,2}|last[\s_]?\d{1,2}|record|ATS|SU|home|away|road|overall|form)\b["']?\s*[:="']?\s*(\d{1,3})\s*-\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?\b/gi;
  let m: RegExpExecArray | null;
  while ((m = prefixRx.exec(norm)) !== null) {
    addGroundedRecordValue(records, m[1], m[2], m[3]);
  }

  const suffixRx =
    /\b(\d{1,3})\s*-\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?\s*(?:L\d{1,2}|W-L|ATS|SU|record|last\s+\d+)\b/gi;
  while ((m = suffixRx.exec(norm)) !== null) {
    addGroundedRecordValue(records, m[1], m[2], m[3]);
  }

  const jsonWinsFirstRx =
    /"wins"\s*:\s*(\d{1,3})[^}]{0,80}?"losses"\s*:\s*(\d{1,3})(?:[^}]{0,50}?"(?:otl|ties|ot_losses)"\s*:\s*(\d{1,3}))?/gi;
  while ((m = jsonWinsFirstRx.exec(norm)) !== null) {
    addGroundedRecordValue(records, m[1], m[2], m[3]);
  }

  const jsonLossesFirstRx =
    /"losses"\s*:\s*(\d{1,3})[^}]{0,80}?"wins"\s*:\s*(\d{1,3})/gi;
  while ((m = jsonLossesFirstRx.exec(norm)) !== null) {
    addGroundedRecordValue(records, m[2], m[1]);
  }

  const jsonRecordStrRx =
    /"(?:l\d{1,2}|last_?\d{1,2}|record|wl|w_l)"\s*:\s*"(\d{1,3})\s*-\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?"/gi;
  while ((m = jsonRecordStrRx.exec(norm)) !== null) {
    addGroundedRecordValue(records, m[1], m[2], m[3]);
  }

  const recentRx =
    /(?:\b(?:Recent|team_games(?:\s+last[\s_]?\d{1,2})?|last[\s_]?\d{1,2})\s*:?\s*([WLOT](?:\s*[,/\s-]\s*(?:OTL|OT|[WLT]))+)|"recent_results"\s*:\s*\[([^\]]+)\])/gi;
  while ((m = recentRx.exec(norm)) !== null) {
    const rawSeq = m[1] || m[2] || '';
    const tokens = rawSeq.match(/\b(?:OTL|OT|[WLT])\b/gi);
    if (!tokens || tokens.length === 0) continue;
    const tally = (slice: string[]) => {
      let w = 0;
      let l = 0;
      let otl = 0;
      for (const tok of slice) {
        const up = tok.toUpperCase();
        if (up === 'W') w++;
        else if (up === 'L') l++;
        else otl++;
      }
      addGroundedRecordValue(records, w, l, otl > 0 ? otl : undefined);
    };
    tally(tokens);
    if (tokens.length >= 5) {
      tally(tokens.slice(0, 5));
      tally(tokens.slice(-5));
    }
  }

  return records;
}

function extractGroundedRecords(
  successfulEvidence: string,
  candidates: TeamDescriptor[]
): GroundedRecordSet {
  const allRecords = new Set<string>();
  const recordsByTeamKey = new Map<string, Set<string>>();
  if (!successfulEvidence) return { allRecords, recordsByTeamKey };

  const bindRecords = (seg: string, teamKeys: string[]) => {
    const recs = extractRecordsFromSegment(seg);
    if (recs.size === 0) return;
    for (const r of recs) allRecords.add(r);
    if (teamKeys.length === 1) {
      const k = teamKeys[0];
      let set = recordsByTeamKey.get(k);
      if (!set) {
        set = new Set<string>();
        recordsByTeamKey.set(k, set);
      }
      for (const r of recs) set.add(r);
    }
  };

  for (const rawLine of successfulEvidence.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // Split multi-team lines on "Home (" / "Away (" boundaries first
    const segments = line.split(/(?=\b(?:Home|Away)\s*\()/i);
    for (const seg of segments) {
      // Also check for team-keyed JSON blocks inside snapshot Form lines
      const jsonTeamBlockRx = /"([A-Za-z0-9_.\s-]{2,30})"\s*:\s*\{/g;
      let jm: RegExpExecArray | null;
      const jsonTeamStarts: Array<{ index: number; key: string }> = [];
      while ((jm = jsonTeamBlockRx.exec(seg)) !== null) {
        const keyMentions = findTeamMentionsInText(jm[1], candidates);
        if (keyMentions.length === 1) {
          jsonTeamStarts.push({ index: jm.index, key: keyMentions[0].team.key });
        }
      }

      if (jsonTeamStarts.length >= 2) {
        for (let i = 0; i < jsonTeamStarts.length; i++) {
          const start = jsonTeamStarts[i].index;
          const end = i + 1 < jsonTeamStarts.length ? jsonTeamStarts[i + 1].index : seg.length;
          bindRecords(seg.slice(start, end), [jsonTeamStarts[i].key]);
        }
        continue;
      }

      const mentions = findTeamMentionsInText(seg, candidates);
      const uniqueKeys = Array.from(new Set(mentions.map(m => m.team.key)));
      bindRecords(seg, uniqueKeys);
    }
  }

  return { allRecords, recordsByTeamKey };
}

function findNearestTeamForSpan(
  clause: string,
  matchStart: number,
  matchEnd: number,
  candidates: TeamDescriptor[],
  sideHint?: string
): TeamDescriptor | undefined {
  if (candidates.length === 0) return undefined;
  const mentions = findTeamMentionsInText(clause, candidates);
  if (mentions.length > 0) {
    const preceding = mentions.filter(m => m.end <= matchStart);
    if (preceding.length > 0) {
      preceding.sort((a, b) => (matchStart - a.end) - (matchStart - b.end));
      return preceding[0].team;
    }
    const following = mentions.filter(m => m.start >= matchEnd);
    if (following.length > 0) {
      following.sort((a, b) => (a.start - matchEnd) - (b.start - matchEnd));
      return following[0].team;
    }
  }
  if (sideHint) {
    const hintMentions = findTeamMentionsInText(sideHint, candidates);
    if (hintMentions.length > 0) return hintMentions[0].team;
  }
  return undefined;
}

function isRecordGrounded(
  w: string,
  l: string,
  otl: string | undefined,
  team: TeamDescriptor | undefined,
  groundedRecords?: GroundedRecordSet
): boolean {
  if (!groundedRecords) return false;
  const fullKey = otl ? `${w}-${l}-${otl}` : `${w}-${l}`;
  const shortKey = `${w}-${l}`;

  if (team) {
    const teamSet = groundedRecords.recordsByTeamKey.get(team.key);
    if (teamSet && teamSet.size > 0) {
      return teamSet.has(fullKey) || (!otl && teamSet.has(shortKey));
    }
  }

  return groundedRecords.allRecords.has(fullKey) || (!otl && groundedRecords.allRecords.has(shortKey));
}

interface FormClaimDetail {
  reason: string;
  claimTexts: string[];
}

function findUngroundedFormClaimDetailInClause(
  clause: string,
  cleanEvidence: string,
  groundedRecords?: GroundedRecordSet,
  candidates: TeamDescriptor[] = [],
  hasSportsSignal: boolean = false,
  sideHint?: string
): FormClaimDetail | null {
  if (!clause || typeof clause !== 'string') return null;
  const norm = normalizeText(clause);

  const numberPatterns: RegExp[] = [
    /\b(\d+(?:\.\d+)?)\s+(?:goals?|points?|pts|runs?)\s+(?:allowed|against|conceded|surrendered|given\s+up)\b/gi,
    /\b(?:allowed|allowing|allows|gave\s+up|giving\s+up|gives\s+up|surrendered|surrendering|surrenders|conceded|conceding|concedes|yielded|yielding|yields)\s+(\d+(?:\.\d+)?)\s+(?:goals?|points?|pts|runs?)\b/gi,
    /\b(?:scored|scoring|scores|netted|tallied|put\s+up|posted|held\s+to)\s+(\d+(?:\.\d+)?)\s+(?:goals?|points?|pts|runs?)\b/gi,
    /\b(\d+(?:\.\d+)?)\s+(?:goals?|points?|pts|runs?)\s+(?:per\s+game|last\s+game|last\s+night|last\s+outing)\b/gi,
    /\b(\d+(?:\.\d+)?)\s+(?:GAA|GA\/G|goals\s+against\s+avg)\b/gi
  ];

  for (const rx of numberPatterns) {
    rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(norm)) !== null) {
      const val = m[1];
      if (!isNumericStatGrounded(val, cleanEvidence)) {
        const phrase = m[0].trim();
        return {
          reason: `Ungrounded form/score claim ("${phrase}") not found in a successful tool result.`,
          claimTexts: [phrase]
        };
      }
    }
  }

  const scorePatterns: RegExp[] = [
    /\b(?:(?:lost|fell|dropped(?:\s+a)?|won|shut\s*out|beat|defeated)(?:\s+(?:(?:(?:to|against|vs\.?)\s+)?[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,2}|at\s+home|on\s+the\s+road|in\s+(?:OT|overtime)))?|final(?:\s+score)?|score(?:d)?\s+of)\s+(?:by\s+)?(\d{1,3})\s*-\s*(\d{1,3})\b/gi,
    /\b(\d{1,3})\s*-\s*(\d{1,3})\s+(?:loss(?!es)|win(?!s|\s+streak)|defeat|victory|blowout|rout|shutout|decision|final)\b/gi
  ];

  for (const rx of scorePatterns) {
    rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(norm)) !== null) {
      if (!isScorePairGrounded(m[1], m[2], cleanEvidence)) {
        const phrase = m[0].trim();
        return {
          reason: `Ungrounded score claim ("${phrase}") not found in a successful tool result.`,
          claimTexts: [phrase]
        };
      }
    }
  }

  const recordPatterns: RegExp[] = [
    /\b(\d{1,3})\s*-\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?\s*(?:(?:in\s+(?:their\s+|the\s+)?|over\s+(?:their\s+|the\s+)?)?(?:last|past)\s+\d+|(?:in\s+)?L(?:3|5|7|10|15|20)\b|W-L\b|ATS\b|SU\b|overall\b|record\b|on\s+the\s+(?:season|year|road)\b|at\s+home\b|form\b)/gi,
    /\b(?:L(?:3|5|7|10|15|20)|(?:last|past)\s+(?:3|5|7|10|15|20)|W-L|record(?:\s+of)?|ATS(?:\s+record)?|recent\s+form|form(?:\s+of)?)\s*(?::|=|is|at|of)?\s*(\d{1,3})\s*-\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?\b/gi
  ];
  if (hasSportsSignal) {
    recordPatterns.push(
      /\b(?:went|gone|going|sits(?:\s+at)?|stands(?:\s+at)?)\s+(\d{1,3})\s*-\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?(?![\s-]*(?:leg|legs|game|games|unit|units|pt|pts|point|points|goal|goals|run|runs|pick|picks|seat|seats|day|days|%))/gi
    );
  }

  for (const rx of recordPatterns) {
    rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(norm)) !== null) {
      const targetTeam = findNearestTeamForSpan(norm, m.index, m.index + m[0].length, candidates, sideHint);
      if (!isRecordGrounded(m[1], m[2], m[3], targetTeam, groundedRecords)) {
        const phrase = m[0].trim();
        const claims = [phrase];
        if (m[3]) {
          claims.push(`${m[1]}-${m[2]}-${m[3]}`);
        }
        return {
          reason: `Ungrounded record/form claim ("${phrase}") not found in a successful tool result.`,
          claimTexts: claims
        };
      }
    }
  }

  return null;
}

/**
 * Checks a single clause for ungrounded score / goals-allowed / points-allowed / runs-allowed / W-L record claims.
 */
function findUngroundedFormClaimInClause(
  clause: string,
  cleanEvidence: string,
  groundedRecords?: GroundedRecordSet,
  candidates: TeamDescriptor[] = [],
  hasSportsSignal: boolean = false,
  sideHint?: string
): string | null {
  return (
    findUngroundedFormClaimDetailInClause(
      clause,
      cleanEvidence,
      groundedRecords,
      candidates,
      hasSportsSignal,
      sideHint
    )?.reason ?? null
  );
}

const POSITIVE_HEALTH_CLAIM_REGEX =
  /\b(?:(?:relatively|mostly|largely|fairly|pretty|generally|completely|fully|entirely|remarkably|notably|comparatively)\s+healthy|healthy\s+at\s+(?:forward|forwards|defense|defensemen|guard|guards|wing|wings|center|goalie|goaltending|offense|backcourt|frontcourt|lineup|roster|skill\s+positions)|healthy\s+(?:roster|lineup|core|rotation|forward\s+group|forwards|defense|backcourt|frontcourt|starting\s+five|starting\s+lineup)|clean\s+bill\s+of\s+health|at\s+full\s+strength|full\s+health|injury[- ]free|no\s+(?:major|significant|key|notable)\s+injuries|intact\s+(?:roster|lineup|forward\s+group|core))\b/gi;

const NEGATED_OR_POLICY_HEALTH_PREFIX_REGEX =
  /\b(?:not|never|hardly|barely|far\s+from|isn't|aren't|is\s+not|are\s+not|no\s+longer|do\s+not\s+call|don't\s+call|cannot\s+be\s+called|can't\s+be\s+called)\b[^.;,]{0,30}$/i;

const SPORTS_CONTEXT_REGEX =
  /\b(?:forward|forwards|defense|defensemen|guard|guards|wing|wings|center|goalie|goaltending|netminder|qb|quarterback|backcourt|frontcourt|roster|lineup|starting\s+five|injur(?:y|ies|ed)|matchup|slate|parlay|moneyline|puckline|spread|nhl|nba|nfl|mlb|team|teams|game|games|bet|bets|leg|legs|pick|picks)\b/i;

function descriptorFromEntry(entry: EspnTeamEntry, eventIds: string[] = []): TeamDescriptor {
  const nameAliases = Array.from(
    new Set(
      [
        entry.name.toLowerCase(),
        entry.city.toLowerCase(),
        entry.nickname.toLowerCase(),
        ...entry.aliases.filter(a => a.length >= 4)
      ].filter(Boolean)
    )
  );
  const abbrAliases = Array.from(new Set([entry.abbr.toUpperCase()].filter(Boolean)));
  return {
    key: `${entry.sport}:${entry.abbr}`.toLowerCase(),
    label: `${entry.name} (${entry.abbr})`,
    abbr: entry.abbr,
    nameAliases,
    abbrAliases,
    allAliases: Array.from(new Set([...nameAliases, entry.abbr.toLowerCase()])),
    eventIds
  };
}

function descriptorFromLabel(rawLabel: string, sportHint?: string, eventIds: string[] = []): TeamDescriptor | null {
  const clean = rawLabel.trim();
  if (!clean || /^(away|home|unknown|tbd)$/i.test(clean)) return null;
  const entry = matchTeamByLabel(clean, sportHint);
  if (entry) return descriptorFromEntry(entry, eventIds);
  const lower = clean.toLowerCase();
  const nameAliases = Array.from(new Set([lower, ...lower.split(/\s+/).filter(t => t.length >= 4)]));
  const abbrMatch = clean.match(/\b([A-Z]{2,4})\b/);
  return {
    key: `raw:${lower}`,
    label: clean,
    abbr: abbrMatch ? abbrMatch[1] : undefined,
    nameAliases,
    abbrAliases: abbrMatch ? [abbrMatch[1]] : [],
    allAliases: Array.from(new Set([...nameAliases, ...(abbrMatch ? [abbrMatch[1].toLowerCase()] : [])])),
    eventIds
  };
}

function buildTeamDescriptors(
  headers: GameHeader[],
  injuries: AuthoritativeInjury[],
  hasSportsSignal: boolean
): TeamDescriptor[] {
  const map = new Map<string, TeamDescriptor>();
  const addDesc = (desc: TeamDescriptor | null) => {
    if (!desc) return;
    const existing = map.get(desc.key);
    if (!existing) {
      map.set(desc.key, desc);
      return;
    }
    for (const ev of desc.eventIds) {
      if (ev && !existing.eventIds.includes(ev)) existing.eventIds.push(ev);
    }
  };

  for (const h of headers) {
    addDesc(descriptorFromLabel(h.away, h.sport, h.eventId ? [h.eventId] : []));
    addDesc(descriptorFromLabel(h.home, h.sport, h.eventId ? [h.eventId] : []));
  }
  for (const inj of injuries) {
    if (inj.teamEntry) {
      addDesc(descriptorFromEntry(inj.teamEntry, inj.eventId ? [inj.eventId] : []));
    } else {
      addDesc(descriptorFromLabel(inj.teamLabel, inj.sport, inj.eventId ? [inj.eventId] : []));
    }
  }

  if (map.size === 0 && hasSportsSignal) {
    for (const entry of ESPN_TEAMS) {
      addDesc(descriptorFromEntry(entry));
    }
  }
  return Array.from(map.values());
}

interface TeamMentionMatch {
  team: TeamDescriptor;
  start: number;
  end: number;
}

function findTeamMentionsInText(text: string, candidates: TeamDescriptor[]): TeamMentionMatch[] {
  const mentions: TeamMentionMatch[] = [];
  for (const team of candidates) {
    for (const alias of team.nameAliases) {
      if (alias.length < 3) continue;
      const rx = new RegExp(`(?<![a-zA-Z0-9])${escapeRegex(alias)}(?![a-zA-Z0-9])`, 'gi');
      let m: RegExpExecArray | null;
      while ((m = rx.exec(text)) !== null) {
        mentions.push({ team, start: m.index, end: m.index + m[0].length });
      }
    }
    for (const abbr of team.abbrAliases) {
      const rx = new RegExp(`(?<![a-zA-Z0-9])${escapeRegex(abbr)}(?![a-zA-Z0-9])`, 'g');
      let m: RegExpExecArray | null;
      while ((m = rx.exec(text)) !== null) {
        mentions.push({ team, start: m.index, end: m.index + m[0].length });
      }
    }
  }
  return mentions;
}

function collectSuccessfulInjuryCoverage(successfulEvidence: string, candidates: TeamDescriptor[]): {
  coveredEventIds: Set<string>;
  coveredTeamKeys: Set<string>;
  hasGlobalCoverage: boolean;
} {
  const coveredEventIds = new Set<string>();
  const coveredTeamKeys = new Set<string>();
  let hasGlobalCoverage = false;
  if (!successfulEvidence) {
    return { coveredEventIds, coveredTeamKeys, hasGlobalCoverage };
  }

  let currentEventId: string | undefined;
  const lines = successfulEvidence.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const evMatch =
      line.match(/^EVENT\s+([a-z0-9-]+)/i) ||
      line.match(/^([a-z]{2,5}-\d+):/i);
    if (evMatch) {
      currentEventId = evMatch[1].trim();
    }

    const bracketInjuryMatch = line.match(/\[INJURY(?:\s*&\s*ROSTER\s*DELTA)?:\s*([a-z0-9-]+)[^\]]*\]/i);
    if (bracketInjuryMatch) {
      coveredEventIds.add(bracketInjuryMatch[1].trim());
      for (const hit of findTeamMentionsInText(line, candidates)) {
        coveredTeamKeys.add(hit.team.key);
      }
      continue;
    }

    if (/^(?:INJ:|Injuries:|-\s*\*\*Injury\s*\/\s*Roster\s*Delta\*\*:|\[INJURY\b)/i.test(line)) {
      if (currentEventId) {
        coveredEventIds.add(currentEventId);
      } else {
        hasGlobalCoverage = true;
      }
      for (const hit of findTeamMentionsInText(line, candidates)) {
        coveredTeamKeys.add(hit.team.key);
      }
    }
  }

  return { coveredEventIds, coveredTeamKeys, hasGlobalCoverage };
}

function teamHasInjuryCoverage(
  team: TeamDescriptor,
  headers: GameHeader[],
  coverage: { coveredEventIds: Set<string>; coveredTeamKeys: Set<string>; hasGlobalCoverage: boolean }
): boolean {
  if (coverage.coveredTeamKeys.has(team.key)) return true;
  if (team.eventIds.some(id => coverage.coveredEventIds.has(id))) return true;
  if (coverage.hasGlobalCoverage && headers.length <= 1) return true;
  return false;
}

function getOutInjuriesForTeam(team: TeamDescriptor, outInjuries: AuthoritativeInjury[]): AuthoritativeInjury[] {
  return outInjuries.filter(inj => {
    if (inj.teamEntry && `${inj.teamEntry.sport}:${inj.teamEntry.abbr}`.toLowerCase() === team.key) {
      return true;
    }
    if (team.abbr && inj.teamEntry?.abbr.toUpperCase() === team.abbr.toUpperCase()) {
      return true;
    }
    return inj.teamAliases.some(a => team.allAliases.includes(a));
  });
}

function findHealthViolationInClause(
  clause: string,
  candidates: TeamDescriptor[],
  outInjuries: AuthoritativeInjury[],
  headers: GameHeader[],
  coverage: { coveredEventIds: Set<string>; coveredTeamKeys: Set<string>; hasGlobalCoverage: boolean },
  selectedSideHint?: string
): { flag: 'contradicted_health_claim' | 'ungrounded_health_claim'; reason: string; claimText: string } | null {
  const norm = normalizeText(clause);
  const subClauses = norm
    .split(/(?<=[.!?])\s+|\n+|;\s+|\s+--\s+|,\s*(?=(?:while|whereas|but|although|though|yet)\b)|\s+(?=(?:while|whereas|but|although|though)\b)/i)
    .map(s => s.trim())
    .filter(Boolean);

  for (const sub of subClauses) {
    POSITIVE_HEALTH_CLAIM_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = POSITIVE_HEALTH_CLAIM_REGEX.exec(sub)) !== null) {
      const matchIdx = m.index;
      const matchEnd = matchIdx + m[0].length;
      const prefix = sub.slice(Math.max(0, matchIdx - 45), matchIdx);
      if (NEGATED_OR_POLICY_HEALTH_PREFIX_REGEX.test(prefix)) {
        continue;
      }

      const mentions = findTeamMentionsInText(sub, candidates);
      let targetTeams: TeamDescriptor[] = [];

      if (/\bboth\s+teams\b|\bboth\s+sides\b|\beither\s+team\b/i.test(sub)) {
        const uniq = new Map<string, TeamDescriptor>();
        for (const hit of mentions) uniq.set(hit.team.key, hit.team);
        if (uniq.size === 0 && headers.length === 1) {
          for (const td of candidates) {
            if (td.eventIds.includes(headers[0].eventId)) uniq.set(td.key, td);
          }
        }
        targetTeams = Array.from(uniq.values());
      } else if (mentions.length > 0) {
        let best: TeamMentionMatch | null = null;
        let bestScore = Infinity;
        for (const hit of mentions) {
          let score: number;
          if (hit.end <= matchIdx) {
            score = matchIdx - hit.end;
          } else {
            const between = sub.slice(matchEnd, hit.start);
            const isDirectPrep = /^\s*(?:for|on|at|with)\s+(?:the\s+)?$/i.test(between);
            score = (hit.start - matchEnd) + (isDirectPrep ? 0 : 40);
          }
          if (score < bestScore) {
            bestScore = score;
            best = hit;
          }
        }
        if (best) targetTeams = [best.team];
      } else if (selectedSideHint) {
        const sideMentions = findTeamMentionsInText(selectedSideHint, candidates);
        if (sideMentions.length > 0) {
          targetTeams = [sideMentions[0].team];
        }
      }

      if (targetTeams.length === 0) continue;

      for (const team of targetTeams) {
        const teamOuts = getOutInjuriesForTeam(team, outInjuries);
        if (teamOuts.length > 0) {
          const players = teamOuts.slice(0, 3).map(o => o.playerName).join(', ');
          const phrase = m[0].trim();
          return {
            flag: 'contradicted_health_claim',
            reason: `Contradicted health claim ("${phrase}") for ${team.label}: ${players} ${teamOuts.length === 1 ? 'is' : 'are'} OUT.`,
            claimText: phrase
          };
        }
        if (!teamHasInjuryCoverage(team, headers, coverage)) {
          const phrase = m[0].trim();
          return {
            flag: 'ungrounded_health_claim',
            reason: `Ungrounded health claim ("${phrase}") for ${team.label}: no successful injury tool result covers this team.`,
            claimText: phrase
          };
        }
      }
    }
  }

  return null;
}

const LEG_VETO_SIGNAL_REGEX =
  /\b(?:veto(?:ed|ing)?(?:\s+leg)?|reject(?:ed|ing)?(?:\s+leg)?|remov(?:ed|e)(?:\s+leg)?|drop(?:ped)?(?:\s+leg)?|disqualif(?:ied|y)|exclud(?:ed|e)|do\s+not\s+(?:bet|play|back|pick|recommend)|cannot\s+(?:bet|play|back|pick|recommend)|must\s+be\s+removed|fatal\s+injury|critical\s+roster\s+scratch|injury\s+misattribution|missing_(?:moneyline|spread|total)_coverage|missing\s+(?:moneyline|spread|total)\s+coverage|ungrounded|contradicted)\b/i;

const EXPLICIT_LEG_REF_IN_CLAUSE_REGEX =
  /\b(?:leg|pick|side|parlay|must\s+be\s+removed|vetoed\s+leg|R\d+|ML|moneyline|puckline|over\s+\d|under\s+\d)\b|[+-]\d+(?:\.5|\.0)\b/i;

const PURE_APPROVAL_CLAUSE_REGEX =
  /\b(?:verified|approved|passed|valid|clean)\b/i;

const SINGLE_BET_REC_REGEX =
  /\b(?:single\s+(?:bet|play|wager|unit|leg|ticket)|as\s+a\s+single|standalone\s+(?:bet|play|wager|pick|single)|straight\s+(?:bet|play|wager)|recommended\s+single)\b/i;

const NEGATED_SINGLE_BET_REGEX =
  /\b(?:do\s+not|don't|never|avoid|skip|pass\s+on|no|not\s+(?:recommend(?:ed)?|play|bet|back|take|rewrite))\b[^.;]{0,45}\b(?:single\s+(?:bet|play|wager)|as\s+a\s+single|standalone|straight\s+(?:bet|play)|recommended\s+single)\b|\b(?:single\s+(?:bet|play|wager)|standalone\s+(?:bet|play))\b[^.;]{0,25}\b(?:not\s+recommended|avoided|rejected|removed|off\s+the\s+card)\b/i;

const INLINE_VETO_REF_REGEX =
  /\b(?:vetoed|rejected|dropped|removed|disqualified|excluded)\s+(?:leg|pick|side|parlay\s+leg)?\b/i;

const EXPLICIT_VETO_PRONOUN_REGEX =
  /\b(?:the|that)\s+(?:vetoed|dropped|rejected|removed)\s+leg\b/i;

const VETO_PRONOUN_REF_REGEX =
  /\b(?:it|that\s+leg|same\s+leg)\b/i;

function resolveRowTeamDescriptor(
  rowEntry: RowOptionEntry,
  candidates: TeamDescriptor[]
): TeamDescriptor | undefined {
  const rowText = rowEntry.text;
  const scoped = rowEntry.eventId
    ? candidates.filter(c => c.eventIds.length === 0 || c.eventIds.includes(rowEntry.eventId!))
    : candidates;
  const hits = findTeamMentionsInText(rowText, scoped.length > 0 ? scoped : candidates);
  if (hits.length > 0) return hits[0].team;
  return undefined;
}

export function mergeVetoedLegTargets(...lists: Array<VetoedLegTarget[] | undefined>): VetoedLegTarget[] {
  const merged: VetoedLegTarget[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item) continue;
      const rowKey = item.rowId ? `row:${item.rowId.toUpperCase()}` : undefined;
      const teamKey = item.teamLabel ? `team:${item.teamLabel.toLowerCase()}` : (item.teamAliases?.[0] ? `alias:${item.teamAliases[0].toLowerCase()}` : undefined);
      const evKey = item.eventId ? `ev:${item.eventId}` : '';
      const key = rowKey || (teamKey ? `${evKey}|${teamKey}` : `raw:${item.reason.slice(0, 60)}`);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        ...(item.rowId ? { rowId: item.rowId.toUpperCase() } : {}),
        ...(item.eventId ? { eventId: item.eventId } : {}),
        ...(item.teamLabel ? { teamLabel: item.teamLabel } : {}),
        teamAliases: Array.isArray(item.teamAliases) ? Array.from(new Set(item.teamAliases)) : [],
        reason: item.reason
      });
    }
  }
  return merged;
}

export function mergeVetoedClaims(...lists: Array<string[] | undefined>): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (typeof raw !== 'string') continue;
      const clean = normalizeText(raw).trim();
      if (clean.length < 3) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(clean);
    }
  }
  return merged;
}

/**
 * Extracts explicitly quoted ungrounded/contradicted/vetoed claim phrases from Critic veto feedback lines.
 */
export function extractQuotedVetoedClaims(vetoTexts: string[]): string[] {
  if (!Array.isArray(vetoTexts) || vetoTexts.length === 0) return [];
  const claims: string[] = [];
  for (const raw of vetoTexts) {
    if (!raw || typeof raw !== 'string') continue;
    const norm = normalizeText(raw);
    const rx =
      /(?:Ungrounded\s+(?:record\/form|form\/score|score|health)\s+claim|Contradicted\s+health\s+claim|Vetoed\s+claim)\s*\(\s*["']([^"']{2,100})["']\s*\)/gi;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(norm)) !== null) {
      const phrase = m[1].trim();
      if (!phrase) continue;
      claims.push(phrase);
      const threePartRecord = phrase.match(/\b(\d{1,3}\s*-\s*\d{1,3}\s*-\s*\d{1,3})\b/);
      if (threePartRecord) {
        claims.push(threePartRecord[1].replace(/\s+/g, ''));
      }
    }
  }
  return mergeVetoedClaims(claims);
}

/**
 * Extracts vetoed leg targets (row IDs and team aliases) from Critic veto messages.
 */
export function extractVetoedLegTargets(
  vetoTexts: string[],
  headers: GameHeader[],
  rowMap: Map<string, RowOptionEntry>,
  candidates?: TeamDescriptor[]
): VetoedLegTarget[] {
  if (!Array.isArray(vetoTexts) || vetoTexts.length === 0) return [];
  const teamPool = candidates || buildTeamDescriptors(headers, [], true);
  const targets: VetoedLegTarget[] = [];
  const seenKeys = new Set<string>();

  for (const rawVeto of vetoTexts) {
    if (!rawVeto || typeof rawVeto !== 'string') continue;
    const clauses = normalizeText(rawVeto).split(
      /(?<=[.!?])\s+|\n+|;\s+|,\s*(?=(?:while|whereas|but)\b)/i
    );
    for (const clause of clauses) {
      const trimmed = clause.trim();
      if (!trimmed) continue;
      if (/\brow\s+side\s+mismatch\b|\brow_side_mismatch\b/i.test(trimmed)) continue;
      if (/^Veto\s*\(PULL BEFORE PASS\):/i.test(trimmed) && !/\bmust\s+be\s+removed\b/i.test(trimmed)) {
        continue;
      }
      if (/^Veto\s*\((?:GROUNDING|INJURY ATTRIBUTION RULE)\):/i.test(trimmed) && !EXPLICIT_LEG_REF_IN_CLAUSE_REGEX.test(trimmed)) {
        continue;
      }
      if (!LEG_VETO_SIGNAL_REGEX.test(trimmed)) continue;
      if (PURE_APPROVAL_CLAUSE_REGEX.test(trimmed) && !/\b(?:veto|reject|remove|drop|fatal|missing|ungrounded|contradicted)\b/i.test(trimmed)) {
        continue;
      }

      const rowMatches = trimmed.match(/\bR\d+\b/gi) || [];
      const rowIds = Array.from(new Set(rowMatches.map(r => r.toUpperCase())));
      if (rowIds.length > 0) {
        for (const rowId of rowIds) {
          const rowEntry = rowMap.get(rowId);
          const team = rowEntry ? resolveRowTeamDescriptor(rowEntry, teamPool) : undefined;
          const key = `row:${rowId}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          targets.push({
            rowId,
            eventId: rowEntry?.eventId,
            teamLabel: team?.label,
            teamAliases: team ? team.allAliases : [],
            reason: trimmed.slice(0, 140)
          });
        }
        continue;
      }

      // No row ID: ignore trailing opponent after ", not <Opp>" / "vs <Opp>" / "@ <Opp>"
      const primarySpan = trimmed.split(/,\s*not\s+|\binstead\s+of\b|\b(?:vs\.?|versus|@|against)\b/i)[0] || trimmed;
      const mentions = findTeamMentionsInText(primarySpan, teamPool);
      const uniqueTeams = new Map<string, TeamDescriptor>();
      for (const m of mentions) uniqueTeams.set(m.team.key, m.team);
      for (const team of uniqueTeams.values()) {
        const key = `team:${team.key}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        targets.push({
          eventId: team.eventIds[0],
          teamLabel: team.label,
          teamAliases: team.allAliases,
          reason: trimmed.slice(0, 140)
        });
      }
    }
  }

  return targets;
}

const EXPLICIT_VETO_EXPLANATION_REGEX =
  /\b(?:was\s+vetoed|were\s+vetoed|is\s+vetoed|vetoed\s+(?:from|for|due|and)|rejected|remov(?:ed|ing)|drop(?:ped|ping)|exclud(?:ed|ing)|disqualif(?:ied|y)|off\s+the\s+card|not\s+recommend(?:ed|ing)|do\s+not\s+(?:bet|play|back|pick|recommend)|cannot\s+(?:bet|play|back|pick|recommend)|must\s+be\s+removed|avoid(?:ed|ing)?|skip(?:ped|ping)?|pass(?:ed|ing)?\s+on)\b/i;

const LEG_REC_CONTEXT_REGEX =
  /\b(?:parlay|recommend(?:ed|ing|s)?|recommended\s+bets?|play(?:ing)?|back(?:ing)?|take|taking|pick(?:ed|s|ing)?|bet(?:s|ting)?|ticket|card|leg|legs)\b/i;

function textMatchesAliases(text: string, aliases: string[]): boolean {
  if (!text || aliases.length === 0) return false;
  const norm = normalizeText(text).toLowerCase();
  return aliases.some(alias => {
    const trimmed = alias.trim().toLowerCase();
    if (trimmed.length < 2) return false;
    const rx = new RegExp(`(?<![a-z0-9])${escapeRegex(trimmed)}(?![a-z0-9])`, 'i');
    return rx.test(norm);
  });
}

function pickMatchesVetoedTarget(pk: any, target: VetoedLegTarget): boolean {
  if (!pk) return false;
  if (typeof pk === 'string') {
    return targetMatchesTextSpan(pk, target);
  }
  if (typeof pk !== 'object') return false;

  const rawRow = pk.row ?? pk.Row ?? pk.rowId ?? pk.id ?? pk.ID;
  const pkRowId = typeof rawRow === 'string' && /^R\d+$/i.test(rawRow.trim())
    ? rawRow.trim().toUpperCase()
    : undefined;

  if (target.rowId && pkRowId) {
    return pkRowId === target.rowId;
  }
  if (target.rowId && targetMatchesTextSpan(String(pk.pick || pk.side || pk.selection || ''), { ...target, teamAliases: [] })) {
    return true;
  }

  const pkEventId = typeof pk.event_id === 'string' && pk.event_id.trim()
    ? pk.event_id.trim()
    : (typeof pk.eventId === 'string' && pk.eventId.trim() ? pk.eventId.trim() : undefined);
  if (target.eventId && pkEventId && target.eventId !== pkEventId) {
    return false;
  }

  const sideText = [pk.side, pk.pick, pk.selection, pk.team, pk.Side, pk.Pick]
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .join(' ')
    .trim();
  if (!sideText) return false;
  return targetMatchesTextSpan(sideText, target);
}

function findSingleBetRewriteViolationInClause(
  clause: string,
  vetoedTargets: VetoedLegTarget[],
  priorSubjectWasVetoed: boolean
): { violation: string | null; endsWithVetoedSubject: boolean } {
  if (!clause || vetoedTargets.length === 0) {
    return { violation: null, endsWithVetoedSubject: false };
  }
  const norm = normalizeText(clause);
  const endsWithVetoed = vetoedTargets.some(t => targetMatchesTextSpan(norm.slice(-120), t));

  SINGLE_BET_REC_REGEX.lastIndex = 0;
  if (!SINGLE_BET_REC_REGEX.test(norm) || NEGATED_SINGLE_BET_REGEX.test(norm)) {
    return { violation: null, endsWithVetoedSubject: endsWithVetoed };
  }

  // Split into sub-clauses so a negated/explanatory veto clause followed by a DIFFERENT grounded leg passes cleanly.
  const subClauses = norm
    .split(/,\s*(?=(?:so|leaving|making|which\s+leaves|instead|thus|therefore)\b)|;\s*/i)
    .map(s => s.trim())
    .filter(Boolean);

  for (let i = 0; i < subClauses.length; i++) {
    const sub = subClauses[i];
    SINGLE_BET_REC_REGEX.lastIndex = 0;
    if (!SINGLE_BET_REC_REGEX.test(sub) || NEGATED_SINGLE_BET_REGEX.test(sub)) continue;

    // Look directly in this sub-clause for a vetoed target (taking care if both vetoed & non-vetoed appear, use segment right before single-bet phrase)
    const mSingle = SINGLE_BET_REC_REGEX.exec(sub);
    const localSpan = mSingle ? sub.slice(Math.max(0, mSingle.index - 80), mSingle.index + mSingle[0].length) : sub;

    const directMatch = vetoedTargets.find(t => targetMatchesTextSpan(localSpan, t))
      || vetoedTargets.find(t => targetMatchesTextSpan(sub, t));
    if (directMatch && !/^(?:the|that)\s+vetoed/i.test(sub)) {
      const label = directMatch.rowId || directMatch.teamLabel || 'vetoed leg';
      return {
        violation: `Vetoed leg (${label}) must not be rewritten as a recommended single bet.`,
        endsWithVetoedSubject: true
      };
    }

    // Pronoun fallback when sub-clause refers to prior vetoed subject without naming a non-vetoed team
    if (
      (EXPLICIT_VETO_PRONOUN_REGEX.test(sub) || (VETO_PRONOUN_REF_REGEX.test(sub) && (priorSubjectWasVetoed || i > 0)))
    ) {
      const prevSub = i > 0 ? subClauses[i - 1] : '';
      const prevTarget = prevSub ? vetoedTargets.find(t => targetMatchesTextSpan(prevSub, t)) : undefined;
      if (prevTarget || priorSubjectWasVetoed || EXPLICIT_VETO_PRONOUN_REGEX.test(sub)) {
        const label = prevTarget?.rowId || prevTarget?.teamLabel || 'vetoed leg';
        return {
          violation: `Vetoed leg (${label}) must not be rewritten as a recommended single bet.`,
          endsWithVetoedSubject: true
        };
      }
    }
  }

  return { violation: null, endsWithVetoedSubject: endsWithVetoed };
}

function targetMatchesTextSpan(text: string, target: VetoedLegTarget): boolean {
  if (!text) return false;
  if (target.rowId && new RegExp(`\\b${escapeRegex(target.rowId)}\\b`, 'i').test(text)) {
    return true;
  }
  if (target.teamAliases.length > 0 && textMatchesAliases(text, target.teamAliases)) {
    return true;
  }
  return false;
}

function findRepeatedVetoedClaimInClause(clause: string, vetoedClaims: string[]): string | null {
  if (!clause || !Array.isArray(vetoedClaims) || vetoedClaims.length === 0) return null;
  const normClause = normalizeText(clause);
  for (const claim of vetoedClaims) {
    if (!claim || claim.length < 3) continue;
    const escaped = escapeRegex(claim);
    const rx = new RegExp(`(?<![a-zA-Z0-9-])${escaped}(?![a-zA-Z0-9-])`, 'i');
    if (rx.test(normClause)) {
      return claim;
    }
  }
  return null;
}

function isParlayLegString(segment: string): boolean {
  return /\b(?:R\d+|ML|moneyline|puckline|runline|over|under)\b|[+-]\d+(?:\.\d+)?/i.test(segment);
}

/**
 * Strips vetoed legs from `+`-separated parlay lists (e.g. "Ottawa ML + Chicago ML + Vancouver +1.5").
 */
export function stripVetoedLegsFromParlayText(text: string, vetoedTargets: VetoedLegTarget[]): string {
  if (!text || vetoedTargets.length === 0 || !text.includes('+')) return text;
  // Match "+"-joined multi-leg parlay phrases (2+ segments joined by " + ")
  return text.replace(
    /([A-Za-z0-9.()\-+\s/']{3,55}?(?:\s+\+\s+[A-Za-z0-9.()\-+\s/']{3,55}?)+)/g,
    (fullMatch) => {
      const parts = fullMatch.split(/\s+\+\s+/);
      if (parts.length < 2) return fullMatch;
      const looksLikeParlay = parts.some(isParlayLegString);
      if (!looksLikeParlay) return fullMatch;
      const kept = parts.filter(part => !vetoedTargets.some(t => targetMatchesTextSpan(part, t)));
      if (kept.length === parts.length) return fullMatch;
      return kept.join(' + ');
    }
  );
}

function findVetoedLegRecommendationInClause(
  clause: string,
  vetoedTargets: VetoedLegTarget[]
): { target: VetoedLegTarget; subClause: string } | null {
  if (!clause || vetoedTargets.length === 0) return null;
  const norm = normalizeText(clause);
  const subClauses = norm
    .split(/,\s*(?=(?:so|leaving|making|which\s+leaves|instead|after|while|whereas)\b)|;\s+/i)
    .map(s => s.trim())
    .filter(Boolean);

  for (const sub of subClauses) {
    if (EXPLICIT_VETO_EXPLANATION_REGEX.test(sub)) continue;
    const matched = vetoedTargets.find(t => targetMatchesTextSpan(sub, t));
    if (!matched) continue;

    // Flag if sub-clause either lists it as a "+" parlay leg, includes bet syntax (ML/+1.5/R-id),
    // or explicitly recommends/plays/picks/backs it.
    const hasParlayPlus = /\s\+\s/.test(sub);
    const hasBetMarker =
      (matched.rowId && new RegExp(`\\b${escapeRegex(matched.rowId)}\\b`, 'i').test(sub)) ||
      /\b(?:ML|moneyline|puckline|over\s+\d|under\s+\d)\b|[+-]\d+(?:\.5|\.0)\b/i.test(sub);
    if (hasParlayPlus || (hasBetMarker && LEG_REC_CONTEXT_REGEX.test(sub)) || /\b(?:play|back|take|pick|recommend(?:s|ed|ing)?|parlay)\b/i.test(sub)) {
      return { target: matched, subClause: sub };
    }
  }
  return null;
}

function buildVetoTargetFromPick(
  pk: any,
  headers: GameHeader[],
  rowMap: Map<string, RowOptionEntry>,
  candidates: TeamDescriptor[],
  reason: string
): VetoedLegTarget | null {
  if (!pk) return null;
  if (typeof pk === 'string') {
    const rMatch = pk.match(/\b(R\d+)\b/i);
    const rowId = rMatch ? rMatch[1].toUpperCase() : undefined;
    const rowEntry = rowId ? rowMap.get(rowId) : undefined;
    const rowTeam = rowEntry ? resolveRowTeamDescriptor(rowEntry, candidates) : undefined;
    const textTeam = rowTeam || findTeamMentionsInText(pk, candidates)[0]?.team;
    const matchedEntry = textTeam ? undefined : matchTeamByLabel(pk);
    const teamAliases = textTeam
      ? textTeam.allAliases
      : (matchedEntry ? descriptorFromEntry(matchedEntry).allAliases : []);
    if (!rowId && teamAliases.length === 0) return null;
    return {
      ...(rowId ? { rowId } : {}),
      eventId: rowEntry?.eventId || textTeam?.eventIds[0],
      teamLabel: textTeam?.label || matchedEntry?.name,
      teamAliases,
      reason: reason.slice(0, 140)
    };
  }

  if (typeof pk !== 'object') return null;
  let rowId = typeof pk.row === 'string' && /^R\d+$/i.test(pk.row.trim())
    ? pk.row.trim().toUpperCase()
    : (typeof pk.id === 'string' && /^R\d+$/i.test(pk.id.trim()) ? pk.id.trim().toUpperCase() : undefined);
  const sideText = [pk.side, pk.pick, pk.selection, pk.team, pk.note]
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .join(' ')
    .trim();
  if (!rowId && sideText) {
    const m = sideText.match(/\b(R\d+)\b/i);
    if (m) rowId = m[1].toUpperCase();
  }

  const rowEntry = rowId ? rowMap.get(rowId) : undefined;
  const eventId = getEventIdForPick(pk, headers) || rowEntry?.eventId;
  const scopedCandidates = eventId
    ? candidates.filter(c => c.eventIds.length === 0 || c.eventIds.includes(eventId))
    : candidates;
  const pool = scopedCandidates.length > 0 ? scopedCandidates : candidates;

  const sideTeam = sideText ? findTeamMentionsInText(sideText, pool)[0]?.team : undefined;
  const rowTeam = rowEntry ? resolveRowTeamDescriptor(rowEntry, pool) : undefined;
  const team = sideTeam || rowTeam;
  const matchedEntry = !team && sideText ? matchTeamByLabel(sideText) : undefined;
  const teamAliases = team
    ? team.allAliases
    : (matchedEntry ? descriptorFromEntry(matchedEntry).allAliases : []);
  const teamLabel = team?.label || matchedEntry?.name || (sideText || undefined);

  if (!rowId && teamAliases.length === 0) return null;
  return {
    ...(rowId ? { rowId } : {}),
    ...(eventId ? { eventId } : {}),
    ...(teamLabel ? { teamLabel } : {}),
    teamAliases,
    reason: reason.slice(0, 140)
  };
}

function isRecommendationTable(comp: any): boolean {
  if (!comp || comp.type !== 'DataTable' || !comp.props) return false;
  const title = String(comp.props.title || '');
  if (/\b(?:recommend|bet|pick|parlay|play|selection|card|leg)\b/i.test(title) && !/\bslate\s+overview\b|\bodds\s+board\b/i.test(title)) {
    return true;
  }
  const cols = Array.isArray(comp.props.columns) ? comp.props.columns : [];
  if (cols.some((c: any) => /^(?:pick|leg|selection|bet|side|parlay)$/i.test(String(c?.key || c?.header || '')))) {
    return true;
  }
  const headers = Array.isArray(comp.props.headers) ? comp.props.headers : [];
  return headers.some((h: any) => /^(?:pick|leg|selection|bet|side|parlay)$/i.test(String(h || '')));
}

function dataTableRowMatchesTarget(row: any, target: VetoedLegTarget): boolean {
  if (!row || typeof row !== 'object') return false;
  const rawRow = row.row ?? row.Row ?? row.id ?? row.ID;
  const rowId = typeof rawRow === 'string' && /^R\d+$/i.test(rawRow.trim())
    ? rawRow.trim().toUpperCase()
    : undefined;
  if (target.rowId && rowId) return rowId === target.rowId;
  const joined = Object.values(row)
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .join(' ');
  return targetMatchesTextSpan(joined, target);
}

/**
 * Deterministically audits a proposal or analyst report for:
 *  1) Ungrounded score / goals-allowed / form claims not in successful tool results
 *  2) Contradicted or ungrounded positive team health claims
 *  3) Vetoed legs retained in picks/Recommended Bets tables or rewritten as recommended bets/singles
 *  4) Previously vetoed claims repeated in retry attempts or final analysis
 */
export function auditClaimGrounding(
  proposal: any,
  evidenceText: string,
  slateText?: string,
  options?: {
    headers?: GameHeader[];
    vetoTexts?: string[];
    vetoedLegs?: VetoedLegTarget[];
    vetoedClaims?: string[];
  }
): GroundingAuditResult {
  if (!proposal) return { pass: true, violations: [], flags: [] };

  const headers = options?.headers && options.headers.length > 0
    ? options.headers
    : parseGameHeaders(slateText);
  const rowMap = extractRowOptions([slateText], headers);

  const successfulEvidence = extractSuccessfulEvidenceText(evidenceText);
  const cleanEvidence = buildCleanEvidenceForNumericCheck(successfulEvidence);

  const rawProposalText = typeof proposal === 'string' ? proposal : JSON.stringify(proposal);
  const hasSportsSignal =
    headers.length > 0 ||
    SPORTS_CONTEXT_REGEX.test(rawProposalText) ||
    SPORTS_CONTEXT_REGEX.test(slateText || '') ||
    Boolean(successfulEvidence);

  const allInjuries = extractAuthoritativeInjuries(successfulEvidence, slateText);
  const outInjuries = allInjuries.filter(inj => /^(?:OUT|IR|INJURED\s+RESERVE|SUSPENDED)$/i.test(inj.status));
  const candidates = buildTeamDescriptors(headers, outInjuries, hasSportsSignal);
  const groundedRecords = extractGroundedRecords(successfulEvidence, candidates);
  const injuryCoverage = collectSuccessfulInjuryCoverage(successfulEvidence, candidates);
  const vetoedTargets = mergeVetoedLegTargets(
    options?.vetoedLegs,
    extractVetoedLegTargets(options?.vetoTexts || [], headers, rowMap, candidates)
  );
  const priorVetoedClaims = mergeVetoedClaims(
    options?.vetoedClaims,
    extractQuotedVetoedClaims(options?.vetoTexts || [])
  );

  const violations: string[] = [];
  const flags: string[] = [];
  const detectedVetoedLegs: VetoedLegTarget[] = [];
  const detectedVetoedClaims: string[] = [];

  const addViolation = (flag: string, msg: string) => {
    if (!flags.includes(flag)) flags.push(flag);
    if (!violations.includes(msg)) violations.push(msg);
  };
  const recordClaims = (claims: string[]) => {
    for (const c of claims) {
      if (c && !detectedVetoedClaims.some(x => x.toLowerCase() === c.toLowerCase())) {
        detectedVetoedClaims.push(c);
      }
    }
  };
  const recordVetoedLeg = (target: VetoedLegTarget | null) => {
    if (!target) return;
    detectedVetoedLegs.push(target);
  };

  if (typeof proposal === 'object' && Array.isArray(proposal.picks) && vetoedTargets.length > 0) {
    for (const pk of proposal.picks) {
      const matched = vetoedTargets.find(t => pickMatchesVetoedTarget(pk, t));
      if (matched) {
        addViolation(
          'vetoed_leg_kept',
          `Vetoed leg (${matched.rowId || matched.teamLabel || 'pick'}) must be removed from picks.`
        );
        recordVetoedLeg(matched);
      }
    }
  }

  let priorSubWasVetoed = false;
  const checkText = (
    text: unknown,
    sideHint?: string,
    onViolation?: (reason: string) => void,
    checkLegRec: boolean = true
  ) => {
    if (typeof text !== 'string' || !text.trim()) return;
    priorSubWasVetoed = false;
    const clauses = text.split(/(?<=[.!?])\s+|\n+|;\s+/);
    for (const clause of clauses) {
      if (!clause.trim()) continue;

      const formDetail = findUngroundedFormClaimDetailInClause(
        clause,
        cleanEvidence,
        groundedRecords,
        candidates,
        hasSportsSignal,
        sideHint
      );
      if (formDetail) {
        addViolation('ungrounded_form_claim', formDetail.reason);
        recordClaims(formDetail.claimTexts);
        onViolation?.(formDetail.reason);
      }

      const healthErr = findHealthViolationInClause(
        clause,
        candidates,
        outInjuries,
        headers,
        injuryCoverage,
        sideHint
      );
      if (healthErr) {
        addViolation(healthErr.flag, healthErr.reason);
        recordClaims([healthErr.claimText]);
        onViolation?.(healthErr.reason);
      }

      const repeatedClaim = findRepeatedVetoedClaimInClause(clause, priorVetoedClaims);
      if (repeatedClaim) {
        const msg = `Vetoed claim ("${repeatedClaim}") must not be repeated.`;
        addViolation('vetoed_claim_repeated', msg);
        recordClaims([repeatedClaim]);
        onViolation?.(msg);
      }

      const singleBetRes = findSingleBetRewriteViolationInClause(clause, vetoedTargets, priorSubWasVetoed);
      priorSubWasVetoed = singleBetRes.endsWithVetoedSubject;
      if (singleBetRes.violation) {
        addViolation('vetoed_leg_rewritten', singleBetRes.violation);
      } else if (checkLegRec && vetoedTargets.length > 0) {
        const legRec = findVetoedLegRecommendationInClause(clause, vetoedTargets);
        if (legRec) {
          const label = legRec.target.rowId || legRec.target.teamLabel || 'vetoed leg';
          addViolation(
            'vetoed_leg_recommended',
            `Vetoed leg (${label}) must not be recommended in analysis.`
          );
        }
      }
    }
  };

  if (typeof proposal === 'string') {
    checkText(proposal);
  } else if (typeof proposal === 'object') {
    checkText(proposal.summary);
    checkText(proposal.analysis);
    checkText(proposal.reason);
    checkText(proposal.rationale);
    checkText(proposal.conclusion);

    if (Array.isArray(proposal.insights)) {
      for (const ins of proposal.insights) checkText(ins);
    }
    if (Array.isArray(proposal.anomalies)) {
      for (const anom of proposal.anomalies) checkText(anom);
    }
    if (Array.isArray(proposal.picks)) {
      for (const pk of proposal.picks) {
        if (!pk || typeof pk !== 'object') {
          checkText(pk, undefined, (reason) => {
            recordVetoedLeg(buildVetoTargetFromPick(pk, headers, rowMap, candidates, reason));
          }, false);
          continue;
        }
        const sideHint = String(pk.side || pk.pick || pk.selection || pk.team || '');
        const onPickViolation = (reason: string) => {
          recordVetoedLeg(buildVetoTargetFromPick(pk, headers, rowMap, candidates, reason));
        };
        checkText(pk.reason, sideHint, onPickViolation, false);
        checkText(pk.rationale, sideHint, onPickViolation, false);
        checkText(pk.edge, sideHint, onPickViolation, false);
        checkText(pk.note, sideHint, onPickViolation, false);
        checkText(pk.description, sideHint, onPickViolation, false);
        checkText(pk.claim, sideHint, onPickViolation, false);
        if (Array.isArray(pk.reasons)) {
          for (const r of pk.reasons) checkText(r, sideHint, onPickViolation, false);
        }
      }
    }
    if (Array.isArray(proposal.scorecards)) {
      for (const sc of proposal.scorecards) {
        if (!sc || typeof sc !== 'object') continue;
        const sideHint = String(sc.pick || sc.side || '');
        const onScViolation = (reason: string) => {
          recordVetoedLeg(buildVetoTargetFromPick(sc, headers, rowMap, candidates, reason));
        };
        checkText(sc.note, sideHint, onScViolation, false);
        checkText(sc.reason, sideHint, onScViolation, false);
        checkText(sc.summary, sideHint, onScViolation, false);
        if (Array.isArray(sc.reasons)) {
          for (const r of sc.reasons) checkText(r, sideHint, onScViolation, false);
        }
      }
    }
    if (proposal.scorecard && typeof proposal.scorecard === 'object') {
      const sc = proposal.scorecard;
      const sideHint = String(sc.pick || sc.side || '');
      const onScViolation = (reason: string) => {
        recordVetoedLeg(buildVetoTargetFromPick(sc, headers, rowMap, candidates, reason));
      };
      checkText(sc.note, sideHint, onScViolation, false);
      checkText(sc.reason, sideHint, onScViolation, false);
      checkText(sc.summary, sideHint, onScViolation, false);
    }
    if (Array.isArray(proposal.components)) {
      for (const comp of proposal.components) {
        if (!comp || typeof comp !== 'object' || !comp.props) continue;
        if (comp.type === 'InsightList' && Array.isArray(comp.props.insights)) {
          for (const ins of comp.props.insights) {
            checkText(typeof ins === 'string' ? ins : ins?.message);
          }
        } else if (comp.type === 'MetricCard' && typeof comp.props.subtitle === 'string') {
          checkText(comp.props.subtitle);
        } else if (comp.type === 'DataTable' && Array.isArray(comp.props.rows)) {
          const isRecs = isRecommendationTable(comp);
          for (const row of comp.props.rows) {
            if (!row || typeof row !== 'object') continue;
            if (isRecs && vetoedTargets.length > 0) {
              const matched = vetoedTargets.find(t => dataTableRowMatchesTarget(row, t));
              if (matched) {
                addViolation(
                  'vetoed_leg_kept',
                  `Vetoed leg (${matched.rowId || matched.teamLabel || 'pick'}) must be removed from ${comp.props.title || 'DataTable'}.`
                );
              }
            }
            for (const val of Object.values(row)) {
              if (typeof val === 'string') checkText(val, undefined, undefined, false);
            }
          }
        }
      }
    }
  }

  const mergedLegs = mergeVetoedLegTargets(detectedVetoedLegs);
  const mergedClaims = mergeVetoedClaims(detectedVetoedClaims);

  if (violations.length > 0) {
    return {
      pass: false,
      violations,
      flags,
      feedback: `Veto (GROUNDING): ${violations.join(' ')}`,
      ...(mergedLegs.length > 0 ? { vetoedLegs: mergedLegs } : {}),
      ...(mergedClaims.length > 0 ? { vetoedClaims: mergedClaims } : {})
    };
  }

  return { pass: true, violations: [], flags: [] };
}

/**
 * Deterministically removes vetoed legs from picks/scorecards/Recommended Bets tables and strips
 * ungrounded/vetoed form/score/health claims and vetoed leg recommendations from report prose fields.
 */
export function sanitizeUngroundedClaims<T extends Record<string, any>>(
  report: T,
  evidenceText: string,
  slateText?: string,
  options?: {
    headers?: GameHeader[];
    vetoTexts?: string[];
    vetoedLegs?: VetoedLegTarget[];
    vetoedClaims?: string[];
    stripVetoedLegRecommendations?: boolean;
  }
): T {
  if (!report || typeof report !== 'object') return report;

  const headers = options?.headers && options.headers.length > 0
    ? options.headers
    : parseGameHeaders(slateText);
  const rowMap = extractRowOptions([slateText], headers);

  const successfulEvidence = extractSuccessfulEvidenceText(evidenceText);
  const cleanEvidence = buildCleanEvidenceForNumericCheck(successfulEvidence);

  const rawReportText = JSON.stringify(report);
  const hasSportsSignal =
    headers.length > 0 ||
    SPORTS_CONTEXT_REGEX.test(rawReportText) ||
    SPORTS_CONTEXT_REGEX.test(slateText || '') ||
    Boolean(successfulEvidence);

  const allInjuries = extractAuthoritativeInjuries(successfulEvidence, slateText);
  const outInjuries = allInjuries.filter(inj => /^(?:OUT|IR|INJURED\s+RESERVE|SUSPENDED)$/i.test(inj.status));
  const candidates = buildTeamDescriptors(headers, outInjuries, hasSportsSignal);
  const groundedRecords = extractGroundedRecords(successfulEvidence, candidates);
  const injuryCoverage = collectSuccessfulInjuryCoverage(successfulEvidence, candidates);

  let vetoedTargets = mergeVetoedLegTargets(
    options?.vetoedLegs,
    extractVetoedLegTargets(options?.vetoTexts || [], headers, rowMap, candidates)
  );
  const vetoedClaims = mergeVetoedClaims(
    options?.vetoedClaims,
    extractQuotedVetoedClaims(options?.vetoTexts || [])
  );

  const sentenceHasViolation = (
    sentence: string,
    sideHint?: string,
    priorSubWasVetoed: boolean = false,
    checkLegRec: boolean = false
  ): { hasViolation: boolean; endsWithVetoedSubject: boolean } => {
    if (!sentence.trim()) return { hasViolation: false, endsWithVetoedSubject: priorSubWasVetoed };
    const singleRes = findSingleBetRewriteViolationInClause(sentence, vetoedTargets, priorSubWasVetoed);
    const legRecViolation = checkLegRec && vetoedTargets.length > 0
      ? Boolean(findVetoedLegRecommendationInClause(sentence, vetoedTargets))
      : false;
    const hasViolation = Boolean(
      findUngroundedFormClaimInClause(
        sentence,
        cleanEvidence,
        groundedRecords,
        candidates,
        hasSportsSignal,
        sideHint
      ) ||
      findHealthViolationInClause(sentence, candidates, outInjuries, headers, injuryCoverage, sideHint) ||
      findRepeatedVetoedClaimInClause(sentence, vetoedClaims) ||
      singleRes.violation ||
      legRecViolation
    );
    return { hasViolation, endsWithVetoedSubject: singleRes.endsWithVetoedSubject };
  };

  const cleanTextField = (text: string, sideHint?: string, checkLegRec: boolean = true): string => {
    const preStripped = vetoedTargets.length > 0 ? stripVetoedLegsFromParlayText(text, vetoedTargets) : text;
    const sentences = preStripped.split(/(?<=[.!?])\s+|\n+/);
    const kept: string[] = [];
    let priorSubWasVetoed = false;
    for (const s of sentences) {
      const checkRes = sentenceHasViolation(s, sideHint, priorSubWasVetoed, checkLegRec);
      const prevVetoFlag = priorSubWasVetoed;
      priorSubWasVetoed = checkRes.endsWithVetoedSubject;
      if (!checkRes.hasViolation) {
        kept.push(s);
        continue;
      }
      // Try removing an offending parenthetical or contrast sub-clause first
      const withoutParen = s.replace(/\s*\([^)]*\)/g, '').replace(/\s{2,}/g, ' ').trim();
      if (withoutParen && withoutParen !== s.trim() && !sentenceHasViolation(withoutParen, sideHint, prevVetoFlag, checkLegRec).hasViolation) {
        kept.push(withoutParen);
        continue;
      }
      // Try dropping only offending comma/semicolon sub-clauses
      const subParts = s.split(/;\s+|,\s*(?=(?:while|whereas|but|although|though|so|yet)\b)/i);
      if (subParts.length > 1) {
        let subPrior = prevVetoFlag;
        const cleanSubs: string[] = [];
        for (const part of subParts) {
          const partRes = sentenceHasViolation(part, sideHint, subPrior, checkLegRec);
          subPrior = partRes.endsWithVetoedSubject;
          if (!partRes.hasViolation) cleanSubs.push(part);
        }
        const rejoined = cleanSubs.join(', ').trim();
        if (rejoined && !sentenceHasViolation(rejoined, sideHint, prevVetoFlag, checkLegRec).hasViolation) {
          kept.push(rejoined);
        }
      }
    }
    return kept.join(' ').trim();
  };

  const rep = report as Record<string, any>;
  const stripRecs = options?.stripVetoedLegRecommendations !== false;

  // If a pick repeats a previously vetoed claim in its reasoning, that leg is also vetoed.
  if (Array.isArray(rep.picks) && vetoedClaims.length > 0) {
    const additionalTargets: VetoedLegTarget[] = [];
    for (const pk of rep.picks) {
      if (!pk || typeof pk !== 'object') {
        if (typeof pk === 'string' && findRepeatedVetoedClaimInClause(pk, vetoedClaims)) {
          const t = buildVetoTargetFromPick(pk, headers, rowMap, candidates, 'Vetoed claim repeated in pick.');
          if (t) additionalTargets.push(t);
        }
        continue;
      }
      const pkTexts = [
        pk.reason,
        pk.rationale,
        pk.edge,
        pk.note,
        pk.description,
        pk.claim,
        ...(Array.isArray(pk.reasons) ? pk.reasons : [])
      ].filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
      if (pkTexts.some(t => Boolean(findRepeatedVetoedClaimInClause(t, vetoedClaims)))) {
        const t = buildVetoTargetFromPick(pk, headers, rowMap, candidates, 'Vetoed claim repeated in pick reasoning.');
        if (t) additionalTargets.push(t);
      }
    }
    if (additionalTargets.length > 0) {
      vetoedTargets = mergeVetoedLegTargets(vetoedTargets, additionalTargets);
    }
  }

  if (Array.isArray(rep.picks)) {
    if (vetoedTargets.length > 0) {
      rep.picks = rep.picks.filter((pk: any) => !vetoedTargets.some(t => pickMatchesVetoedTarget(pk, t)));
    }
    for (const pk of rep.picks) {
      if (!pk || typeof pk !== 'object') continue;
      const sideHint = String(pk.side || pk.pick || pk.selection || pk.team || '');
      for (const field of ['reason', 'rationale', 'edge', 'note', 'description', 'claim'] as const) {
        if (typeof pk[field] === 'string' && pk[field].trim()) {
          pk[field] = cleanTextField(pk[field], sideHint, false);
        }
      }
      if (Array.isArray(pk.reasons)) {
        pk.reasons = pk.reasons
          .map((r: any) => (typeof r === 'string' ? cleanTextField(r, sideHint, false) : r))
          .filter((r: any) => typeof r !== 'string' || r.trim().length > 0);
      }
    }
  }

  if (Array.isArray(rep.scorecards)) {
    if (vetoedTargets.length > 0) {
      rep.scorecards = rep.scorecards.filter((sc: any) => !vetoedTargets.some(t => pickMatchesVetoedTarget(sc, t)));
    }
    for (const sc of rep.scorecards) {
      if (!sc || typeof sc !== 'object') continue;
      const sideHint = String(sc.pick || sc.side || '');
      for (const field of ['note', 'reason', 'summary'] as const) {
        if (typeof sc[field] === 'string' && sc[field].trim()) {
          sc[field] = cleanTextField(sc[field], sideHint, false);
        }
      }
    }
  }

  for (const field of ['summary', 'analysis', 'reason', 'rationale', 'conclusion'] as const) {
    if (typeof rep[field] === 'string' && rep[field].trim()) {
      rep[field] = cleanTextField(rep[field], undefined, stripRecs);
    }
  }

  if (Array.isArray(rep.insights)) {
    rep.insights = rep.insights
      .map((ins: any) => (typeof ins === 'string' ? cleanTextField(ins, undefined, stripRecs) : ins))
      .filter((ins: any) => typeof ins !== 'string' || ins.trim().length > 0);
  }
  if (Array.isArray(rep.anomalies)) {
    rep.anomalies = rep.anomalies
      .map((anom: any) => (typeof anom === 'string' ? cleanTextField(anom, undefined, false) : anom))
      .filter((anom: any) => typeof anom !== 'string' || anom.trim().length > 0);
  }
  if (Array.isArray(rep.components)) {
    for (const comp of rep.components) {
      if (!comp || typeof comp !== 'object' || !comp.props) continue;
      if (comp.type === 'InsightList' && Array.isArray(comp.props.insights)) {
        comp.props.insights = comp.props.insights
          .map((ins: any) => {
            if (typeof ins === 'string') return cleanTextField(ins, undefined, stripRecs);
            if (ins && typeof ins === 'object' && typeof ins.message === 'string') {
              return { ...ins, message: cleanTextField(ins.message, undefined, stripRecs) };
            }
            return ins;
          })
          .filter((ins: any) => {
            if (typeof ins === 'string') return ins.trim().length > 0;
            if (ins && typeof ins === 'object' && typeof ins.message === 'string') return ins.message.trim().length > 0;
            return true;
          });
      } else if (comp.type === 'MetricCard' && typeof comp.props.subtitle === 'string') {
        comp.props.subtitle = cleanTextField(comp.props.subtitle, undefined, stripRecs);
      } else if (comp.type === 'DataTable' && Array.isArray(comp.props.rows)) {
        const isRecs = isRecommendationTable(comp);
        if (isRecs && vetoedTargets.length > 0) {
          comp.props.rows = comp.props.rows.filter((row: any) => !vetoedTargets.some(t => dataTableRowMatchesTarget(row, t)));
        }
        for (const row of comp.props.rows) {
          if (!row || typeof row !== 'object') continue;
          for (const key of Object.keys(row)) {
            if (typeof row[key] === 'string' && row[key].trim()) {
              row[key] = cleanTextField(row[key], undefined, false);
            }
          }
        }
      }
    }
  }

  return report;
}

/**
 * Normalizes a report into a clean pass if all proposed picks were removed by Critic vetoes.
 */
export function normalizePassIfAllLegsVetoed<T extends Record<string, any>>(
  report: T,
  initialPickCount: number,
  hadVetoes: boolean
): T {
  if (!report || typeof report !== 'object') return report;
  const rep = report as Record<string, any>;
  if (initialPickCount > 0 && hadVetoes && Array.isArray(rep.picks) && rep.picks.length === 0) {
    rep.pass = true;
    rep.status = 'no_play';
    if (!rep.ui_title || !/insufficient|pass|no play/i.test(String(rep.ui_title))) {
      rep.ui_title = 'Pass';
    }
    if (typeof rep.summary !== 'string' || !rep.summary.trim()) {
      rep.summary = 'Pass: every proposed leg was vetoed during verification.';
    }
    if (typeof rep.analysis === 'string' && !rep.analysis.trim()) {
      rep.analysis = rep.summary;
    }
  }
  return report;
}
