import { parseGameHeaders, getEventIdForPick, type GameHeader } from '../context/gameHeaders.ts';
import {
  ESPN_TEAMS,
  extractAuthoritativeInjuries,
  matchTeamByLabel,
  normalizeSportHint,
  type AuthoritativeInjury,
  type EspnTeamEntry
} from './injuryAttribution.ts';
import { checkPickRowSideBinding, extractRowOptions, type RowOptionEntry } from './marketRowBinding.ts';
import { splitSentencesSafe } from '../parser/responseGuards.ts';

export const GROUNDING_RULE = `GROUNDING:
- Do not cite a score, goals-allowed, or health claim unless it is in a successful tool result.
- If key players on that team are OUT, do not call the team relatively healthy.
- A vetoed leg is removed from picks. Do not rewrite it as a recommended single bet.`;

export const FORM_GROUNDING_BULLETS = `- Do not cite a record, L2, or score unless it is in a successful tool result for that team.
- If you did not call the form tool, do not invent the record.
- If a tool returned data, do not say fundamentals or market data are missing.
- A pass is fine. Do not pad it with ungrounded form.`;

export const FORM_GROUNDING_RULE = `GROUNDING:
${FORM_GROUNDING_BULLETS}`;

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
    .replace(/\b(?:W-L|L\d{1,2}|record|ATS)\s*:?\s*\d{1,3}\s*-\s*\d{1,3}(?:\s*-\s*\d{1,3})?\b/gi, ' ')
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
  recordsByEventId: Map<string, Set<string>>;
  unscopedRecords: Set<string>;
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
    /\b(?:W-L|L\d{1,2}|last[\s_]?\d{1,2}|record|ATS|SU|home|away|road|overall|form|season)\b["']?\s*[:="']?\s*(\d{1,3})\s*-\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?\b/gi;
  let m: RegExpExecArray | null;
  while ((m = prefixRx.exec(norm)) !== null) {
    addGroundedRecordValue(records, m[1], m[2], m[3]);
  }

  const suffixRx =
    /\b(\d{1,3})\s*-\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?\s*(?:L\d{1,2}|W-L|ATS|SU|record|last\s+\d+|home|away|road|overall|season)\b/gi;
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
    for (const k of [2, 3, 4, 5]) {
      if (tokens.length >= k) {
        tally(tokens.slice(0, k));
        tally(tokens.slice(-k));
      }
    }
  }

  return records;
}

function resolveSegmentSideTeamKey(
  seg: string,
  eventId: string,
  headers: GameHeader[],
  candidates: TeamDescriptor[]
): string | undefined {
  if (!eventId) return undefined;
  const sideMatch = seg.match(/^(?:Home|Away)\s*(?:\(\s*(Home|Away)\s*\))?\s*[:\-]/i);
  if (!sideMatch) return undefined;
  const isHome = /^home\b/i.test(seg);
  const hdr = headers.find(h => h.eventId === eventId);
  if (!hdr) return undefined;
  const targetLabel = (isHome ? hdr.home : hdr.away).trim().toLowerCase();
  if (!targetLabel || /^(home|away|unknown|tbd)$/i.test(targetLabel)) return undefined;
  const eventCands = candidates.filter(c => c.eventIds.includes(eventId));
  const matched = eventCands.find(c =>
    c.nameAliases.includes(targetLabel) || c.allAliases.includes(targetLabel)
  );
  return matched?.key;
}

function extractGroundedRecords(
  successfulEvidence: string,
  candidates: TeamDescriptor[],
  headers: GameHeader[] = []
): GroundedRecordSet {
  const allRecords = new Set<string>();
  const recordsByTeamKey = new Map<string, Set<string>>();
  const recordsByEventId = new Map<string, Set<string>>();
  const unscopedRecords = new Set<string>();
  if (typeof successfulEvidence !== 'string' || !successfulEvidence) {
    return { allRecords, recordsByTeamKey, recordsByEventId, unscopedRecords };
  }

  const addToMapSet = (map: Map<string, Set<string>>, key: string, recs: Set<string>) => {
    let set = map.get(key);
    if (!set) {
      set = new Set<string>();
      map.set(key, set);
    }
    for (const r of recs) set.add(r);
  };

  const bindRecords = (seg: string, teamKeys: string[], eventId?: string) => {
    const recs = extractRecordsFromSegment(seg);
    if (recs.size === 0) return;
    for (const r of recs) allRecords.add(r);
    if (teamKeys.length === 1) {
      addToMapSet(recordsByTeamKey, teamKeys[0], recs);
    }
    if (eventId) {
      addToMapSet(recordsByEventId, eventId, recs);
    }
    if (teamKeys.length !== 1 && !eventId) {
      for (const r of recs) unscopedRecords.add(r);
    }
  };

  let currentEventId = '';
  for (const rawLine of successfulEvidence.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const evLineMatch =
      line.match(/^EVENT\s+([a-z0-9-]+)/i) ||
      line.match(/^===\s*GAME\s+DOSSIER:\s*([a-z0-9-]+)/i) ||
      line.match(/\[(?:MATCHUP FUNDAMENTALS|MARKET MOVEMENT|INJURY(?:\s*&\s*ROSTER\s*DELTA)?):\s*([a-z0-9-]+)/i) ||
      line.match(/\bevent_id\s*=\s*([a-z0-9-]+)/i);
    if (evLineMatch && evLineMatch[1]) {
      currentEventId = evLineMatch[1].trim();
    }

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
          bindRecords(seg.slice(start, end), [jsonTeamStarts[i].key], currentEventId || undefined);
        }
        continue;
      }

      const mentions = findTeamMentionsInText(seg, candidates);
      let uniqueKeys = Array.from(new Set(mentions.map(m => m.team.key)));
      if (uniqueKeys.length === 0 && currentEventId) {
        const sideKey = resolveSegmentSideTeamKey(seg, currentEventId, headers, candidates);
        if (sideKey) uniqueKeys = [sideKey];
      }

      if (uniqueKeys.length >= 2 && seg.includes('|')) {
        const subSegs = seg.split('|').map(s => s.trim()).filter(Boolean);
        let boundSub = false;
        let activeLineTeamKey: string | undefined;
        for (const sub of subSegs) {
          const subMentions = findTeamMentionsInText(sub, candidates);
          let subKeys = Array.from(new Set(subMentions.map(m => m.team.key)));
          if (subKeys.length === 0 && currentEventId) {
            const subSideKey = resolveSegmentSideTeamKey(sub, currentEventId, headers, candidates);
            if (subSideKey) subKeys = [subSideKey];
          }
          if (subKeys.length === 1) {
            activeLineTeamKey = subKeys[0];
          } else if (subKeys.length >= 2) {
            activeLineTeamKey = undefined;
          }
          const subRecs = extractRecordsFromSegment(sub);
          if (subRecs.size === 0) continue;
          const resolvedKeys = subKeys.length === 1
            ? subKeys
            : (subKeys.length === 0 && activeLineTeamKey && !/^\s*(?:INJ|Injuries)\s*:/i.test(sub)
                ? [activeLineTeamKey]
                : subKeys);
          bindRecords(sub, resolvedKeys, currentEventId || undefined);
          boundSub = true;
        }
        if (boundSub) continue;
      }

      bindRecords(seg, uniqueKeys, currentEventId || undefined);
    }
  }

  return { allRecords, recordsByTeamKey, recordsByEventId, unscopedRecords };
}

