import { parseGameHeaders, type GameHeader } from '../context/gameHeaders.ts';
import { buildHeaderAliasMap, escapeRegex } from '../context/headerAliases.ts';
import { resolveSelectedGameIds } from '../context/selectedGames.ts';
import type { ToolEvidenceItem } from '../engine/seatToolLoop.ts';
import { buildVerifierEvidence } from '../engine/verifierEvidence.ts';
import { extractSuccessfulEvidenceText } from './claimGrounding.ts';
import {
  ESPN_TEAMS,
  extractAuthoritativeInjuries,
  matchTeamByLabel,
  type AuthoritativeInjury,
  type EspnTeamEntry
} from './injuryAttribution.ts';
import type { MarketToolRecord } from './marketRowBinding.ts';
import {
  buildToolPullLedger,
  isEmptyToolSummary,
  type ToolCallTraceEntry
} from './pullBeforePass.ts';

export const CRITIC_EVIDENCE_RULE = `CRITIC EVIDENCE:
- Use every successful tool result from this run for the games under review.
- An injury, market, or form claim is grounded if it appears in any successful tool result in the trace.
- Do not mark a claim hallucinated when the matching tool result is already present.
- Only call it missing if no successful tool for that game returned it.`;

function normalizeText(value: string): string {
  return value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-');
}

function normalizeToolName(name: string): string {
  return String(name || '').trim().replace(/_v1$/i, '');
}

function isFailedSummaryText(summary: string): boolean {
  if (!summary || typeof summary !== 'string') return true;
  const trimmed = summary.trim();
  if (!trimmed) return true;
  return /^(?:\[[^\]]+\]:?\s*)?Error(?:\s+fetching\b[^:\n]*)?:|^\[Not Fetched\]:|^\[TOOL_(?:ERROR|TIMEOUT):|\b(?:rpc_failed(?:_\d+)?|rpc_network_error|supabase_not_configured|invalid_game_id|unresolved_game_id|status=failed)\b/i.test(
    trimmed
  );
}

/**
 * Collects all proposal text fields (picks, summary, analysis, insights, components) for game-scope resolution.
 */
function collectProposalNarrativeText(proposal: unknown): string {
  if (!proposal) return '';
  if (typeof proposal === 'string') return proposal;
  if (Array.isArray(proposal)) {
    return proposal.map(collectProposalNarrativeText).filter(Boolean).join('\n');
  }
  if (typeof proposal !== 'object') return '';

  const obj = proposal as Record<string, any>;
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) parts.push(v.trim());
  };

  push(obj.summary);
  push(obj.analysis);
  push(obj.reason);
  push(obj.rationale);
  push(obj.conclusion);
  push(obj.verdict);
  push(obj.ui_title);

  if (Array.isArray(obj.insights)) {
    for (const ins of obj.insights) push(ins);
  }
  if (Array.isArray(obj.anomalies)) {
    for (const anom of obj.anomalies) push(anom);
  }
  if (Array.isArray(obj.picks)) {
    for (const pk of obj.picks) {
      if (typeof pk === 'string') {
        push(pk);
      } else if (pk && typeof pk === 'object') {
        push(pk.event_id);
        push(pk.eventId);
        push(pk.game_id);
        push(pk.row);
        push(pk.game);
        push(pk.match);
        push(pk.side);
        push(pk.pick);
        push(pk.selection);
        push(pk.team);
        push(pk.reason);
        push(pk.rationale);
        push(pk.note);
        if (Array.isArray(pk.reasons)) {
          for (const r of pk.reasons) push(r);
        }
      }
    }
  }
  if (obj.scorecard && typeof obj.scorecard === 'object') {
    push(obj.scorecard.event_id);
    push(obj.scorecard.row);
    push(obj.scorecard.pick);
    push(obj.scorecard.summary);
    push(obj.scorecard.reason);
    push(obj.scorecard.note);
  }
  if (Array.isArray(obj.scorecards)) {
    for (const sc of obj.scorecards) {
      parts.push(collectProposalNarrativeText(sc));
    }
  }
  if (Array.isArray(obj.components)) {
    for (const comp of obj.components) {
      if (!comp || typeof comp !== 'object' || !comp.props) continue;
      push(comp.props.title);
      push(comp.props.subtitle);
      push(comp.props.value);
      if (Array.isArray(comp.props.insights)) {
        for (const ins of comp.props.insights) {
          push(typeof ins === 'string' ? ins : ins?.message);
        }
      }
      if (Array.isArray(comp.props.rows)) {
        for (const row of comp.props.rows) {
          if (!row || typeof row !== 'object') continue;
          for (const val of Object.values(row)) push(val);
        }
      }
    }
  }

  return parts.filter(Boolean).join('\n');
}