function findTargetTeamsForSpan(
  clause: string,
  matchStart: number,
  matchEnd: number,
  candidates: TeamDescriptor[],
  sideHint?: string
): TeamDescriptor[] {
  if (candidates.length === 0) return [];
  const mentions = findTeamMentionsInText(clause, candidates);
  if (mentions.length > 0) {
    const preceding = mentions.filter(m => m.end <= matchStart).sort((a, b) => a.end - b.end);
    if (preceding.length > 0) {
      const nearest = preceding[preceding.length - 1];
      const group: TeamDescriptor[] = [nearest.team];
      let prev = nearest;
      for (let i = preceding.length - 2; i >= 0; i--) {
        const curr = preceding[i];
        const gap = clause.slice(curr.end, prev.start);
        if (/^\s*(?:,|&|\/|\band\b)\s*$/i.test(gap)) {
          if (!group.some(t => t.key === curr.team.key)) {
            group.unshift(curr.team);
          }
          prev = curr;
        } else {
          break;
        }
      }
      return group;
    }
    const following = mentions.filter(m => m.start >= matchEnd);
    if (following.length > 0) {
      following.sort((a, b) => (a.start - matchEnd) - (b.start - matchEnd));
      return [following[0].team];
    }
  }
  if (sideHint) {
    const hintMentions = findTeamMentionsInText(sideHint, candidates);
    if (hintMentions.length > 0) return [hintMentions[0].team];
  }
  return [];
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
  const hasRec = (set?: Set<string>): boolean =>
    Boolean(set && (set.has(fullKey) || (!otl && set.has(shortKey))));

  if (team) {
    const teamSet = groundedRecords.recordsByTeamKey.get(team.key);
    if (teamSet && teamSet.size > 0) {
      return hasRec(teamSet);
    }
    const teamEventSets = team.eventIds
      .map(id => groundedRecords.recordsByEventId.get(id))
      .filter((s): s is Set<string> => Boolean(s && s.size > 0));
    if (teamEventSets.length > 0) {
      return teamEventSets.some(s => hasRec(s));
    }
    return hasRec(groundedRecords.unscopedRecords);
  }

  return hasRec(groundedRecords.allRecords);
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
    /\b(\d+(?:\.\d+)?)\+?\s+(?:goals?|points?|pts|runs?)\s+(?:allowed|against|conceded|surrendered|given\s+up)\b/gi,
    /\b(?:allowed|allowing|allows|gave\s+up|giving\s+up|gives\s+up|surrendered|surrendering|surrenders|conceded|conceding|concedes|yielded|yielding|yields)\s+(?:over\s+|nearly\s+|about\s+|around\s+|~)?(\d+(?:\.\d+)?)\+?\s+(?:goals?|points?|pts|runs?)\b/gi,
    /\b(?:scored|scoring|scores|netted|tallied|put\s+up|putting\s+up|posted|posting|held\s+to)\s+(?:over\s+|nearly\s+|about\s+|around\s+|~)?(\d+(?:\.\d+)?)\+?\s+(?:goals?|points?|pts|runs?|ppg|gpg|rpg)\b/gi,
    /\b(?:averaging|averages?|avg\.?)\s+(?:over\s+|nearly\s+|about\s+|around\s+|~)?(\d+(?:\.\d+)?)\+?\s*(?:ppg|gpg|rpg|pts\/g(?:m)?|points?\s+per\s+game|goals?\s+per\s+game|runs?\s+per\s+game|points?|pts|goals?|runs?)\b/gi,
    /\b(\d+(?:\.\d+)?)\+?\s*(?:ppg|gpg|rpg|pts\/g(?:m)?|GAA|GA\/G|goals\s+against\s+avg)\b/gi,
    /\b(\d+(?:\.\d+)?)\+?\s+(?:goals?|points?|pts|runs?)\s+(?:per\s+game|last\s+game|last\s+night|last\s+outing)\b/gi
  ];

  // If evidence is structured into EVENT blocks, allow team-scoped evidence verification so
  // another game's stat never falsely grounds a team whose game has no form tool result.
  const eventBlocks = cleanEvidence && /\bEVENT\s+[a-z0-9_-]+/i.test(cleanEvidence)
    ? cleanEvidence.split(/(?=\bEVENT\s+[a-z0-9_-]+)/i).filter(Boolean)
    : [];

  for (const rx of numberPatterns) {
    rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(norm)) !== null) {
      const val = m[1];
      let evidenceForStat = cleanEvidence;
      if (eventBlocks.length > 0 && candidates.length > 0) {
        const targetTeams = findTargetTeamsForSpan(norm, m.index, m.index + m[0].length, candidates, sideHint);
        const targetEventIds = Array.from(new Set(targetTeams.flatMap(t => t.eventIds).filter(Boolean)));
        if (targetEventIds.length > 0) {
          const matchingBlocks = eventBlocks.filter(blk => targetEventIds.some(id => blk.includes(id)));
          evidenceForStat = matchingBlocks.join('\n');
        }
      }
      if (!isNumericStatGrounded(val, evidenceForStat)) {
        const phrase = m[0].trim();
        const claims = [phrase];
        const shortPpg = phrase.match(/\b(\d+(?:\.\d+)?\+?\s*(?:ppg|gpg|rpg|points?\s+per\s+game))\b/i);
        if (shortPpg && shortPpg[1] && !claims.includes(shortPpg[1])) {
          claims.push(shortPpg[1]);
        }
        return {
          reason: `Ungrounded form/score claim ("${phrase}") not found in a successful tool result.`,
          claimTexts: claims
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
    /\b(\d{1,3})\s*-\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?\s*(?:(?:in\s+(?:their\s+|the\s+)?|over\s+(?:their\s+|the\s+)?)?(?:last|past)\s+\d{1,2}\b|(?:(?:in|over|across)\s+(?:their\s+|the\s+)?)?L\d{1,2}\b|W-L\b|ATS\b|SU\b|overall\b|(?:(?:away|home|road|season|overall)\s+)?record\b|on\s+the\s+(?:season|year|road)\b|at\s+home\b|form\b)/gi,
    /\b(?:L\d{1,2}|(?:last|past)\s+\d{1,2}\b|W-L|record(?:\s+of)?|ATS(?:\s+record)?|recent\s+form|form(?:\s+of)?)\s*(?::|=|is|are|was|were|at|of)?\s*(\d{1,3})\s*-\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?\b/gi
  ];
  if (hasSportsSignal) {
    recordPatterns.push(
      /\b(?:went|gone|going|sits(?:\s+at)?|stands(?:\s+at)?)\s+(\d{1,3})\s*-\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?(?![\s-]*(?:leg|legs|game|games|unit|units|pt|pts|point|points|goal|goals|run|runs|pick|picks|seat|seats|day|days|%))/gi
    );
  }

  const checkRecordMatch = (m: RegExpExecArray): FormClaimDetail | null => {
    const targetTeams = findTargetTeamsForSpan(norm, m.index, m.index + m[0].length, candidates, sideHint);
    const isGrounded = targetTeams.length > 0
      ? targetTeams.every(t => isRecordGrounded(m[1], m[2], m[3], t, groundedRecords))
      : isRecordGrounded(m[1], m[2], m[3], undefined, groundedRecords);
    if (!isGrounded) {
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
    return null;
  };

  for (const rx of recordPatterns) {
    rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(norm)) !== null) {
      const detail = checkRecordMatch(m);
      if (detail) return detail;
    }
  }

  if (hasSportsSignal && candidates.length > 0) {
    const copulaRx =
      /\b(?:is|are|was|were)\s+(\d{1,2})\s*-\s*(\d{1,2})(?:\s*-\s*(\d{1,2}))?(?![\s-]*(?:leg|legs|game|games|unit|units|pt|pts|point|points|goal|goals|run|runs|pick|picks|seat|seats|day|days|%|sentence|sentences|hour|hours|minute|minutes|month|months|week|weeks|star|stars|tier|tiers|round|rounds|attempt|attempts|book|books|team|teams|player|players|injur|out|questionable|doubtful|probable))/gi;
    let cm: RegExpExecArray | null;
    while ((cm = copulaRx.exec(norm)) !== null) {
      const preText = norm.slice(Math.max(0, cm.index - 20), cm.index);
      if (/\b(?:score|total|spread|line|margin|range|ratio|odds|price|rank|seed|tier|phase|attempt|between|from|down|up|trailing|leading|tied)\b/i.test(preText)) {
        continue;
      }
      const precedingMentions = findTeamMentionsInText(norm.slice(0, cm.index), candidates);
      const hasClosePrecedingTeam = precedingMentions.some(tm => cm!.index - tm.end <= 40);
      if (!hasClosePrecedingTeam) continue;
      const detail = checkRecordMatch(cm);
      if (detail) return detail;
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

const COLLEGE_STOP_TOKENS = new Set([
  'state', 'tech', 'university', 'college', 'north', 'south', 'east', 'west',
  'central', 'western', 'eastern', 'northern', 'southern', 'golden', 'blue',
  'red', 'green', 'black', 'white', 'crimson', 'city', 'team'
]);

function descriptorFromLabel(rawLabel: string, sportHint?: string, eventIds: string[] = []): TeamDescriptor | null {
  const clean = rawLabel.trim();
  if (!clean || /^(away|home|unknown|tbd)$/i.test(clean)) return null;
  const entry = matchTeamByLabel(clean, sportHint);
  if (entry) return descriptorFromEntry(entry, eventIds);
  const lower = clean.toLowerCase();
  const rawTokens = lower.split(/\s+/).filter(t => t.length >= 3 && !COLLEGE_STOP_TOKENS.has(t));
  const nameAliases = Array.from(new Set([lower, ...rawTokens]));
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

  // Exclude shared single-word tokens across raw/college teams (e.g. "owls" shared by Rice Owls & Temple Owls)
  const descriptors = Array.from(map.values());
  const rawDescriptors = descriptors.filter(d => d.key.startsWith('raw:'));
  if (rawDescriptors.length > 1) {
    const tokenCounts = new Map<string, number>();
    for (const rd of rawDescriptors) {
      const fullLower = rd.key.slice(4);
      const singleTokens = new Set(fullLower.split(/\s+/).filter(t => t.length >= 3));
      for (const tok of singleTokens) {
        tokenCounts.set(tok, (tokenCounts.get(tok) || 0) + 1);
      }
    }
    for (const rd of rawDescriptors) {
      const fullLower = rd.key.slice(4);
      rd.nameAliases = rd.nameAliases.filter(a => a === fullLower || (tokenCounts.get(a) || 0) < 2);
      rd.allAliases = Array.from(new Set([...rd.nameAliases, ...(rd.abbr ? [rd.abbr.toLowerCase()] : [])]));
    }
  }

  if (map.size === 0 && hasSportsSignal) {
    for (const entry of ESPN_TEAMS) {
      addDesc(descriptorFromEntry(entry));
    }
    return Array.from(map.values());
  }
  return descriptors;
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
  /\b(?:veto(?:ed|ing)?(?:\s+leg)?|reject(?:ed|ing)?(?:\s+leg)?|remov(?:ed|e)(?:\s+leg)?|drop(?:ped)?(?:\s+leg)?|disqualif(?:ied|y)|exclud(?:ed|e)|do\s+not\s+(?:bet|play|back|pick|recommend)|cannot\s+(?:bet|play|back|pick|recommend)|must\s+be\s+removed|fatal\s+injury|critical\s+roster\s+scratch|injury\s+misattribution|contra_steam_misread|symmetric_injury_misread|contra-?steam|symmetric-?injury|missing_(?:moneyline|spread|total)_coverage|missing\s+(?:moneyline|spread|total)\s+coverage|ungrounded|contradicted)\b/i;

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
      if (/\b(?:row|spread)\s+side\s+mismatch\b|\b(?:row|spread)_side_mismatch\b/i.test(trimmed)) continue;
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
  /\b(?:was\s+vetoed|were\s+vetoed|is\s+vetoed|vetoed|ruled\s+out|rejected|remov(?:ed|ing)|drop(?:ped|ping)|exclud(?:ed|ing)|prun(?:ed|ing)|stripp(?:ed|ing)|omitt(?:ed|ing)|filter(?:ed|ing)\s+out|disqualif(?:ied|y)|off\s+the\s+card|not\s+included|no\s+longer\s+(?:included|recommended|on\s+the\s+card)|not\s+recommend(?:ed|ing)|do\s+not\s+(?:bet|play|back|pick|recommend)|cannot\s+(?:bet|play|back|pick|recommend)|must\s+be\s+removed|avoid(?:ed|ing)?|skip(?:ped|ping)?|pass(?:ed|ing)?\s+on)\b/i;

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
    if (EXPLICIT_VETO_EXPLANATION_REGEX.test(sub) && !/\b(?:as\s+a\s+single|recommended\s+single|standalone\s+(?:bet|play|wager)|play\s+(?:it|that\s+leg)\s+as\s+a\s+single)\b/i.test(sub)) continue;

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
      if (kept.length === parts.length || kept.length === 0) return fullMatch;
      return kept.join(' + ');
    }
  );
}

function findVetoedLegRecommendationInClause(
  clause: string,
  vetoedTargets: VetoedLegTarget[],
  options?: { isInActiveTicketOrInsights?: boolean }
): { target: VetoedLegTarget; subClause: string } | null {
  if (!clause || vetoedTargets.length === 0) return null;
  const norm = normalizeText(clause);
  const subClauses = norm
    .split(
      /,\s*(?=(?:so|leaving|making|which\s+leaves|instead|after|while|whereas|because|since|although|though|but|however|following)\b)|;\s+|\s+(?=(?:after|because|since|while|whereas|although|though)\s+[^.;]{0,120}\b(?:vetoed|rejected|dropped|excluded|removed|ruled\s+out|pruned|stripped|omitted)\b)/i
    )
    .map(s => s.trim())
    .filter(Boolean);

  for (const sub of subClauses) {
    if (EXPLICIT_VETO_EXPLANATION_REGEX.test(sub)) continue;
    const matched = vetoedTargets.find(t => targetMatchesTextSpan(sub, t));
    if (!matched) continue;

    // P0-2: If the vetoed leg is absent from picks[], Selected Wagers, and InsightList,
    // and the enclosing clause is a rejection/explanation clause, do not treat it as an active recommendation.
    if (!options?.isInActiveTicketOrInsights && EXPLICIT_VETO_EXPLANATION_REGEX.test(norm)) {
      continue;
    }

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
    curatedDossier?: string | { sections?: Array<{ tool?: string; event_id?: string; summary?: string }> };
  }
): GroundingAuditResult {
  if (!proposal) return { pass: true, violations: [], flags: [] };

  const headers = options?.headers && options.headers.length > 0
    ? options.headers
    : parseGameHeaders(slateText);
  const rowMap = extractRowOptions([slateText], headers);

  let curatedDossierText = '';
  if (typeof options?.curatedDossier === 'string') {
    curatedDossierText = options.curatedDossier.trim();
  } else if (options?.curatedDossier && Array.isArray(options.curatedDossier.sections)) {
    curatedDossierText = options.curatedDossier.sections
      .map(s => {
        const sum = typeof s?.summary === 'string' ? s.summary.trim() : '';
        if (!sum) return '';
        return s.event_id && !sum.includes(s.event_id) ? `EVENT ${s.event_id}\n${sum}` : sum;
      })
      .filter(Boolean)
      .join('\n\n');
  }
  const combinedEvidenceInput = [curatedDossierText, evidenceText].filter(Boolean).join('\n\n');

  const successfulEvidence = extractSuccessfulEvidenceText(combinedEvidenceInput);
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
  // P0-1: Build record corpus from authoritative Hop-1 curatedDossier/tool summaries unioned with COMPACT SLATE.
  const groundedRecords = extractGroundedRecords(successfulEvidence, candidates, headers);
  if (typeof slateText === 'string' && slateText.trim().length > 0) {
    const slateRecords = extractGroundedRecords(slateText, candidates, headers);
    for (const r of slateRecords.allRecords) groundedRecords.allRecords.add(r);
    for (const [k, recs] of slateRecords.recordsByTeamKey.entries()) {
      let set = groundedRecords.recordsByTeamKey.get(k);
      if (!set) {
        set = new Set<string>();
        groundedRecords.recordsByTeamKey.set(k, set);
      }
      for (const r of recs) set.add(r);
    }
    for (const [ev, recs] of slateRecords.recordsByEventId.entries()) {
      let set = groundedRecords.recordsByEventId.get(ev);
      if (!set) {
        set = new Set<string>();
        groundedRecords.recordsByEventId.set(ev, set);
      }
      for (const r of recs) set.add(r);
    }
  }
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

  let vetoedInActiveTicketOrInsights = false;
  if (typeof proposal === 'object' && vetoedTargets.length > 0) {
    if (Array.isArray(proposal.picks)) {
      for (const pk of proposal.picks) {
        const matched = vetoedTargets.find(t => pickMatchesVetoedTarget(pk, t));
        if (matched) {
          vetoedInActiveTicketOrInsights = true;
          addViolation(
            'vetoed_leg_kept',
            `Vetoed leg (${matched.rowId || matched.teamLabel || 'pick'}) must be removed from picks.`
          );
          recordVetoedLeg(matched);
        }
      }
    }
    if (Array.isArray(proposal.components)) {
      for (const comp of proposal.components) {
        if (!comp || typeof comp !== 'object' || !comp.props) continue;
        if (comp.type === 'DataTable' && isRecommendationTable(comp) && Array.isArray(comp.props.rows)) {
          for (const row of comp.props.rows) {
            if (row && typeof row === 'object' && vetoedTargets.some(t => dataTableRowMatchesTarget(row, t))) {
              vetoedInActiveTicketOrInsights = true;
            }
          }
        } else if (comp.type === 'InsightList' && Array.isArray(comp.props.insights)) {
          for (const ins of comp.props.insights) {
            const msg = typeof ins === 'string' ? ins : ins?.message;
            if (typeof msg === 'string' && !EXPLICIT_VETO_EXPLANATION_REGEX.test(msg) && vetoedTargets.some(t => targetMatchesTextSpan(msg, t))) {
              vetoedInActiveTicketOrInsights = true;
            }
          }
        }
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
        const legRec = findVetoedLegRecommendationInClause(clause, vetoedTargets, {
          isInActiveTicketOrInsights: vetoedInActiveTicketOrInsights
        });
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

  const premiseAudit = auditCriticPremiseContradictions(proposal, evidenceText, slateText, {
    headers
  });
  if (!premiseAudit.pass) {
    for (const f of premiseAudit.flags) {
      if (!flags.includes(f)) flags.push(f);
    }
    for (const v of premiseAudit.violations) {
      if (!violations.includes(v)) violations.push(v);
    }
    if (Array.isArray(premiseAudit.vetoedLegs)) {
      for (const leg of premiseAudit.vetoedLegs) recordVetoedLeg(leg);
    }
    if (Array.isArray(premiseAudit.vetoedClaims)) {
      recordClaims(premiseAudit.vetoedClaims);
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

interface ParsedSteamEntry {
  eventId?: string;
  marketKind: 'moneyline' | 'spread' | 'total';
  towardRole?: 'home' | 'away' | 'over' | 'under';
  towardTeam?: string;
  towardDesc?: TeamDescriptor;
  againstRole?: 'home' | 'away' | 'over' | 'under';
  againstTeam?: string;
  againstDesc?: TeamDescriptor;
  impliedShiftPp?: number;
}

interface ParsedInjuryBalanceEntry {
  eventId: string;
  homeTeam?: string;
  homeOut: number;
  homeQ: number;
  awayTeam?: string;
  awayOut: number;
  awayQ: number;
  healthBalance:
    | 'symmetric'
    | 'home_advantage'
    | 'away_advantage'
    | 'conditional_home_advantage'
    | 'conditional_away_advantage'
    | 'uncertain_questionable'
    | 'single_team_only';
}

const STEAM_TOPIC_REGEX =
  /\b(?:steam|line\s+move(?:ment)?|market\s+(?:steam|move(?:ment)?|money|action)|sharp\s+(?:money|steam|action)|RLM)\b/i;

const CONTRA_STEAM_CONTRARIAN_REGEX =
  /\b(?:despite|fading|fade|contrarian|counter-?steam|negative\s+steam|opposing\s+steam|(?:moves?|moving|moved|steamed|going|betting|is)\s+against|against\s+(?:the\s+)?(?:market\s+)?(?:steam|line\s+move(?:ment)?|sharp\s+(?:money|action|steam)))\b/i;

const FAVORABLE_STEAM_CLAIM_REGEX =
  /\b(?:favorable\s+(?:market\s+)?steam|(?:market\s+|sharp\s+)?steam\s+(?:is\s+|has\s+been\s+)?(?:moves?|moving|moved|backs?|backing|supports?|supporting|favors?|favoring|on|for|behind|toward|towards)\b|(?:sharp|market)\s+(?:money|action|movement|line\s+move(?:ment)?)\s+(?:is\s+)?(?:moves?|moving|moved|backs?|backing|supports?|supporting|favors?|favoring|toward|towards|on)\b|backing\s+(?:heavy\s+)?(?:market\s+)?steam|following\s+(?:the\s+)?steam|aligned\s+with\s+(?:the\s+)?(?:market\s+)?steam|steam\s+(?:confirmation|support|play)|line\s+move(?:ment)?\s+(?:favors?|supports?|backs?|moves?\s+toward))\b/i;

const HEALTH_ADVANTAGE_CLAIM_REGEX =
  /\b(?:health\s+(?:advantage|edge)|injury\s+(?:advantage|edge)|healthier\s+(?:side|team|roster|squad)|cleaner\s+injury\s+report|relatively\s+healthy|availability\s+(?:advantage|edge)|roster\s+(?:health\s+)?(?:advantage|edge)|fewer\s+injuries)\b/i;

const HEALTH_BALANCED_ACK_REGEX =
  /\b(?:no\s+(?:health|injury)\s+(?:advantage|edge)|without\s+(?:a|an)\s+(?:health|injury)\s+(?:advantage|edge)|not\s+(?:a|an)\s+(?:health|injury)\s+(?:advantage|edge)|neither\s+team\s+(?:is\s+healthier|has\s+an?\s+(?:injury|health)\s+(?:advantage|edge))|symmetric|evenly\s+(?:matched|depleted)|equally\s+(?:depleted|banged\s+up|short-?handed)|offsetting\s+injuries|both\s+(?:teams|[A-Za-z .'-]{2,35}\s+and\s+[A-Za-z .'-]{2,35})\s+(?:have|are\s+(?:missing|dealing\s+with|down|without)|miss(?:ing)?))\b/i;

const DEPLETION_MENTION_REGEX =
  /\b(?:missing|out|injured|depleted|decimated|shorthanded|short-?handed|banged\s+up|availability|without|scratches|players?\s+out|rotation\s+players?|starters?\s+out)\b/i;

function extractLineEventId(line: string): string | undefined {
  const m =
    line.match(/^EVENT\s+([a-z0-9-]+)/i) ||
    line.match(/===\s*GAME DOSSIER:\s*([a-z0-9-]+)/i) ||
    line.match(/\[(?:MARKET\s+MOVEMENT|INJURY[^:\]]*|MATCHUP[^:\]]*):\s*([a-z0-9-]+)/i) ||
    line.match(/\bevent_id\s*=\s*([a-z0-9-]+)/i) ||
    line.match(/\b((?:nba|nhl|nfl|mlb|ncaab|ncaaf|wnba|epl|mls)-[a-z0-9-]+)\b/i);
  return m?.[1];
}

function cleanSteamTeamLabel(raw: string): string {
  return raw
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s+(?:ML|moneyline|spread)\s*$/i, '')
    .trim();
}

function descriptorMatchesHeaderSide(desc: TeamDescriptor | undefined, headerSide: string, candidates: TeamDescriptor[]): boolean {
  if (!headerSide) return false;
  if (desc) {
    const lowerSide = headerSide.toLowerCase();
    if (desc.allAliases.some(a => lowerSide === a || (a.length >= 4 && lowerSide.includes(a)))) {
      return true;
    }
  }
  const sideDesc = findTeamMentionsInText(headerSide, candidates)[0]?.team;
  return Boolean(desc && sideDesc && desc.key === sideDesc.key);
}

function inferPickedRoleAndTeam(
  pickText: string,
  header: GameHeader | undefined,
  eventCandidates: TeamDescriptor[],
  allCandidates: TeamDescriptor[]
): {
  pickedRole?: 'home' | 'away' | 'over' | 'under';
  pickedDesc?: TeamDescriptor;
  pickedTeamLabel?: string;
  isTotal: boolean;
} {
  if (/\bover\b/i.test(pickText) && !/\bML\b/i.test(pickText) && !/\bovertime\b/i.test(pickText)) {
    return { pickedRole: 'over', pickedTeamLabel: 'Over', isTotal: true };
  }
  if (/\bunder\b/i.test(pickText) && !/\bML\b/i.test(pickText)) {
    return { pickedRole: 'under', pickedTeamLabel: 'Under', isTotal: true };
  }

  const pool = eventCandidates.length > 0 ? eventCandidates : allCandidates;
  const pickedDesc = findTeamMentionsInText(pickText, pool)[0]?.team;
  let pickedRole: 'home' | 'away' | undefined;
  if (header) {
    if (descriptorMatchesHeaderSide(pickedDesc, header.away, pool) || /^\s*away\b/i.test(pickText)) {
      pickedRole = 'away';
    } else if (descriptorMatchesHeaderSide(pickedDesc, header.home, pool) || /^\s*home\b/i.test(pickText)) {
      pickedRole = 'home';
    }
  } else if (/^\s*away\b/i.test(pickText)) {
    pickedRole = 'away';
  } else if (/^\s*home\b/i.test(pickText)) {
    pickedRole = 'home';
  }

  const pickedTeamLabel =
    pickedDesc?.label ||
    (pickedRole === 'home' ? header?.home : pickedRole === 'away' ? header?.away : undefined);

  return { pickedRole, pickedDesc, pickedTeamLabel, isTotal: false };
}

function extractImpliedShiftPpFromParen(parenText: string): number | undefined {
  if (!parenText) return undefined;
  const m = parenText.match(/([+-]?\d+(?:\.\d+)?)\s*(?:pp\s*implied|%\s*imp(?:lied)?)\b/i);
  if (!m) return undefined;
  const val = Math.abs(parseFloat(m[1]));
  return Number.isFinite(val) ? val : undefined;
}

const FABRICATED_STEAM_SHIFT_RX =
  /(\b(?:positive\s+|favorable\s+|negative\s+|sharp\s+|market\s+)?(?:steam|line\s+move(?:ment)?|market\s+move(?:ment)?|implied(?:\s+prob(?:ability)?)?)\b[^.;\n]{0,45}?)([+-]?\d+(?:\.\d+)?)\s*(%|pp)\s*(shift|move|swing|delta|implied(?:\s+shift)?|imp|increase|jump|gain)?/gi;

function findFabricatedSteamShiftInClause(
  clause: string,
  actualShiftPp: number,
): { rawClaim: string; claimed: number } | null {
  if (!clause || !Number.isFinite(actualShiftPp)) return null;
  FABRICATED_STEAM_SHIFT_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FABRICATED_STEAM_SHIFT_RX.exec(clause)) !== null) {
    const prefix = m[1] || '';
    const numStr = m[2];
    const unit = m[3];
    const suffix = m[4] || '';
    const hasExplicitSteamContext =
      Boolean(suffix) || /\bimplied\b/i.test(prefix) || /\bsteam\b/i.test(prefix);
    if (!hasExplicitSteamContext) continue;
    if (unit === '%' && !suffix && !/\bimplied\b/i.test(prefix)) continue;
    const claimed = Math.abs(parseFloat(numStr));
    if (!Number.isFinite(claimed)) continue;
    if (Math.abs(claimed - actualShiftPp) > 2.5) {
      return { rawClaim: `${numStr}${unit}${suffix ? ` ${suffix}` : ''}`, claimed };
    }
  }
  return null;
}

function rewriteFabricatedSteamShiftInText(text: string, actualShiftPp: number): { text: string; changed: boolean } {
  if (!text || !Number.isFinite(actualShiftPp)) return { text, changed: false };
  const targetStr = `+${actualShiftPp.toFixed(1)}pp implied`;
  let changed = false;
  const next = text.replace(FABRICATED_STEAM_SHIFT_RX, (full, prefix, numStr, unit, suffix) => {
    const hasExplicitSteamContext =
      Boolean(suffix) || /\bimplied\b/i.test(prefix) || /\bsteam\b/i.test(prefix);
    if (!hasExplicitSteamContext) return full;
    if (unit === '%' && !suffix && !/\bimplied\b/i.test(prefix)) return full;
    const claimed = Math.abs(parseFloat(numStr));
    if (!Number.isFinite(claimed) || Math.abs(claimed - actualShiftPp) <= 2.5) {
      return full;
    }
    changed = true;
    const suffixClean = suffix && !/^(?:implied|imp)$/i.test(suffix.trim()) ? ` ${suffix.trim()}` : '';
    return `${prefix}${targetStr}${suffixClean}`;
  });
  return { text: next, changed };
}

function parseSteamEntriesFromEvidence(
  successfulEvidence: string,
  headers: GameHeader[],
  candidates: TeamDescriptor[]
): ParsedSteamEntry[] {
  const entries: ParsedSteamEntry[] = [];
  if (!successfulEvidence) return entries;

  let currentEventId: string | undefined = headers.length === 1 ? headers[0].eventId : undefined;
  for (const rawLine of successfulEvidence.split(/\r?\n/)) {
    const line = normalizeText(rawLine.trim());
    if (!line) continue;
    const lineEv = extractLineEventId(line);
    if (lineEv) currentEventId = lineEv;
    if (!/\b(?:TOWARD|Steam:)/i.test(line)) continue;

    const eventId = lineEv || currentEventId;
    const eventCands = eventId
      ? candidates.filter(c => c.eventIds.length === 0 || c.eventIds.includes(eventId))
      : candidates;
    const pool = eventCands.length > 0 ? eventCands : candidates;
    const hdr = eventId ? headers.find(h => h.eventId === eventId) : undefined;

    for (const seg of line.split(/;\s+/)) {
      let matchedStructured = false;
      const twoWayRx =
        /\bTOWARD\s+(home|away)\s+([^|(;\n]+?)(?:\s*(\([^)\n]*\)))?\s*\|\s*AGAINST\s+(home|away)\s+([^|(\n;]+?)(?:\s*(\([^)\n]*\)))?(?=$|;|\n|\s*\|)/gi;
      let m: RegExpExecArray | null;
      while ((m = twoWayRx.exec(seg)) !== null) {
        matchedStructured = true;
        const towardRole = m[1].toLowerCase() as 'home' | 'away';
        const towardRaw = m[2].trim();
        const towardParen = m[3] || '';
        const againstRole = m[4].toLowerCase() as 'home' | 'away';
        const againstRaw = m[5].trim();
        const towardTeam = cleanSteamTeamLabel(towardRaw);
        const againstTeam = cleanSteamTeamLabel(againstRaw);
        const impliedShiftPp = extractImpliedShiftPpFromParen(towardParen);
        const marketKind: 'moneyline' | 'spread' =
          /\bML\b/i.test(`${towardRaw} ${againstRaw}`) || /(?:%\s*imp|pp\s*implied)/i.test(towardParen) ? 'moneyline' : 'spread';
        const towardDesc = findTeamMentionsInText(towardTeam, pool)[0]?.team || (matchTeamByLabel(towardTeam) ? descriptorFromEntry(matchTeamByLabel(towardTeam)!) : undefined);
        const againstDesc = findTeamMentionsInText(againstTeam, pool)[0]?.team || (matchTeamByLabel(againstTeam) ? descriptorFromEntry(matchTeamByLabel(againstTeam)!) : undefined);
        entries.push({
          ...(eventId ? { eventId } : {}),
          marketKind,
          towardRole,
          towardTeam,
          ...(towardDesc ? { towardDesc } : {}),
          againstRole,
          againstTeam,
          ...(againstDesc ? { againstDesc } : {}),
          ...(impliedShiftPp !== undefined ? { impliedShiftPp } : {})
        });
      }

      const totalRx = /\bTOWARD\s+(over|under)\b([^;\n]*)/gi;
      while ((m = totalRx.exec(seg)) !== null) {
        matchedStructured = true;
        const towardRole = m[1].toLowerCase() as 'over' | 'under';
        entries.push({
          ...(eventId ? { eventId } : {}),
          marketKind: 'total',
          towardRole,
          towardTeam: towardRole === 'over' ? 'Over' : 'Under',
          againstRole: towardRole === 'over' ? 'under' : 'over',
          againstTeam: towardRole === 'over' ? 'Under' : 'Over'
        });
      }

      if (!matchedStructured) {
        const oneWayToward = /\bTOWARD\s+(home|away)\s+([^|(;\n]+?)(?:\s*(\([^)\n]*\)))?(?=$|;|\n|\s*\|)/i.exec(seg);
        const legacySteam = !oneWayToward ? /\bSteam:\s*(home|away)\s+([^(\n;]+?)(?:\s*(\([^)\n]*\)))?(?=$|;|\n|\s*\|)/i.exec(seg) : null;
        const sm = oneWayToward || legacySteam;
        if (sm) {
          const towardRole = sm[1].toLowerCase() as 'home' | 'away';
          const towardRaw = sm[2].trim();
          const towardParen = sm[3] || '';
          const towardTeam = cleanSteamTeamLabel(towardRaw);
          const againstRole: 'home' | 'away' = towardRole === 'home' ? 'away' : 'home';
          const againstTeam = hdr ? (againstRole === 'home' ? hdr.home : hdr.away) : undefined;
          const impliedShiftPp = extractImpliedShiftPpFromParen(towardParen);
          const marketKind: 'moneyline' | 'spread' =
            /\bML\b/i.test(towardRaw) || /(?:%\s*imp|pp\s*implied)/i.test(towardParen) ? 'moneyline' : 'spread';
          const towardDesc = findTeamMentionsInText(towardTeam, pool)[0]?.team;
          const againstDesc = againstTeam ? findTeamMentionsInText(againstTeam, pool)[0]?.team : undefined;
          entries.push({
            ...(eventId ? { eventId } : {}),
            marketKind,
            towardRole,
            towardTeam,
            ...(towardDesc ? { towardDesc } : {}),
            againstRole,
            ...(againstTeam ? { againstTeam } : {}),
            ...(againstDesc ? { againstDesc } : {}),
            ...(impliedShiftPp !== undefined ? { impliedShiftPp } : {})
          });
        }
      }
    }
  }
  return entries;
}

function parseInjuryBalanceFromEvidence(
  successfulEvidence: string,
  headers: GameHeader[],
  allInjuries: AuthoritativeInjury[],
  candidates: TeamDescriptor[]
): Map<string, ParsedInjuryBalanceEntry> {
  const byEvent = new Map<string, ParsedInjuryBalanceEntry>();
  if (successfulEvidence) {
    let currentEventId: string | undefined = headers.length === 1 ? headers[0].eventId : undefined;
    for (const rawLine of successfulEvidence.split(/\r?\n/)) {
      const line = normalizeText(rawLine.trim());
      if (!line) continue;
      const lineEv = extractLineEventId(line);
      if (lineEv) currentEventId = lineEv;
      const sm = line.match(
        /Summary:\s*(.+?)\s*\((\d+)\s+OUT(?:\s*\[[^\]]*\])?,\s*(\d+)\s+Q\)\s+vs\s+(.+?)\s*\((\d+)\s+OUT(?:\s*\[[^\]]*\])?,\s*(\d+)\s+Q\)\s*\|\s*Health\s+Balance:\s*(symmetric|home_advantage|away_advantage|conditional_home_advantage|conditional_away_advantage|uncertain_questionable|single_team_only)/i
      );
      if (sm && (lineEv || currentEventId)) {
        const eventId = lineEv || currentEventId!;
        byEvent.set(eventId, {
          eventId,
          homeTeam: sm[1].trim(),
          homeOut: Number(sm[2]),
          homeQ: Number(sm[3]),
          awayTeam: sm[4].trim(),
          awayOut: Number(sm[5]),
          awayQ: Number(sm[6]),
          healthBalance: sm[7].toLowerCase() as ParsedInjuryBalanceEntry['healthBalance']
        });
      }
    }
  }

  for (const h of headers) {
    if (!h.eventId || byEvent.has(h.eventId)) continue;
    const evInjuries = allInjuries.filter(inj => inj.eventId === h.eventId);
    if (evInjuries.length === 0) continue;
    const eventCands = candidates.filter(c => c.eventIds.length === 0 || c.eventIds.includes(h.eventId));
    const pool = eventCands.length > 0 ? eventCands : candidates;
    let homeOut = 0;
    let homeQ = 0;
    let awayOut = 0;
    let awayQ = 0;
    let homeSeen = false;
    let awaySeen = false;
    for (const inj of evInjuries) {
      const injDesc = inj.teamEntry
        ? descriptorFromEntry(inj.teamEntry, [h.eventId])
        : findTeamMentionsInText(inj.teamLabel, pool)[0]?.team;
      const isHome = descriptorMatchesHeaderSide(injDesc, h.home, pool) || normalizeText(inj.teamLabel).toLowerCase() === normalizeText(h.home).toLowerCase();
      const isAway = !isHome && (descriptorMatchesHeaderSide(injDesc, h.away, pool) || normalizeText(inj.teamLabel).toLowerCase() === normalizeText(h.away).toLowerCase());
      const isOut = /^(?:OUT|IR|INJURED\s+RESERVE|SUSPENDED)$/i.test(inj.status);
      const isQ = /^(?:Q|QUESTIONABLE|DOUBTFUL|DAY-TO-DAY|GTD)$/i.test(inj.status);
      if (isHome) {
        homeSeen = true;
        if (isOut) homeOut++;
        else if (isQ) homeQ++;
      } else if (isAway) {
        awaySeen = true;
        if (isOut) awayOut++;
        else if (isQ) awayQ++;
      }
    }
    if (!homeSeen || !awaySeen) continue;
    const homeTotal = homeOut + homeQ;
    const awayTotal = awayOut + awayQ;
    const homeNominalBetter = (awayOut - homeOut >= 2) || (awayTotal - homeTotal >= 2 && homeQ === 0);
    const awayNominalBetter = (homeOut - awayOut >= 2) || (homeTotal - awayTotal >= 2 && awayQ === 0);
    const isFootball = /^(?:nfl|ncaaf|college-football)-|\b(?:nfl|ncaaf|americanfootball_nfl|americanfootball_ncaaf)\b/i.test(`${h.sport || ''} ${h.eventId}`);
    const qCap = isFootball ? 3 : 2;
    let healthBalance: ParsedInjuryBalanceEntry['healthBalance'];
    if (homeNominalBetter && !awayNominalBetter) {
      if (homeQ >= qCap) {
        healthBalance = (awayOut - homeOut >= 6 && homeQ === qCap) ? 'conditional_home_advantage' : 'uncertain_questionable';
      } else {
        healthBalance = 'home_advantage';
      }
    } else if (awayNominalBetter && !homeNominalBetter) {
      if (awayQ >= qCap) {
        healthBalance = (homeOut - awayOut >= 6 && awayQ === qCap) ? 'conditional_away_advantage' : 'uncertain_questionable';
      } else {
        healthBalance = 'away_advantage';
      }
    } else if (homeQ >= qCap && awayQ >= qCap) {
      healthBalance = 'uncertain_questionable';
    } else {
      healthBalance = 'symmetric';
    }
    byEvent.set(h.eventId, {
      eventId: h.eventId,
      homeTeam: h.home,
      homeOut,
      homeQ,
      awayTeam: h.away,
      awayOut,
      awayQ,
      healthBalance
    });
  }

  return byEvent;
}

/**
 * Deterministically audits proposed picks and rationales for contra-steam misreads
 * and symmetric/disadvantaged-injury misreads against retrieved market & injury evidence.
 */
export function auditCriticPremiseContradictions(
  proposal: any,
  evidenceText: string,
  slateText: string = '',
  options?: {
    headers?: GameHeader[];
  }
): GroundingAuditResult {
  if (!proposal) return { pass: true, violations: [], flags: [] };

  const headers = options?.headers && options.headers.length > 0
    ? options.headers
    : parseGameHeaders(slateText);
  const rowMap = extractRowOptions([slateText], headers);
  const successfulEvidence = extractSuccessfulEvidenceText(evidenceText);
  if (!successfulEvidence && rowMap.size === 0) return { pass: true, violations: [], flags: [] };

  const rawProposalText = typeof proposal === 'string' ? proposal : JSON.stringify(proposal);
  const hasSportsSignal =
    headers.length > 0 ||
    SPORTS_CONTEXT_REGEX.test(rawProposalText) ||
    SPORTS_CONTEXT_REGEX.test(slateText || '') ||
    Boolean(successfulEvidence);

  const allInjuries = successfulEvidence ? extractAuthoritativeInjuries(successfulEvidence, slateText) : [];
  const outInjuries = allInjuries.filter(inj => /^(?:OUT|IR|INJURED\s+RESERVE|SUSPENDED)$/i.test(inj.status));
  const candidates = buildTeamDescriptors(headers, outInjuries, hasSportsSignal);

  const steamEntries = successfulEvidence ? parseSteamEntriesFromEvidence(successfulEvidence, headers, candidates) : [];
  const injuryBalances = successfulEvidence ? parseInjuryBalanceFromEvidence(successfulEvidence, headers, allInjuries, candidates) : new Map();

  if (rowMap.size === 0 && steamEntries.length === 0 && injuryBalances.size === 0) {
    return { pass: true, violations: [], flags: [] };
  }

  const violations: string[] = [];
  const flags: string[] = [];
  const vetoedLegs: VetoedLegTarget[] = [];
  const vetoedClaims: string[] = [];

  const addFinding = (flag: string, msg: string, target: VetoedLegTarget | null, clause?: string) => {
    if (!flags.includes(flag)) flags.push(flag);
    if (!violations.includes(msg)) violations.push(msg);
    if (target) vetoedLegs.push(target);
    if (clause && !vetoedClaims.some(c => c.toLowerCase() === clause.toLowerCase())) {
      vetoedClaims.push(clause.slice(0, 140));
    }
  };

  const evaluateLeg = (
    pk: any,
    sideText: string,
    reasonTexts: string[]
  ) => {
    // 0. Deterministic row_side_mismatch pre-check BEFORE resolving rowEntry.eventId,
    // contra_steam_misread, symmetric_injury_misread, or duplicate_leg checks.
    const rowCheck = checkPickRowSideBinding(pk, rowMap);
    if (!rowCheck.valid && rowCheck.rowId) {
      const msg = `row_side_mismatch: ${rowCheck.reason}`;
      addFinding(
        'row_side_mismatch',
        msg,
        {
          rowId: rowCheck.rowId,
          ...(rowCheck.rowEntry?.eventId ? { eventId: rowCheck.rowEntry.eventId } : {}),
          ...(rowCheck.rowEntry?.text ? { teamLabel: rowCheck.rowEntry.text } : {}),
          teamAliases: [],
          reason: msg.slice(0, 140)
        },
        rowCheck.reason
      );
      return;
    }

    const combinedReasons = normalizeText(reasonTexts.filter(Boolean).join('. ')).trim();
    if (!combinedReasons || (steamEntries.length === 0 && injuryBalances.size === 0)) return;

    const rowMatch = sideText.match(/\b(R\d+)\b/i) || (typeof pk?.row === 'string' ? pk.row.match(/\b(R\d+)\b/i) : null);
    const rowId = rowMatch ? rowMatch[1].toUpperCase() : undefined;
    const rowEntry = rowId ? rowMap.get(rowId) : undefined;
    const fullPickText = [sideText, rowEntry?.text].filter(Boolean).join(' ');

    let eventId =
      (typeof pk === 'object' ? getEventIdForPick(pk, headers) : undefined) ||
      rowEntry?.eventId;
    if (!eventId) {
      const m = findTeamMentionsInText(fullPickText, candidates)[0]?.team;
      if (m && m.eventIds.length === 1) eventId = m.eventIds[0];
    }
    if (!eventId && headers.length === 1) eventId = headers[0].eventId;

    const header = eventId ? headers.find(h => h.eventId === eventId) : undefined;
    const eventCands = eventId
      ? candidates.filter(c => c.eventIds.length === 0 || c.eventIds.includes(eventId))
      : candidates;
    const pool = eventCands.length > 0 ? eventCands : candidates;
    const { pickedRole, pickedDesc, pickedTeamLabel, isTotal } = inferPickedRoleAndTeam(
      fullPickText,
      header,
      eventCands,
      candidates
    );

    const clauses = combinedReasons.split(/(?<=[.!?])\s+|\n+|;\s+/).map(c => c.trim()).filter(Boolean);
    const pickDisplay = pickedTeamLabel || rowId || sideText || 'pick';

    // 1. Check contra-steam misread
    const relevantSteam = steamEntries.filter(se => {
      if (eventId && se.eventId && se.eventId !== eventId) return false;
      if (isTotal) return se.marketKind === 'total';
      if (se.marketKind === 'total') return false;
      if (/\bML\b/i.test(fullPickText) && steamEntries.some(x => x.eventId === se.eventId && x.marketKind === 'moneyline')) {
        return se.marketKind === 'moneyline';
      }
      if (/[+-]\d+(?:\.5)?/.test(fullPickText) && !/\bML\b/i.test(fullPickText) && steamEntries.some(x => x.eventId === se.eventId && x.marketKind === 'spread')) {
        return se.marketKind === 'spread';
      }
      return true;
    });

    for (const se of relevantSteam) {
      const isPickingAgainst = isTotal
        ? (pickedRole === 'over' || pickedRole === 'under') && pickedRole === se.againstRole
        : Boolean(
            (pickedRole && se.againstRole && pickedRole === se.againstRole) ||
            (pickedDesc && se.againstDesc && pickedDesc.key === se.againstDesc.key)
          );
      if (!isPickingAgainst) continue;

      for (const clause of clauses) {
        if (!STEAM_TOPIC_REGEX.test(clause)) continue;
        if (CONTRA_STEAM_CONTRARIAN_REGEX.test(clause)) continue;
        if (!FAVORABLE_STEAM_CLAIM_REGEX.test(clause)) continue;

        const targetedMentions = findTeamMentionsInText(clause, pool).map(m => m.team);
        const explicitlyTargetsTowardSide = !isTotal && se.towardDesc
          ? targetedMentions.some(t => t.key === se.towardDesc!.key) &&
            !(pickedDesc && targetedMentions.some(t => t.key === pickedDesc.key)) &&
            /\b(?:toward|towards|backs?|backing|supports?|supporting|favors?|favoring|on)\s+/i.test(clause)
          : false;
        const explicitlyTargetsAgainstTotal = isTotal && se.towardRole && new RegExp(`\\btoward\\s+${se.towardRole}\\b`, 'i').test(clause);

        if (explicitlyTargetsTowardSide || explicitlyTargetsAgainstTotal) continue;

        const msg = `contra_steam_misread: Pick "${pickDisplay}" is on the Steam: AGAINST side (${se.againstTeam || se.againstRole}), yet rationale claims favorable steam ("${clause}").`;
        addFinding(
          'contra_steam_misread',
          msg,
          buildVetoTargetFromPick(pk, headers, rowMap, candidates, msg),
          clause
        );
      }
    }

    // 1b. Check fabricated steam implied-probability shift percentages (e.g. "11% shift" when dossier shows +3.6pp implied)
    const steamWithImplied = relevantSteam.find(se => typeof se.impliedShiftPp === 'number');
    if (steamWithImplied && steamWithImplied.impliedShiftPp !== undefined) {
      for (const clause of clauses) {
        const fab = findFabricatedSteamShiftInClause(clause, steamWithImplied.impliedShiftPp);
        if (fab) {
          const msg = `fabricated_steam_shift: Pick "${pickDisplay}" claims "${fab.rawClaim}" steam shift, whereas dossier reports +${steamWithImplied.impliedShiftPp.toFixed(1)}pp implied.`;
          addFinding(
            'fabricated_steam_shift',
            msg,
            buildVetoTargetFromPick(pk, headers, rowMap, candidates, msg),
            clause
          );
        }
      }
    }

    // 2. Check symmetric / disadvantaged injury misread
    const injBal = eventId ? injuryBalances.get(eventId) : undefined;
    if (injBal && (pickedRole === 'home' || pickedRole === 'away')) {
      const isSymmetric = injBal.healthBalance === 'symmetric';
      const isDisadvantaged =
        (pickedRole === 'home' && (injBal.healthBalance === 'away_advantage' || injBal.healthBalance === 'conditional_away_advantage')) ||
        (pickedRole === 'away' && (injBal.healthBalance === 'home_advantage' || injBal.healthBalance === 'conditional_home_advantage'));
      const isUncertainQ = injBal.healthBalance === 'uncertain_questionable';

      if (isSymmetric || isDisadvantaged || isUncertainQ) {
        const pickedOut = pickedRole === 'home' ? injBal.homeOut : injBal.awayOut;
        const oppOut = pickedRole === 'home' ? injBal.awayOut : injBal.homeOut;
        const oppHeaderName = pickedRole === 'home' ? (header?.away || injBal.awayTeam || '') : (header?.home || injBal.homeTeam || '');
        const oppDesc = oppHeaderName
          ? findTeamMentionsInText(oppHeaderName, pool)[0]?.team || (matchTeamByLabel(oppHeaderName) ? descriptorFromEntry(matchTeamByLabel(oppHeaderName)!) : undefined)
          : undefined;

        const injurySubClauses = combinedReasons
          .split(/(?<=[.!?])\s+|\n+|;\s+|,\s+(?:and|but|while|whereas|with)\s+|\s+\b(?:but|while|whereas)\b\s+|\s+\band\b\s+(?=[A-Z][^.!?\n;]*\b(?:missing|out|injured|depleted|decimated|shorthanded|short-?handed|without|scratches)\b)/i)
          .map(c => c.trim())
          .filter(Boolean);

        const wholeTextHasBalancedAck =
          HEALTH_BALANCED_ACK_REGEX.test(combinedReasons) ||
          (Boolean(pickedDesc) &&
            injurySubClauses.some(
              c =>
                DEPLETION_MENTION_REGEX.test(c) &&
                findTeamMentionsInText(c, pool).some(m => m.team.key === pickedDesc!.key)
            ));

        for (const subClause of injurySubClauses) {
          if (HEALTH_ADVANTAGE_CLAIM_REGEX.test(subClause) && !HEALTH_BALANCED_ACK_REGEX.test(subClause)) {
            const msg = `symmetric_injury_misread: Pick "${pickDisplay}" claims an injury/health advantage when Health Balance is ${injBal.healthBalance} (${injBal.homeTeam || 'Home'} ${injBal.homeOut} OUT/${injBal.homeQ} Q vs ${injBal.awayTeam || 'Away'} ${injBal.awayOut} OUT/${injBal.awayQ} Q).`;
            addFinding(
              'symmetric_injury_misread',
              msg,
              buildVetoTargetFromPick(pk, headers, rowMap, candidates, msg),
              subClause
            );
            continue;
          }

          if ((isSymmetric && pickedOut >= 2 && oppOut > 0) || isDisadvantaged) {
            if (!wholeTextHasBalancedAck && !HEALTH_BALANCED_ACK_REGEX.test(subClause) && DEPLETION_MENTION_REGEX.test(subClause)) {
              const clauseMentions = findTeamMentionsInText(subClause, pool).map(m => m.team);
              const mentionsOpp = oppDesc ? clauseMentions.some(t => t.key === oppDesc.key) : false;
              const mentionsPicked = pickedDesc ? clauseMentions.some(t => t.key === pickedDesc.key) : false;
              if (mentionsOpp && !mentionsPicked) {
                const msg = `symmetric_injury_misread: Pick "${pickDisplay}" cites opponent injury depletion without acknowledging symmetric/greater injuries (${pickedOut} OUT vs opp ${oppOut} OUT, Health Balance: ${injBal.healthBalance}).`;
                addFinding(
                  'symmetric_injury_misread',
                  msg,
                  buildVetoTargetFromPick(pk, headers, rowMap, candidates, msg),
                  subClause
                );
              }
            }
          }
        }
      }
    }
  };

  if (typeof proposal === 'object') {
    if (Array.isArray(proposal.picks)) {
      for (const pk of proposal.picks) {
        if (!pk) continue;
        if (typeof pk === 'string') {
          evaluateLeg(pk, pk, [pk]);
          continue;
        }
        if (typeof pk !== 'object') continue;
        const sideText = [pk.row, pk.id, pk.side, pk.pick, pk.selection, pk.team, pk.matchup]
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
          .join(' ');
        const rTexts = [
          pk.reason,
          pk.rationale,
          pk.edge,
          pk.note,
          pk.description,
          pk.claim,
          pk.summary,
          ...(Array.isArray(pk.reasons) ? pk.reasons : [])
        ].filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
        if (rTexts.length === 0 && typeof proposal.analysis === 'string') {
          rTexts.push(proposal.analysis);
        }
        evaluateLeg(pk, sideText, rTexts);
      }
    }
    if (Array.isArray(proposal.scorecards)) {
      for (const sc of proposal.scorecards) {
        if (!sc || typeof sc !== 'object') continue;
        const sideText = [sc.row, sc.pick, sc.side, sc.team].filter((x): x is string => typeof x === 'string' && x.trim().length > 0).join(' ');
        const rTexts = [
          sc.note,
          sc.reason,
          sc.summary,
          ...(Array.isArray(sc.reasons) ? sc.reasons : [])
        ].filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
        evaluateLeg(sc, sideText, rTexts);
      }
    }
    if (proposal.scorecard && typeof proposal.scorecard === 'object') {
      const sc = proposal.scorecard;
      const sideText = [sc.row, sc.pick, sc.side, sc.team].filter((x): x is string => typeof x === 'string' && x.trim().length > 0).join(' ');
      const rTexts = [sc.note, sc.reason, sc.summary].filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
      evaluateLeg(sc, sideText, rTexts);
    }
  }

  const mergedLegs = mergeVetoedLegTargets(vetoedLegs);
  const mergedClaims = mergeVetoedClaims(vetoedClaims);

  if (violations.length > 0) {
    return {
      pass: false,
      violations,
      flags,
      feedback: `Veto (PREMISE): ${violations.join(' ')}`,
      ...(mergedLegs.length > 0 ? { vetoedLegs: mergedLegs } : {}),
      ...(mergedClaims.length > 0 ? { vetoedClaims: mergedClaims } : {})
    };
  }

  return { pass: true, violations: [], flags: [] };
}

function hasForbiddenParlayOddsOrMetricClaim(sentence: string, successfulEvidence: string): boolean {
  if (!sentence) return false;
  if (/\b(?:combined|parlay|total)\s+(?:odds|payout|implied\s+probability)\b[^.\n]{0,30}[+-]?\d|\bparlay\s+pays\s+/i.test(sentence)) {
    return true;
  }
  const metricMatch = sentence.match(/\b(offensive|defensive)\s+(metrics|efficiency|rating)\b/i);
  if (metricMatch) {
    const inTool = new RegExp(`\\b${metricMatch[1]}\\s+${metricMatch[2]}\\b`, 'i').test(successfulEvidence);
    if (!inTool) return true;
  }
  return false;
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
  const groundedRecords = extractGroundedRecords(successfulEvidence, candidates, headers);
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
      hasForbiddenParlayOddsOrMetricClaim(sentence, successfulEvidence) ||
      singleRes.violation ||
      legRecViolation
    );
    return { hasViolation, endsWithVetoedSubject: singleRes.endsWithVetoedSubject };
  };

  const capitalizeAndPunctuate = (raw: string): string => {
    let out = raw.trim();
    if (!out) return '';
    if (/^[a-z]/.test(out)) {
      out = out[0].toUpperCase() + out.slice(1);
    }
    if (!/[.!?]$/.test(out)) {
      out = `${out}.`;
    }
    return out;
  };

  const cleanTextField = (text: string, sideHint?: string, checkLegRec: boolean = true): string => {
    const preStripped = vetoedTargets.length > 0 ? stripVetoedLegsFromParlayText(text, vetoedTargets) : text;
    const sentences = splitSentencesSafe(preStripped);
    const kept: string[] = [];
    let priorSubWasVetoed = false;
    for (const s of sentences) {
      const checkRes = sentenceHasViolation(s, sideHint, priorSubWasVetoed, checkLegRec);
      const prevVetoFlag = priorSubWasVetoed;
      priorSubWasVetoed = checkRes.endsWithVetoedSubject;
      if (!checkRes.hasViolation) {
        kept.push(s.trim());
        continue;
      }
      // S1: Whole-sentence removal only for vetoed-leg violations — never slice mid-sentence at a comma or clause.
      const isVetoedLegSentence =
        Boolean(findSingleBetRewriteViolationInClause(s, vetoedTargets, prevVetoFlag).violation) ||
        Boolean(checkLegRec && findVetoedLegRecommendationInClause(s, vetoedTargets));
      if (isVetoedLegSentence) {
        continue;
      }
      // For non-veto parenthetical metric claims (e.g. "(L5: 4-1)"), stripping only a complete parenthetical preserves a full sentence.
      const withoutParen = s.replace(/\s*\([^)]*\)/g, '').replace(/\s{2,}/g, ' ').trim();
      if (
        withoutParen &&
        withoutParen !== s.trim() &&
        !sentenceHasViolation(withoutParen, sideHint, prevVetoFlag, checkLegRec).hasViolation
      ) {
        kept.push(capitalizeAndPunctuate(withoutParen));
      }
    }
    return kept.join(' ').trim();
  };

  const rep = report as Record<string, any>;
  const stripRecs = options?.stripVetoedLegRecommendations !== false;

  // Rewrite fabricated steam implied-prob shifts (e.g., "11% shift" -> "+3.6pp implied") from dossier steam entries
  const steamEntriesForShift = parseSteamEntriesFromEvidence(successfulEvidence, headers, candidates);
  if (steamEntriesForShift.some(se => typeof se.impliedShiftPp === 'number')) {
    const impliedByEvent = new Map<string, number>();
    let uniqueFallbackImplied: number | undefined;
    const allImpliedVals = new Set<number>();
    for (const se of steamEntriesForShift) {
      if (typeof se.impliedShiftPp !== 'number') continue;
      if (se.eventId) impliedByEvent.set(se.eventId, se.impliedShiftPp);
      allImpliedVals.add(se.impliedShiftPp);
    }
    if (allImpliedVals.size === 1) {
      uniqueFallbackImplied = Array.from(allImpliedVals)[0];
    }
    if (Array.isArray(rep.picks)) {
      for (const pk of rep.picks) {
        if (!pk || typeof pk !== 'object') continue;
        const pkEvId = getEventIdForPick(pk, headers) || (typeof pk.row === 'string' ? rowMap.get(pk.row.trim().toUpperCase())?.eventId : undefined);
        const targetShift = (pkEvId ? impliedByEvent.get(pkEvId) : undefined) ?? uniqueFallbackImplied;
        if (typeof targetShift !== 'number') continue;
        for (const field of ['reason', 'rationale', 'edge', 'note', 'description', 'claim'] as const) {
          if (typeof pk[field] === 'string' && pk[field].trim()) {
            pk[field] = rewriteFabricatedSteamShiftInText(pk[field], targetShift).text;
          }
        }
        if (Array.isArray(pk.reasons)) {
          pk.reasons = pk.reasons.map((r: any) =>
            typeof r === 'string' ? rewriteFabricatedSteamShiftInText(r, targetShift).text : r
          );
        }
      }
    }
    if (typeof uniqueFallbackImplied === 'number') {
      for (const field of ['summary', 'analysis'] as const) {
        if (typeof rep[field] === 'string' && rep[field].trim()) {
          rep[field] = rewriteFabricatedSteamShiftInText(rep[field], uniqueFallbackImplied).text;
        }
      }
    }
  }

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
    const isSeatScorecard = (sc: any): boolean =>
      Boolean(
        sc &&
        typeof sc === 'object' &&
        (typeof sc.seat === 'string' ||
          typeof sc.role === 'string' ||
          typeof sc.verdict === 'string' ||
          typeof sc.criticApproved === 'boolean' ||
          typeof sc.wageringPass === 'boolean')
      );
    if (vetoedTargets.length > 0) {
      // S1: Never wipe seat scorecards (including Risk Critic veto scorecards) when pruning vetoed pick legs.
      rep.scorecards = rep.scorecards.filter((sc: any) =>
        isSeatScorecard(sc) || !vetoedTargets.some(t => pickMatchesVetoedTarget(sc, t))
      );
    }
    for (const sc of rep.scorecards) {
      if (!sc || typeof sc !== 'object' || isSeatScorecard(sc)) continue;
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

function extractRecentTokensFromSegment(seg: string): Array<'W' | 'L'> {
  if (!seg) return [];
  const norm = normalizeText(seg);
  const recentRx =
    /(?:\b(?:Recent|team_games(?:\s+last[\s_]?\d{1,2})?|last[\s_]?\d{1,2})\s*:?\s*([WLOT](?:\s*[,/\s-]\s*(?:OTL|OT|[WLT]))+)|"recent_results"\s*:\s*\[([^\]]+)\])/gi;
  let m: RegExpExecArray | null;
  let best: Array<'W' | 'L'> = [];
  while ((m = recentRx.exec(norm)) !== null) {
    const rawSeq = m[1] || m[2] || '';
    const tokens = rawSeq.match(/\b(?:OTL|OT|[WLT])\b/gi);
    if (!tokens || tokens.length === 0) continue;
    const mapped: Array<'W' | 'L'> = [];
    for (const tok of tokens) {
      const up = tok.toUpperCase();
      if (up === 'W') mapped.push('W');
      else if (up === 'L' || up === 'OTL' || up === 'OT') mapped.push('L');
    }
    if (mapped.length > best.length) best = mapped;
  }
  return best;
}

function extractRecentResultsByTeamKey(
  successfulEvidence: string,
  candidates: TeamDescriptor[],
  headers: GameHeader[]
): Map<string, Array<'W' | 'L'>> {
  const recentByTeamKey = new Map<string, Array<'W' | 'L'>>();
  if (!successfulEvidence || candidates.length === 0) return recentByTeamKey;

  const setSeq = (teamKey: string, seq: Array<'W' | 'L'>) => {
    if (!teamKey || seq.length === 0) return;
    const prev = recentByTeamKey.get(teamKey);
    if (!prev || seq.length > prev.length) {
      recentByTeamKey.set(teamKey, seq);
    }
  };

  let currentEventId = '';
  for (const rawLine of successfulEvidence.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const evLineMatch =
      line.match(/^EVENT\s+([a-z0-9-]+)/i) ||
      line.match(/\[(?:MATCHUP FUNDAMENTALS|MARKET MOVEMENT|INJURY(?:\s*&\s*ROSTER\s*DELTA)?):\s*([a-z0-9-]+)/i) ||
      line.match(/\bevent_id\s*=\s*([a-z0-9-]+)/i);
    if (evLineMatch && evLineMatch[1]) {
      currentEventId = evLineMatch[1].trim();
    }

    // Handle JSON form.items payloads if present
    if (line.includes('"items"') && line.includes('"result"')) {
      const jsonStart = line.indexOf('{');
      if (jsonStart >= 0) {
        try {
          const parsed = JSON.parse(line.slice(jsonStart));
          const items = Array.isArray(parsed?.form?.items)
            ? parsed.form.items
            : (Array.isArray(parsed?.items) ? parsed.items : []);
          if (items.length > 0) {
            const byTeam = new Map<string, Array<{ res: 'W' | 'L'; date: string }>>();
            for (const item of items) {
              if (!item || typeof item !== 'object') continue;
              const rawRes = String(item.result || '').toUpperCase().trim();
              const res: 'W' | 'L' | null = rawRes === 'W' ? 'W' : (/^(?:L|OTL|OT)$/.test(rawRes) ? 'L' : null);
              if (!res) continue;
              const teamHint = [item.team_name, item.team].filter(Boolean).join(' ');
              if (!teamHint) continue;
              const mentions = findTeamMentionsInText(teamHint, candidates);
              if (mentions.length === 0) continue;
              const tk = mentions[0].team.key;
              if (!byTeam.has(tk)) byTeam.set(tk, []);
              byTeam.get(tk)!.push({ res, date: String(item.game_date || '') });
            }
            for (const [tk, entries] of byTeam.entries()) {
              entries.sort((a, b) => b.date.localeCompare(a.date));
              setSeq(tk, entries.map(e => e.res));
            }
          }
        } catch {
          // fall through to segment text parsing
        }
      }
    }

    const segments = line.split(/(?=\b(?:Home|Away)\s*(?:\(|[:\-]))/i);
    for (const seg of segments) {
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
          setSeq(jsonTeamStarts[i].key, extractRecentTokensFromSegment(seg.slice(start, end)));
        }
        continue;
      }

      const mentions = findTeamMentionsInText(seg, candidates);
      let uniqueKeys = Array.from(new Set(mentions.map(m => m.team.key)));
      if (uniqueKeys.length === 0 && currentEventId) {
        const sideKey = resolveSegmentSideTeamKey(seg, currentEventId, headers, candidates);
        if (sideKey) uniqueKeys = [sideKey];
      }

      if (uniqueKeys.length === 1) {
        setSeq(uniqueKeys[0], extractRecentTokensFromSegment(seg));
      } else if (uniqueKeys.length >= 2 && seg.includes('|')) {
        let activeLineTeamKey: string | undefined;
        for (const sub of seg.split('|').map(s => s.trim()).filter(Boolean)) {
          const subMentions = findTeamMentionsInText(sub, candidates);
          let subKeys = Array.from(new Set(subMentions.map(m => m.team.key)));
          if (subKeys.length === 0 && currentEventId) {
            const subSideKey = resolveSegmentSideTeamKey(sub, currentEventId, headers, candidates);
            if (subSideKey) subKeys = [subSideKey];
          }
          if (subKeys.length === 1) activeLineTeamKey = subKeys[0];
          else if (subKeys.length >= 2) activeLineTeamKey = undefined;
          const resolvedKey = subKeys.length === 1 ? subKeys[0] : (subKeys.length === 0 ? activeLineTeamKey : undefined);
          if (resolvedKey) {
            setSeq(resolvedKey, extractRecentTokensFromSegment(sub));
          }
        }
      }
    }
  }

  return recentByTeamKey;
}