/**
 * Resolves all game event IDs under review for a proposal:
 *  1. Explicitly picked games (via resolveSelectedGameIds) — ordered first
 *  2. Games actively discussed in summary/analysis/insights/components by event ID, row ID,
 *     team name/city/nickname/abbreviation, or cited injured player names in run evidence.
 * Unmentioned slate games remain excluded so Critic scope stays tight.
 */
export function resolveDiscussedGameIds(
  proposals: unknown,
  headers: GameHeader[] = [],
  evidenceText?: string
): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const addId = (id?: string) => {
    const clean = String(id || '').trim();
    if (!clean || clean === 'unknown-game' || seen.has(clean)) return;
    seen.add(clean);
    ordered.push(clean);
  };

  // 1. Explicitly picked / selected games always come first
  for (const id of resolveSelectedGameIds(proposals, headers)) {
    addId(id);
  }

  const narrative = normalizeText(collectProposalNarrativeText(proposals));
  if (!narrative) return ordered;

  // 2. Match any header games discussed in narrative by eventId, rowId, full name, city, nickname, or abbr
  const aliasEntries = buildHeaderAliasMap(headers);
  for (const entry of aliasEntries) {
    if (seen.has(entry.eventId)) continue;
    if (
      narrative.includes(entry.eventId) ||
      entry.rowIds.some(rId => new RegExp(`\\b${escapeRegex(rId)}\\b`, 'i').test(narrative)) ||
      entry.nameAliases.some(alias => new RegExp(`(?<![a-zA-Z0-9])${escapeRegex(alias)}(?![a-zA-Z0-9])`, 'i').test(narrative)) ||
      entry.abbrAliases.some(abbr => new RegExp(`(?<![a-zA-Z0-9])${escapeRegex(abbr)}(?![a-zA-Z0-9])`).test(narrative))
    ) {
      addId(entry.eventId);
    }
  }

  // 3. Match any eventId from run evidence whose injured player name appears in the proposal narrative
  if (evidenceText && evidenceText.trim()) {
    const injuries = extractAuthoritativeInjuries(evidenceText);
    for (const inj of injuries) {
      if (!inj.eventId || seen.has(inj.eventId)) continue;
      const fullRx = inj.playerName.length >= 4
        ? new RegExp(`(?<![a-zA-Z])${escapeRegex(inj.playerName)}(?![a-zA-Z])`, 'i')
        : null;
      const lastRx = inj.lastName.length >= 4
        ? new RegExp(`(?<![a-zA-Z])${escapeRegex(inj.lastName)}(?![a-zA-Z])`, 'i')
        : null;
      if ((fullRx && fullRx.test(narrative)) || (lastRx && lastRx.test(narrative))) {
        addId(inj.eventId);
      }
    }
  }

  return ordered;
}

/**
 * Parses pre-formatted verifier evidence text (`EVENT <id> ...` blocks) into structured event blocks.
 */
export function parseVerifierEvidenceBlocks(evidenceText: string): Array<{ eventId: string; text: string }> {
  if (!evidenceText || typeof evidenceText !== 'string') return [];
  const blocks: Array<{ eventId: string; text: string }> = [];
  const rawBlocks = evidenceText.split(/\n\n+/).map(b => b.trim()).filter(Boolean);

  for (const block of rawBlocks) {
    const firstLine = block.split(/\r?\n/)[0]?.trim() || '';
    const m =
      firstLine.match(/^EVENT\s+([a-z0-9_-]+)/i) ||
      firstLine.match(/^\[(?:INJURY(?:\s*&\s*ROSTER\s*DELTA)?|MARKET MOVEMENT|MATCHUP FUNDAMENTALS|ENVIRONMENT|PLAYER PROP)[^:\]]*:\s*([a-z0-9_-]+)/i) ||
      firstLine.match(/^([a-z]{2,6}-\d+):/i);
    if (m && m[1]) {
      blocks.push({ eventId: m[1].trim(), text: block });
    }
  }
  return blocks;
}

/**
 * Collects and deduplicates all successful ToolEvidenceItems across earlier seats, shared prefetch,
 * tool call trace entries, and newly pulled Critic items.
 * Prefers richer non-empty summaries over empty/stub entries for the same `(tool, eventId)`.
 */