const STREAK_PATTERNS: Array<{ rx: RegExp; kind: 'W' | 'L'; numbered: boolean }> = [
  { rx: /\b(\d{1,2})\s*-?\s*game\s+(?:win(?:ning)?|victory)\s+streak\b/gi, kind: 'W', numbered: true },
  { rx: /\b(?:won|winning|wins?|victories)\s+(\d{1,2})\s+(?:straight|consecutive|in\s+a\s+row)\b/gi, kind: 'W', numbered: true },
  { rx: /\b(\d{1,2})\s+(?:straight|consecutive)\s+(?:wins?|victories)\b/gi, kind: 'W', numbered: true },
  { rx: /\b(?:unbeaten|undefeated)\s+(?:in|over)\s+(?:their\s+|the\s+)?(?:last|past)\s+(\d{1,2})\b/gi, kind: 'W', numbered: true },
  { rx: /\b(?:on\s+a\s+)?W(\d{1,2})\s+streak\b/gi, kind: 'W', numbered: true },
  { rx: /\b(\d{1,2})\s*-?\s*game\s+(?:losing\s+streak|skid|slump|slide)\b/gi, kind: 'L', numbered: true },
  { rx: /\b(?:lost|dropped|losing)\s+(\d{1,2})\s+(?:straight|consecutive|in\s+a\s+row)\b/gi, kind: 'L', numbered: true },
  { rx: /\b(\d{1,2})\s+(?:straight|consecutive)\s+(?:losses?|defeats?)\b/gi, kind: 'L', numbered: true },
  { rx: /\bwinless\s+(?:in|over)\s+(?:their\s+|the\s+)?(?:last|past)\s+(\d{1,2})\b/gi, kind: 'L', numbered: true },
  { rx: /\b(?:on\s+a\s+)?L(\d{1,2})\s+streak\b/gi, kind: 'L', numbered: true },
  { rx: /\b(?:on\s+a|riding\s+a|carrying\s+a|extending\s+(?:their|its|a))\s+(?:hot\s+)?win(?:ning)?\s+streak\b/gi, kind: 'W', numbered: false },
  { rx: /\b(?:on\s+a|riding\s+a|stuck\s+in\s+a|mired\s+in\s+a)\s+(?:losing\s+streak|skid|slump|losing\s+slide)\b/gi, kind: 'L', numbered: false }
];

function findContradictedStreakInClause(
  clause: string,
  candidates: TeamDescriptor[],
  recentByTeamKey: Map<string, Array<'W' | 'L'>>
): { teamLabel: string } | null {
  if (!clause || recentByTeamKey.size === 0 || candidates.length === 0) return null;
  const norm = normalizeText(clause);

  for (const spec of STREAK_PATTERNS) {
    spec.rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = spec.rx.exec(norm)) !== null) {
      const prefix = norm.slice(Math.max(0, m.index - 25), m.index);
      if (/\b(?:snapped|ended|broke|halted|stopped|not\s+on|no\s+longer\s+on|without)\b/i.test(prefix)) {
        continue;
      }
      const requiredCount = spec.numbered ? parseInt(m[1], 10) : 2;
      if (!Number.isFinite(requiredCount) || requiredCount <= 0) continue;

      const targetTeams = findTargetTeamsForSpan(norm, m.index, m.index + m[0].length, candidates);
      for (const team of targetTeams) {
        const seq = recentByTeamKey.get(team.key);
        if (!seq || seq.length === 0) continue;
        const actualKind = seq[0];
        let actualCount = 0;
        for (const r of seq) {
          if (r === actualKind) actualCount++;
          else break;
        }
        if (actualKind !== spec.kind || actualCount < requiredCount) {
          return { teamLabel: team.label };
        }
      }
    }
  }
  return null;
}