export function collectSuccessfulEvidenceItems(sources: {
  prePassedItems?: ToolEvidenceItem[];
  pulledItems?: ToolEvidenceItem[];
  toolCallTrace?: ToolCallTraceEntry[];
  allowedEventIds?: string[];
}): ToolEvidenceItem[] {
  const allowedSet = sources.allowedEventIds && sources.allowedEventIds.length > 0
    ? new Set(sources.allowedEventIds)
    : null;

  const deduped = new Map<string, ToolEvidenceItem>();

  const consider = (rawTool: string, rawEventId: string, rawSummary?: string) => {
    const tool = normalizeToolName(rawTool);
    const eventId = String(rawEventId || '').trim();
    const summary = typeof rawSummary === 'string' ? rawSummary.trim() : '';
    if (!tool || !eventId || eventId === 'unknown-game' || !summary) return;
    if (isFailedSummaryText(summary)) return;
    if (allowedSet && !allowedSet.has(eventId)) return;

    const key = `${tool}::${eventId}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, { tool, eventId, summary });
      return;
    }
    const existingEmpty = isEmptyToolSummary(existing.summary);
    const incomingEmpty = isEmptyToolSummary(summary);
    if ((existingEmpty && !incomingEmpty) || (!incomingEmpty && summary.length > existing.summary.length)) {
      deduped.set(key, { tool, eventId, summary });
    }
  };

  for (const item of sources.prePassedItems || []) {
    if (item) consider(item.tool, item.eventId, item.summary);
  }
  for (const trace of sources.toolCallTrace || []) {
    if (trace && trace.status === 'data' && trace.summary) {
      consider(trace.tool, trace.eventId, trace.summary);
    }
  }
  for (const item of sources.pulledItems || []) {
    if (item) consider(item.tool, item.eventId, item.summary);
  }

  return Array.from(deduped.values());
}

/**
 * Merges earlier successful run tool results with newly pulled Critic evidence for the games under review.
 * Never drops tools that already ran for the selected/discussed games.
 */
export function mergeScopedToolEvidence(params: {
  prePassedItems?: ToolEvidenceItem[];
  pulledItems?: ToolEvidenceItem[];
  toolCallTrace?: ToolCallTraceEntry[];
  prePassedEvidenceText?: string;
  freshRetryEvidenceParts?: string[];
  selectedGameIds?: string[];
  slateSource?: unknown;
}): {
  mergedEvidenceText: string;
  mergedItems: ToolEvidenceItem[];
} {
  const selectedIds = Array.isArray(params.selectedGameIds)
    ? Array.from(new Set(params.selectedGameIds.filter(Boolean)))
    : [];
  const hasScopedSelection = selectedIds.length > 0;
  const selectedSet = new Set(selectedIds);

  const structuredItems = collectSuccessfulEvidenceItems({
    prePassedItems: params.prePassedItems,
    pulledItems: params.pulledItems,
    toolCallTrace: params.toolCallTrace,
    allowedEventIds: hasScopedSelection ? selectedIds : undefined
  });

  const structuredEventIds = new Set(structuredItems.map(i => i.eventId));
  const structuredDigest = structuredItems.length > 0
    ? buildVerifierEvidence([{ toolEvidenceItems: structuredItems }], params.slateSource, selectedIds)
    : '';

  // Also preserve any pre-passed formatted EVENT blocks for selected games (or all blocks if no structured pulls ran)
  const parsedPreBlocks = parseVerifierEvidenceBlocks(params.prePassedEvidenceText || '');
  const extraSelectedBlocks: string[] = [];
  const extraFallbackBlocks: string[] = [];

  if (parsedPreBlocks.length > 0) {
    const byEventId = new Map<string, string[]>();
    for (const blk of parsedPreBlocks) {
      if (!byEventId.has(blk.eventId)) byEventId.set(blk.eventId, []);
      byEventId.get(blk.eventId)!.push(blk.text);
    }

    for (const [evId, texts] of byEventId.entries()) {
      const joined = texts.join('\n');
      if (hasScopedSelection && selectedSet.has(evId)) {
        if (!structuredEventIds.has(evId)) {
          extraSelectedBlocks.push(joined);
        } else {
          // If pre-passed block contains a tool prefix (INJ:/MKT:/FUND:) missing from structuredDigest for this event, append missing lines
          const existingToolsForEvent = new Set(
            structuredItems.filter(i => i.eventId === evId).map(i => normalizeToolName(i.tool))
          );
          const missingLines = joined
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(line => {
              if (/^INJ:/i.test(line)) return !existingToolsForEvent.has('get_injury_and_roster_delta');
              if (/^MKT:/i.test(line)) return !existingToolsForEvent.has('get_market_movement');
              if (/^FUND:/i.test(line)) return !existingToolsForEvent.has('get_matchup_fundamentals');
              return false;
            });
          if (missingLines.length > 0) {
            extraSelectedBlocks.push(`EVENT ${evId}\n${missingLines.join('\n')}`);
          }
        }
      } else if (!hasScopedSelection || (structuredItems.length === 0 && (!params.pulledItems || params.pulledItems.length === 0))) {
        if (!structuredEventIds.has(evId)) {
          extraFallbackBlocks.push(joined);
        }
      }
    }
  } else if (params.prePassedEvidenceText && params.prePassedEvidenceText.trim() && structuredItems.length === 0) {
    extraFallbackBlocks.push(params.prePassedEvidenceText.trim());
  }

  const retryParts = (params.freshRetryEvidenceParts || []).map(p => p.trim()).filter(Boolean);
  const parts = [
    structuredDigest,
    ...extraSelectedBlocks,
    ...extraFallbackBlocks,
    ...retryParts
  ].filter(Boolean);

  return {
    mergedEvidenceText: parts.join('\n\n'),
    mergedItems: structuredItems
  };
}

const HALLUCINATION_CRITIQUE_REGEX =
  /\b(?:hallucinat(?:ed|ion|ions|ing)?|fabricat(?:ed|ion|ing)?|invented|made\s+up|fictitious|not\s+(?:in|found\s+in|present\s+in|included\s+in|supported\s+by|backed\s+by|confirmed\s+by|shown\s+in)\s+(?:the\s+)?(?:provided\s+|supplied\s+)?(?:tool\s+)?(?:evidence|results?|data|trace|output|context|reports?)|no\s+(?:matching\s+)?(?:tool\s+)?(?:evidence|results?|data|record)\s+(?:for|supporting|showing|confirming)|missing\s+from\s+(?:the\s+)?(?:provided\s+|supplied\s+)?(?:tool\s+)?(?:evidence|results?|data|trace)|unverified\s+(?:injur(?:y|ies)|claim|claims|player|players|out|outs|status)|ungrounded\s+(?:injur(?:y|ies)|player|players|out|outs))\b/i;

const NON_HALLUCINATION_VETO_REGEX =
  /\b(?:fatal\s+injury|critical\s+roster\s+scratch|injury\s+misattribution|wrong\s+team|opposing\s+team|opposite\s+(?:team|side)|row\s+(?:id\s+)?mismatch|spread\s+side\s+mismatch|flipped\s+(?:the\s+)?(?:sign|spread)|schema\s+violation|invalid\s+json|empty\s+object|missing\s+pass\s+field|uncovered\s+(?:game|pick|leg)|must\s+be\s+removed\s+due\s+to\s+(?:injury|scratch)|vetoed\s+leg\s+(?:kept|rewritten))\b/i;

const PURE_HALLUCINATION_SUFFIX_REGEX =
  /^(?:hallucinated|hallucination|fabricated|unverified|ungrounded|rejected|veto(?:ed)?|failed(?:\s+verification)?|not\s+in\s+(?:the\s+)?(?:provided\s+)?(?:tool\s+)?evidence)\.?$/i;

const NON_PLAYER_PHRASE_REGEX =
  /^(?:\d+\s+)?(?:forwards?|defensemen|defencemen|defenders?|goalies?|goaltenders?|guards?|centers?|wings?|players?|starters?|rotations?|outs?|injuries?|injured|scratches?|roster|bench|lineup|depth|key\s+players?|multiple\s+(?:players?|forwards?|outs?|injuries?)|several\s+(?:players?|forwards?|outs?)|missing|none|all|both)$/i;

const CAPITALIZED_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'without', 'from', 'not', 'are', 'was', 'were', 'has', 'have', 'had',
  'out', 'outs', 'doubtful', 'questionable', 'probable', 'ir', 'injured', 'injury', 'injuries',
  'hallucinated', 'hallucination', 'fabricated', 'invented', 'ungrounded', 'unverified', 'missing',
  'provided', 'supplied', 'tool', 'tools', 'evidence', 'result', 'results', 'trace', 'data', 'report',
  'reports', 'proposal', 'critic', 'veto', 'vetoed', 'failed', 'attempt', 'game', 'games', 'slate',
  'team', 'teams', 'player', 'players', 'forward', 'forwards', 'guard', 'guards', 'center', 'centers',
  'defenseman', 'defensemen', 'goalie', 'goalies', 'starter', 'starters', 'roster', 'lineup', 'status',
  'market', 'markets', 'moneyline', 'spread', 'total', 'fundamentals', 'form', 'record', 'parlay',
  'leg', 'legs', 'pick', 'picks', 'bet', 'bets', 'home', 'away', 'nba', 'nhl', 'nfl', 'mlb', 'ncaab',
  'ncaaf', 'both', 'all', 'none', 'only', 'also', 'but', 'that', 'this', 'these', 'those', 'their',
  'claim', 'claims', 'cited', 'listed', 'mentioned', 'neither', 'however', 'therefore'
]);

const POSITION_OR_GROUP_COUNT_REGEX =
  /\b(\d+|multiple|several|key)\s+(?:forwards?|defensemen|defencemen|guards?|centers?|wings?|players?|starters?|outs?|injuries?|scratches?)\b|\b(?:forwards?|defensemen|guards?|starters?|outs?)\s+(?:out|injured|scratched)\b/i;

function matchTeamsInFeedback(
  text: string,
  headers: GameHeader[],
  injuries: AuthoritativeInjury[]
): Array<{ eventId?: string; teamLabel: string; aliases: string[]; abbr?: string; sport?: string }> {
  const matched: Array<{ eventId?: string; teamLabel: string; aliases: string[]; abbr?: string; sport?: string }> = [];
  const seenKey = new Set<string>();

  const candidates: Array<{ eventId?: string; teamLabel: string; aliases: string[]; abbr?: string; sport?: string }> = [];
  const candSeen = new Set<string>();

  const pushEntry = (rawLabel: string, eventId?: string, sportHint?: string) => {
    const clean = String(rawLabel || '').trim();
    if (!clean || /^(away|home|unknown|tbd)$/i.test(clean)) return;
    const entry = matchTeamByLabel(clean, sportHint);
    const key = entry ? `${entry.sport}:${entry.abbr}` : clean.toLowerCase();
    if (candSeen.has(key)) return;
    candSeen.add(key);

    const aliasSet = new Set<string>([clean.toLowerCase()]);
    if (entry) {
      aliasSet.add(entry.name.toLowerCase());
      aliasSet.add(entry.nickname.toLowerCase());
      if (entry.city.length >= 4) aliasSet.add(entry.city.toLowerCase());
      for (const a of entry.aliases) {
        if (a.length >= 4) aliasSet.add(a.toLowerCase());
      }
    }
    candidates.push({
      eventId,
      teamLabel: entry?.name || clean,
      aliases: Array.from(aliasSet),
      abbr: entry?.abbr,
      sport: entry?.sport || sportHint
    });
  };

  for (const h of headers) {
    pushEntry(h.away, h.eventId, h.sport);
    pushEntry(h.home, h.eventId, h.sport);
  }
  for (const inj of injuries) {
    pushEntry(inj.teamEntry?.name || inj.teamLabel, inj.eventId, inj.sport);
  }
  if (candidates.length === 0) {
    for (const t of ESPN_TEAMS) {
      pushEntry(t.name, undefined, t.sport);
    }
  }

  for (const cand of candidates) {
    const key = `${cand.eventId || ''}:${cand.abbr || cand.teamLabel.toLowerCase()}`;
    if (seenKey.has(key)) continue;
    const hitAlias = cand.aliases.some(a =>
      a.length >= 3 && new RegExp(`(?<![a-zA-Z0-9])${escapeRegex(a)}(?![a-zA-Z0-9])`, 'i').test(text)
    );
    const hitAbbr = cand.abbr && cand.abbr.length >= 2
      ? new RegExp(`(?<![a-zA-Z0-9])${escapeRegex(cand.abbr.toUpperCase())}(?![a-zA-Z0-9])`).test(text)
      : false;
    if (hitAlias || hitAbbr) {
      seenKey.add(key);
      matched.push(cand);
    }
  }

  return matched;
}

function buildTeamStopwords(headers: GameHeader[], injuries: AuthoritativeInjury[]): Set<string> {
  const words = new Set<string>(CAPITALIZED_STOPWORDS);
  const addLabel = (s?: string) => {
    if (!s) return;
    for (const tok of s.toLowerCase().split(/[^a-z]+/)) {
      if (tok.length >= 2) words.add(tok);
    }
  };
  for (const h of headers) {
    addLabel(h.away);
    addLabel(h.home);
  }
  for (const inj of injuries) {
    addLabel(inj.teamLabel);
    addLabel(inj.teamEntry?.name);
    addLabel(inj.teamEntry?.city);
    addLabel(inj.teamEntry?.nickname);
    addLabel(inj.teamEntry?.abbr);
  }
  for (const t of ESPN_TEAMS) {
    addLabel(t.name);
    addLabel(t.city);
    addLabel(t.nickname);
    addLabel(t.abbr);
  }
  return words;
}

interface ExtractedFeedbackPlayers {
  players: Array<{ name: string; teamScope?: { eventId?: string; teamLabel: string; aliases: string[]; abbr?: string } }>;
  hadNonPlayerGroupMention: boolean;
}

function extractCitedPlayersFromClause(
  clause: string,
  headers: GameHeader[],
  injuries: AuthoritativeInjury[],
  teamStopwords: Set<string>
): ExtractedFeedbackPlayers {
  const players: ExtractedFeedbackPlayers['players'] = [];
  const seen = new Set<string>();
  let hadNonPlayerGroupMention = false;

  const addPlayer = (rawName: string, teamScope?: { eventId?: string; teamLabel: string; aliases: string[]; abbr?: string }) => {
    const clean = rawName
      .replace(/\b(?:is|are|was|were)?\s*(?:OUT|DOUBTFUL|QUESTIONABLE|PROBABLE|IR|INJURED|SCRATCHED)\b/gi, '')
      .replace(/^[\s\-:,;()]+|[\s\-:,;()]+$/g, '')
      .trim();
    if (!clean || clean.length < 3) return;
    if (NON_PLAYER_PHRASE_REGEX.test(clean)) {
      hadNonPlayerGroupMention = true;
      return;
    }
    if (/^\d+(?:\s*-\s*\d+)*$/.test(clean)) return;
    if (/^[a-z]{2,5}-\d+$/i.test(clean)) return;
    if (/^R\d+$/i.test(clean)) return;
    const lowerTokens = clean.toLowerCase().split(/\s+/).filter(Boolean);
    if (lowerTokens.length === 0 || lowerTokens.every(t => teamStopwords.has(t))) return;

    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    players.push({ name: clean, teamScope });
  };

  // 1. Parenthetical lists, e.g. "Colorado (MacKinnon, Makar, Manson)" or "Portland OUTs (Morant, Sharpe, Williams)"
  const parenRx = /([A-Za-z0-9.\s'-]{0,40})\(([^()]{2,180})\)/g;
  let m: RegExpExecArray | null;
  while ((m = parenRx.exec(clause)) !== null) {
    const prefix = (m[1] || '').trim();
    const inside = (m[2] || '').trim();
    if (/^(?:nhl|nba|nfl|mlb|ncaab|ncaaf)-\d+$/i.test(inside)) continue;
    if (/^R\d+$/i.test(inside)) continue;
    if (/^(?:OUT|DOUBTFUL|QUESTIONABLE|PROBABLE|IR|ML|spread|total)$/i.test(inside)) continue;

    const prefixTeams = matchTeamsInFeedback(prefix, headers, injuries);
    const teamScope = prefixTeams.length === 1 ? prefixTeams[0] : undefined;

    const items = inside.split(/\s*(?:,|;|\/|\band\b|&)\s*/i).map(s => s.trim()).filter(Boolean);
    for (const item of items) {
      if (NON_PLAYER_PHRASE_REGEX.test(item) || POSITION_OR_GROUP_COUNT_REGEX.test(item)) {
        hadNonPlayerGroupMention = true;
        continue;
      }
      addPlayer(item, teamScope);
    }
  }

  // 2. Direct player mentions paired with status ("MacKinnon OUT", "Makar/MacKinnon/Manson OUT", "Cale Makar is OUT")
  const statusListRx =
    /\b([A-Z][a-zA-Z'-]{2,}(?:(?:\s+[A-Z][a-zA-Z'-]{2,})|(?:\s*(?:,|\/|&|\band\b)\s*[A-Z][a-zA-Z'-]{2,}))*)\s+(?:is\s+|are\s+)?(?:OUT|DOUBTFUL|QUESTIONABLE|IR|INJURED|SCRATCHED)\b/g;
  while ((m = statusListRx.exec(clause)) !== null) {
    const rawList = m[1];
    const items = rawList.split(/\s*(?:,|\/|&|\band\b)\s*/i).map(s => s.trim()).filter(Boolean);
    for (const item of items) {
      addPlayer(item);
    }
  }

  // 3. Direct quoted player or claim phrases like '"Makar OUT"' or '"FakePlayer"'
  const quotedRx = /["']([^"']{3,60})["']/g;
  while ((m = quotedRx.exec(clause)) !== null) {
    const inner = m[1].trim();
    if (/\b(?:OUT|DOUBTFUL|QUESTIONABLE|IR)\b/i.test(inner)) {
      const stripped = inner.replace(/\b(?:is|are)?\s*(?:OUT|DOUBTFUL|QUESTIONABLE|IR)\b/gi, '').trim();
      for (const item of stripped.split(/\s*(?:,|\/|&|\band\b)\s*/i)) {
        addPlayer(item);
      }
    }
  }

  if (POSITION_OR_GROUP_COUNT_REGEX.test(clause)) {
    hadNonPlayerGroupMention = true;
  }

  return { players, hadNonPlayerGroupMention };
}

function isPlayerConfirmedInEvidence(
  playerName: string,
  teamScope: { eventId?: string; teamLabel: string; aliases: string[]; abbr?: string } | undefined,
  injuries: AuthoritativeInjury[],
  successfulEvidence: string
): boolean {
  const clean = playerName.trim().toLowerCase();
  if (!clean) return false;
  const parts = clean.split(/\s+/).filter(Boolean);
  const lastToken = parts[parts.length - 1];

  const matchesTeam = (inj: AuthoritativeInjury): boolean => {
    if (!teamScope) return true;
    if (teamScope.eventId && inj.eventId && teamScope.eventId !== inj.eventId) return false;
    if (teamScope.abbr && inj.teamEntry?.abbr && teamScope.abbr.toUpperCase() === inj.teamEntry.abbr.toUpperCase()) {
      return true;
    }
    return teamScope.aliases.some(a => inj.teamAliases.includes(a));
  };

  for (const inj of injuries) {
    if (!matchesTeam(inj)) continue;
    const fullLower = inj.playerName.toLowerCase();
    const lastLower = inj.lastName.toLowerCase();
    if (fullLower === clean || lastLower === clean || (parts.length > 1 && fullLower.includes(clean))) {
      return true;
    }
    if (lastToken.length >= 4 && lastLower === lastToken && (parts.length === 1 || fullLower.startsWith(parts[0][0]))) {
      return true;
    }
  }

  // Fallback: direct mention in successful evidence text (only when no team mismatch contradicts it)
  if (!teamScope) {
    const directRx = new RegExp(`(?<![a-zA-Z])${escapeRegex(playerName.trim())}(?![a-zA-Z])`, 'i');
    if (directRx.test(successfulEvidence)) {
      return true;
    }
  }

  return false;
}

/**
 * Determines whether a Critic's rejection feedback is a FALSE hallucination / "not in evidence" veto
 * because every cited injury, player, team, record, or game tool claim IS confirmed by successful
 * tool results already present in the run trace.
 *
 * Strictly fail-closed: returns false if ANY cited player/team/record/game lacks matching
 * successful trace evidence, or if ANY clause raises a non-hallucination veto (fatal injury risk,
 * row mismatch, spread side mismatch, schema error, etc.).
 */
export function isFalseHallucinationCritique(
  feedback: string | undefined,
  _proposal: unknown,
  evidenceText: string,
  options?: {
    headers?: GameHeader[];
    toolCallTrace?: ToolCallTraceEntry[];
    marketToolRecords?: MarketToolRecord[];
    slateText?: string;
  }
): boolean {
  if (!feedback || typeof feedback !== 'string' || !feedback.trim()) return false;
  const normFeedback = normalizeText(feedback).trim();

  if (!HALLUCINATION_CRITIQUE_REGEX.test(normFeedback)) return false;
  if (NON_HALLUCINATION_VETO_REGEX.test(normFeedback)) return false;

  const traceSummaries = (options?.toolCallTrace || [])
    .filter(e => e && e.status === 'data' && typeof e.summary === 'string' && e.summary.trim().length > 0)
    .map(e => e.summary!.trim());

  const combinedRawEvidence = [evidenceText || '', ...traceSummaries].filter(Boolean).join('\n\n');
  const successfulEvidence = extractSuccessfulEvidenceText(combinedRawEvidence);
  if (!successfulEvidence.trim()) return false;

  const headers = options?.headers && options.headers.length > 0
    ? options.headers
    : parseGameHeaders(options?.slateText || successfulEvidence);
  const injuries = extractAuthoritativeInjuries(successfulEvidence, options?.slateText);
  const ledger = buildToolPullLedger(successfulEvidence, {
    toolCallTrace: options?.toolCallTrace,
    marketToolRecords: options?.marketToolRecords
  });
  const teamStopwords = buildTeamStopwords(headers, injuries);

  const clauses = normFeedback
    .split(/(?<=[.!?])\s+|\n+|;\s+/)
    .map(c => c.trim())
    .filter(Boolean);

  let verifiedCount = 0;

  for (const clause of clauses) {
    if (PURE_HALLUCINATION_SUFFIX_REGEX.test(clause)) continue;
    if (NON_HALLUCINATION_VETO_REGEX.test(clause)) return false;

    // Require clause to be part of a hallucination/not-in-evidence critique (reject unrelated extra vetoes)
    const isClauseHallucination =
      HALLUCINATION_CRITIQUE_REGEX.test(clause) ||
      /\b(?:not\s+in|missing|hallucinat|fabricat|unverified|ungrounded|no\s+(?:tool\s+)?(?:data|evidence))\b/i.test(clause);
    if (!isClauseHallucination) {
      // Allow purely neutral/contextual transition sentences only if they don't assert a separate failure
      if (/\b(?:fail|veto|reject|invalid|wrong|error|violation|mismatch|contradict|remove|drop|fatal)\b/i.test(clause)) {
        return false;
      }
      continue;
    }

    // 1. Verify any explicitly cited W-L / W-L-OTL records in the hallucination critique
    const recordMatches = Array.from(clause.matchAll(/\b(\d{1,2}\s*-\s*\d{1,2}(?:\s*-\s*\d{1,2})?)\b/g));
    for (const rm of recordMatches) {
      const rec = rm[1].replace(/\s+/g, '');
      const recRx = new RegExp(`(?<![\\d-])${escapeRegex(rec)}(?![\\d-])`);
      if (!recRx.test(successfulEvidence)) {
        return false;
      }
      verifiedCount++;
    }

    // 2. Verify all explicitly cited players
    const { players, hadNonPlayerGroupMention } = extractCitedPlayersFromClause(
      clause,
      headers,
      injuries,
      teamStopwords
    );
    for (const p of players) {
      if (!isPlayerConfirmedInEvidence(p.name, p.teamScope, injuries, successfulEvidence)) {
        return false;
      }
      verifiedCount++;
    }

    // 3. Verify all cited event IDs explicitly mentioned in the clause
    const explicitEventIds = Array.from(clause.matchAll(/\b((?:nhl|nba|nfl|mlb|ncaab|ncaaf|wnba|epl|mls)-\d+)\b/gi))
      .map(m => m[1]);
    for (const evId of explicitEventIds) {
      const evMap = ledger.byEvent.get(evId);
      const hasData = evMap ? Array.from(evMap.values()).some(s => s === 'data') : false;
      if (!hasData && !successfulEvidence.includes(evId)) {
        return false;
      }
      verifiedCount++;
    }

    // 4. Verify all cited teams in the clause (e.g., "Ottawa (4 forwards)", "Colorado (...)", "Portland OUTs")
    const mentionedTeams = matchTeamsInFeedback(clause, headers, injuries);
    const mentionsMarket = /\b(?:market|odds|spread|moneyline|ml_home|ml_away|line\s+movement)\b/i.test(clause);
    const mentionsForm = /\b(?:fundamentals?|form|record|l5|l10|pace|margin|h2h)\b/i.test(clause);
    const mentionsInjury =
      hadNonPlayerGroupMention ||
      players.length > 0 ||
      /\b(?:injur(?:y|ies|ed)|out|outs|doubtful|questionable|roster|scratch(?:es|ed)?|forwards?|defensemen|guards?|starters?)\b/i.test(
        clause
      );

    for (const team of mentionedTeams) {
      const teamInjuries = injuries.filter(inj => {
        if (team.eventId && inj.eventId && team.eventId !== inj.eventId) return false;
        if (team.abbr && inj.teamEntry?.abbr && team.abbr.toUpperCase() === inj.teamEntry.abbr.toUpperCase()) {
          return true;
        }
        return team.aliases.some(a => inj.teamAliases.includes(a));
      });

      const evMap = team.eventId ? ledger.byEvent.get(team.eventId) : undefined;
      const hasInjuryData =
        teamInjuries.length > 0 ||
        evMap?.get('get_injury_and_roster_delta') === 'data';
      const hasMarketData = evMap?.get('get_market_movement') === 'data';
      const hasFundData = evMap?.get('get_matchup_fundamentals') === 'data';

      if (mentionsInjury && !hasInjuryData) {
        return false;
      }
      if (mentionsMarket && !hasMarketData) {
        return false;
      }
      if (mentionsForm && !hasFundData) {
        return false;
      }
      if (!mentionsInjury && !mentionsMarket && !mentionsForm) {
        if (!hasInjuryData && !hasMarketData && !hasFundData) {
          return false;
        }
      }
      verifiedCount++;
    }
  }

  return verifiedCount > 0;
}