/**
 * Strips streak claims contradicted by FUND recent results (newest-first) from report prose fields.
 */
export function sanitizeContradictedStreakClaims<T extends Record<string, any>>(
  report: T,
  evidenceText: string,
  slateText?: string,
  options?: { headers?: GameHeader[] }
): { report: T; corrected: boolean; details: string[] } {
  if (!report || typeof report !== 'object') {
    return { report, corrected: false, details: [] };
  }

  const headers = options?.headers && options.headers.length > 0
    ? options.headers
    : parseGameHeaders(slateText);
  const successfulEvidence = extractSuccessfulEvidenceText(evidenceText);
  if (!successfulEvidence) {
    return { report, corrected: false, details: [] };
  }

  const hasSportsSignal =
    headers.length > 0 ||
    SPORTS_CONTEXT_REGEX.test(JSON.stringify(report)) ||
    SPORTS_CONTEXT_REGEX.test(slateText || '') ||
    Boolean(successfulEvidence);

  const allInjuries = extractAuthoritativeInjuries(successfulEvidence, slateText);
  const outInjuries = allInjuries.filter(inj => /^(?:OUT|IR|INJURED\s+RESERVE|SUSPENDED)$/i.test(inj.status));
  const candidates = buildTeamDescriptors(headers, outInjuries, hasSportsSignal);
  const recentByTeamKey = extractRecentResultsByTeamKey(successfulEvidence, candidates, headers);
  if (recentByTeamKey.size === 0) {
    return { report, corrected: false, details: [] };
  }

  let corrected = false;
  const details: string[] = [];
  const recordCorrection = (teamLabel: string) => {
    corrected = true;
    const msg = `adjusted streak claim for ${teamLabel} to match recent results`;
    if (!details.includes(msg)) details.push(msg);
  };

  const cleanTextField = (text: string): string => {
    const sentences = text.split(/(?<=[.!?])\s+|\n+/);
    const kept: string[] = [];
    for (const s of sentences) {
      const hit = findContradictedStreakInClause(s, candidates, recentByTeamKey);
      if (!hit) {
        kept.push(s);
        continue;
      }
      recordCorrection(hit.teamLabel);
      const withoutParen = s.replace(/\s*\([^)]*\)/g, '').replace(/\s{2,}/g, ' ').trim();
      if (withoutParen && withoutParen !== s.trim() && !findContradictedStreakInClause(withoutParen, candidates, recentByTeamKey)) {
        kept.push(withoutParen);
        continue;
      }
      const subParts = s.split(/;\s+|,\s*(?=(?:while|whereas|but|although|though|so|yet|and)\b)/i);
      if (subParts.length > 1) {
        const cleanSubs = subParts.filter(part => !findContradictedStreakInClause(part, candidates, recentByTeamKey));
        const rejoined = cleanSubs.join(', ').trim();
        if (rejoined && !findContradictedStreakInClause(rejoined, candidates, recentByTeamKey)) {
          kept.push(rejoined);
        }
      }
    }
    return kept.join(' ').trim();
  };

  const rep = report as Record<string, any>;
  for (const field of ['summary', 'analysis', 'reason', 'rationale', 'conclusion'] as const) {
    if (typeof rep[field] === 'string' && rep[field].trim()) {
      rep[field] = cleanTextField(rep[field]);
    }
  }
  if (Array.isArray(rep.insights)) {
    rep.insights = rep.insights
      .map((ins: any) => (typeof ins === 'string' ? cleanTextField(ins) : ins))
      .filter((ins: any) => typeof ins !== 'string' || ins.trim().length > 0);
  }
  if (Array.isArray(rep.anomalies)) {
    rep.anomalies = rep.anomalies
      .map((anom: any) => (typeof anom === 'string' ? cleanTextField(anom) : anom))
      .filter((anom: any) => typeof anom !== 'string' || anom.trim().length > 0);
  }
  if (Array.isArray(rep.components)) {
    for (const comp of rep.components) {
      if (!comp || typeof comp !== 'object' || !comp.props) continue;
      if (comp.type === 'InsightList' && Array.isArray(comp.props.insights)) {
        comp.props.insights = comp.props.insights
          .map((ins: any) => {
            if (typeof ins === 'string') return cleanTextField(ins);
            if (ins && typeof ins === 'object' && typeof ins.message === 'string') {
              return { ...ins, message: cleanTextField(ins.message) };
            }
            return ins;
          })
          .filter((ins: any) => {
            if (typeof ins === 'string') return ins.trim().length > 0;
            if (ins && typeof ins === 'object' && typeof ins.message === 'string') return ins.message.trim().length > 0;
            return true;
          });
      } else if (comp.type === 'MetricCard' && typeof comp.props.subtitle === 'string') {
        comp.props.subtitle = cleanTextField(comp.props.subtitle);
      } else if (comp.type === 'DataTable' && Array.isArray(comp.props.rows)) {
        for (const row of comp.props.rows) {
          if (!row || typeof row !== 'object') continue;
          for (const key of Object.keys(row)) {
            if (typeof row[key] === 'string' && row[key].trim()) {
              row[key] = cleanTextField(row[key]);
            }
          }
        }
      }
    }
  }

  return { report, corrected, details };
}

function normalizeGrammaticalSentence(raw: string): string {
  let out = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!out) return '';
  if (/^[a-z]/.test(out)) {
    out = out[0].toUpperCase() + out.slice(1);
  }
  if (!/[.!?]$/.test(out)) {
    out = `${out}.`;
  }
  return out;
}

function cleanVetoReasonText(raw: string): string {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/^[-•*\s]+/, '')
    .replace(/[.!?]+$/, '')
    .trim();
}

export function ensureRiskCriticVetoScorecard<T extends Record<string, any>>(
  report: T,
  options?: {
    vetoReason?: string;
    seatScorecards?: any[];
  }
): T {
  if (!report || typeof report !== 'object') return report;
  const rep = report as Record<string, any>;
  const existing = Array.isArray(rep.scorecards) ? [...rep.scorecards] : [];
  const incoming = Array.isArray(options?.seatScorecards) ? options!.seatScorecards : [];

  const merged: any[] = [...existing];
  for (const sc of incoming) {
    if (!sc || typeof sc !== 'object') continue;
    const seatName = String(sc.seat || sc.role || '').trim().toLowerCase();
    const alreadyPresent = seatName
      ? merged.some((m) => m && typeof m === 'object' && String(m.seat || m.role || '').trim().toLowerCase() === seatName)
      : false;
    if (!alreadyPresent) {
      merged.push({ ...sc });
    }
  }

  const criticIdx = merged.findIndex(
    (sc) =>
      sc &&
      typeof sc === 'object' &&
      (/risk\s*critic|^critic$/i.test(String(sc.seat || sc.role || '').trim()) ||
        (String(sc.verdict || '').toLowerCase() === 'veto' && !sc.seat && !sc.role))
  );

  const vetoNotes = cleanVetoReasonText(options?.vetoReason || '');
  if (criticIdx >= 0) {
    const prev = merged[criticIdx];
    merged[criticIdx] = {
      ...prev,
      seat: prev.seat || 'Risk Critic',
      verdict: 'veto',
      criticApproved: false,
      wageringPass: true,
      ...(vetoNotes && !prev.notes ? { notes: normalizeGrammaticalSentence(vetoNotes) } : {})
    };
  } else {
    merged.push({
      seat: 'Risk Critic',
      verdict: 'veto',
      criticApproved: false,
      wageringPass: true,
      ...(vetoNotes ? { notes: normalizeGrammaticalSentence(vetoNotes) } : {})
    });
  }

  rep.scorecards = merged;
  return report;
}

/**
 * Normalizes a report into a clean, grammatical deterministic pass if all proposed picks
 * were removed by Critic vetoes, preserving seat scorecards and Risk Critic veto metadata.
 */
export function normalizePassIfAllLegsVetoed<T extends Record<string, any>>(
  report: T,
  initialPickCount: number,
  hadVetoes: boolean,
  options?: {
    vetoTexts?: string[];
    vetoedLegs?: VetoedLegTarget[];
    seatScorecards?: any[];
    criticApproved?: boolean;
  }
): T {
  if (!report || typeof report !== 'object') return report;
  const rep = report as Record<string, any>;
  const isZeroPicks = Array.isArray(rep.picks) && rep.picks.length === 0;
  const criticRejected = options?.criticApproved === false || rep.criticApproved === false;
  const hadVetoedLegs =
    hadVetoes ||
    criticRejected ||
    (Array.isArray(options?.vetoedLegs) && options!.vetoedLegs.length > 0) ||
    (Array.isArray(options?.vetoTexts) && options!.vetoTexts.length > 0);
  const hadCandidateActivity =
    initialPickCount > 0 ||
    criticRejected ||
    (Array.isArray(options?.vetoedLegs) && options!.vetoedLegs.length > 0);

  if (isZeroPicks && hadVetoedLegs && hadCandidateActivity) {
    rep.pass = true;
    rep.status = 'no_play';
    rep.criticApproved = false;
    rep.wageringPass = true;
    if (!rep.ui_title || !/insufficient|pass|no play/i.test(String(rep.ui_title))) {
      rep.ui_title = 'Pass';
    }

    const vetoReasons: string[] = [];
    const seenReasons = new Set<string>();
    const addReason = (raw?: string) => {
      const cleaned = cleanVetoReasonText(raw || '');
      if (!cleaned || cleaned.length < 4) return;
      const key = cleaned.toLowerCase();
      if (seenReasons.has(key)) return;
      seenReasons.add(key);
      vetoReasons.push(cleaned);
    };

    for (const vt of options?.vetoTexts || []) addReason(vt);
    for (const vl of options?.vetoedLegs || []) {
      if (vl?.reason && !/^pruned from final picks/i.test(vl.reason.trim())) {
        addReason(vl.reason);
      }
    }
    if (Array.isArray(rep.scorecards)) {
      for (const sc of rep.scorecards) {
        if (sc && typeof sc === 'object' && /risk\s*critic|critic/i.test(String(sc.seat || sc.role || ''))) {
          addReason(sc.notes || sc.reason || sc.summary);
        }
      }
    }

    const vetoedLegLabels = Array.from(
      new Set(
        (options?.vetoedLegs || [])
          .map((vl) => [vl?.teamLabel, vl?.rowId ? `(${vl.rowId})` : ''].filter(Boolean).join(' ').trim())
          .filter(Boolean)
      )
    );

    const primaryReason = vetoReasons[0] || '';
    const legsPhrase =
      vetoedLegLabels.length > 0
        ? ` (${vetoedLegLabels.join(', ')})`
        : '';

    const summaryText = primaryReason
      ? `Bottom-line call: pass. The Risk Critic vetoed all proposed selections${legsPhrase} because ${primaryReason[0].toLowerCase() + primaryReason.slice(1)}.`
      : `Bottom-line call: pass. The Risk Critic vetoed all proposed selections${legsPhrase}, leaving no qualified plays on this slate.`;

    const analysisParts = [
      `Bottom-line call: pass.`,
      primaryReason
        ? `The Risk Critic vetoed all proposed selections${legsPhrase}: ${primaryReason}.`
        : `The Risk Critic vetoed all proposed selections${legsPhrase} after reviewing the available evidence.`,
      `No wagers meet verification standards on this slate, so all capital is preserved.`
    ];
    const analysisText = analysisParts.map(normalizeGrammaticalSentence).join(' ');

    const insightStrings: string[] = [
      normalizeGrammaticalSentence(
        `The Risk Critic vetoed all proposed selections${legsPhrase}, resulting in a pass.`
      )
    ];
    if (vetoReasons.length > 0) {
      for (const r of vetoReasons.slice(0, 3)) {
        insightStrings.push(normalizeGrammaticalSentence(`Risk Critic veto rationale: ${r}`));
      }
    } else if (vetoedLegLabels.length > 0) {
      insightStrings.push(
        normalizeGrammaticalSentence(`Excluded selections: ${vetoedLegLabels.join(', ')}.`)
      );
    }

    rep.summary = normalizeGrammaticalSentence(summaryText);
    rep.analysis = analysisText;
    rep.reason = primaryReason
      ? normalizeGrammaticalSentence(primaryReason)
      : 'All proposed selections were vetoed by the Risk Critic.';
    rep.insights = insightStrings;

    if (Array.isArray(rep.components)) {
      for (const comp of rep.components) {
        if (!comp || typeof comp !== 'object' || !comp.props) continue;
        if (comp.type === 'InsightList' && Array.isArray(comp.props.insights)) {
          const hasObjects = comp.props.insights.some((i: any) => i && typeof i === 'object');
          comp.props.insights = hasObjects
            ? insightStrings.map((msg) => ({ type: 'warning', message: msg }))
            : [...insightStrings];
        } else if (comp.type === 'DataTable' && Array.isArray(comp.props.rows)) {
          const title = String(comp.props.title || '');
          if (/\b(?:selected|recommended)\s+(?:wagers?|bets?|picks?|plays?)|parlay\s+legs?\b/i.test(title)) {
            comp.props.rows = [];
          }
        }
      }
    }

    ensureRiskCriticVetoScorecard(rep, {
      vetoReason: primaryReason || 'All proposed selections were vetoed.',
      seatScorecards: options?.seatScorecards
    });
  }
  return report;
}

export interface IntraSeatDuplicateLegViolation {
  seat: string;
  eventId: string;
  rows: string[];
  sides: string[];
}

export interface IntraSeatDuplicateLegsResult {
  pass: boolean;
  flags: string[];
  violations: IntraSeatDuplicateLegViolation[];
  feedback?: string;
}

/**
 * P0-4: Scopes `duplicate_leg` strictly within a SINGLE seat's picks[] (or the compiled picks[]).
 * Two different proposer seats agreeing on the same row/side (e.g. a1: R39, a2: R39) is consensus,
 * NEVER `duplicate_leg`. Triggers ONLY when a single seat's picks[] (or compiled picks[]) contains
 * >= 2 legs sharing the same canonical event_id.
 */
export function detectIntraSeatDuplicateLegs(
  input: {
    seatReports?: Array<{ seat?: string; role?: string; picks?: any[] }>;
    picks?: any[];
  },
  headers: GameHeader[] = [],
  slateText?: string,
  rowMapOverride?: Map<string, RowOptionEntry>
): IntraSeatDuplicateLegsResult {
  const effectiveHeaders = headers.length > 0 ? headers : parseGameHeaders(slateText);
  const rowMap = rowMapOverride ?? extractRowOptions(slateText ? [slateText] : [], effectiveHeaders);
  // Also index compact "EVENT <id>" + "R<n>: <side>" lines if not already in rowMap
  if (typeof slateText === 'string' && slateText.trim()) {
    let curEv = '';
    for (const rawLine of slateText.split(/\r?\n/)) {
      const line = rawLine.trim();
      const evM = line.match(/^EVENT\s+([a-z0-9-]+)/i);
      if (evM?.[1]) {
        curEv = evM[1].trim();
        continue;
      }
      if (!curEv) continue;
      const rx = /\b(R\d+)\s*:\s*([^|\n]+)/gi;
      let rm: RegExpExecArray | null;
      while ((rm = rx.exec(line)) !== null) {
        const rid = rm[1].toUpperCase();
        const existing = rowMap.get(rid);
        if (!existing || !existing.eventId) {
          rowMap.set(rid, { rowId: rid, eventId: curEv, text: existing?.text || rm[2].trim() });
        }
      }
    }
  }
  const candidates = buildTeamDescriptors(effectiveHeaders, [], effectiveHeaders.length > 0);

  const resolveCanonicalEventIdForPick = (pk: any): { eventId?: string; rowId?: string; side: string } => {
    if (!pk) return { side: '' };
    if (typeof pk === 'string') {
      const rMatch = pk.match(/\b(R\d+)\b/i);
      const rowId = rMatch ? rMatch[1].toUpperCase() : undefined;
      const rowEntry = rowId ? rowMap.get(rowId) : undefined;
      let eventId = rowEntry?.eventId;
      if (!eventId) {
        const tm = findTeamMentionsInText(pk, candidates)[0]?.team;
        if (tm && tm.eventIds.length === 1) eventId = tm.eventIds[0];
      }
      return { ...(eventId ? { eventId } : {}), ...(rowId ? { rowId } : {}), side: pk.trim() };
    }
    if (typeof pk !== 'object') return { side: '' };

    const rawRow = pk.row ?? pk.Row ?? pk.rowId ?? pk.id ?? pk.ID;
    const rawSide = [pk.side, pk.pick, pk.selection, pk.team, pk.Side, pk.Pick]
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .join(' ')
      .trim();
    const rowIdFromField = typeof rawRow === 'string' && /^R\d+$/i.test(rawRow.trim())
      ? rawRow.trim().toUpperCase()
      : undefined;
    const rowIdFromSide = !rowIdFromField ? rawSide.match(/\b(R\d+)\b/i)?.[1]?.toUpperCase() : undefined;
    const rowId = rowIdFromField || rowIdFromSide;

    const explicitEventId = typeof pk.event_id === 'string' && pk.event_id.trim()
      ? pk.event_id.trim()
      : (typeof pk.eventId === 'string' && pk.eventId.trim()
        ? pk.eventId.trim()
        : (typeof pk.game_id === 'string' && pk.game_id.trim() ? pk.game_id.trim() : undefined));
    const rowEntry = rowId ? rowMap.get(rowId) : undefined;
    let eventId = explicitEventId || rowEntry?.eventId;
    if (!eventId && rawSide) {
      const tm = findTeamMentionsInText(rawSide, candidates)[0]?.team;
      if (tm && tm.eventIds.length === 1) eventId = tm.eventIds[0];
    }
    return { ...(eventId ? { eventId } : {}), ...(rowId ? { rowId } : {}), side: rawSide || rowId || '' };
  };

  const buckets: Array<{ seat: string; picks: any[] }> = [];
  if (Array.isArray(input?.seatReports) && input.seatReports.length > 0) {
    input.seatReports.forEach((rep, idx) => {
      const picks = Array.isArray(rep?.picks) ? rep.picks : [];
      if (picks.length >= 2) {
        buckets.push({
          seat: String(rep?.seat || rep?.role || `seat_${idx + 1}`),
          picks
        });
      }
    });
  } else if (Array.isArray(input?.picks) && input.picks.length >= 2) {
    buckets.push({ seat: 'compiled', picks: input.picks });
  }

  const violations: IntraSeatDuplicateLegViolation[] = [];
  for (const bucket of buckets) {
    const byEvent = new Map<string, { rows: string[]; sides: string[] }>();
    for (const pk of bucket.picks) {
      const resolved = resolveCanonicalEventIdForPick(pk);
      if (!resolved.eventId) continue;
      const normEv = resolved.eventId.toLowerCase();
      let entry = byEvent.get(normEv);
      if (!entry) {
        entry = { rows: [], sides: [] };
        byEvent.set(normEv, entry);
      }
      if (resolved.rowId) entry.rows.push(resolved.rowId);
      if (resolved.side) entry.sides.push(resolved.side);
      else entry.sides.push(resolved.rowId || resolved.eventId);
    }

    for (const [normEv, info] of byEvent.entries()) {
      const legCount = Math.max(info.rows.length, info.sides.length);
      if (legCount >= 2) {
        const canonicalEv =
          effectiveHeaders.find(h => h.eventId.toLowerCase() === normEv)?.eventId || normEv;
        violations.push({
          seat: bucket.seat,
          eventId: canonicalEv,
          rows: info.rows,
          sides: info.sides
        });
      }
    }
  }

  if (violations.length === 0) {
    return { pass: true, flags: [], violations: [] };
  }

  const desc = violations
    .map(v => `${v.seat} has ${Math.max(v.rows.length, v.sides.length)} legs on ${v.eventId} (${(v.rows.length > 0 ? v.rows : v.sides).join(', ')})`)
    .join('; ');

  return {
    pass: false,
    flags: ['duplicate_leg'],
    violations,
    feedback: `Veto (duplicate_leg): ${desc}.`
  };
}

