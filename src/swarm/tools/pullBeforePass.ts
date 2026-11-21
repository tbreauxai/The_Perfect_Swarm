import { parseGameHeaders, type GameHeader } from '../context/gameHeaders.ts';
import { ESPN_TEAMS, matchTeamByLabel, type EspnTeamEntry } from './injuryAttribution.ts';
import type { MarketToolRecord } from './marketRowBinding.ts';

export const PULL_BEFORE_PASS_RULE = `PULL BEFORE PASS:
- Before saying a game has no fundamentals, injuries, or market data, call the tool for that game.
- If the tool returns data, use it. Do not say it was not fetched.
- If the tool returns empty or errors, then you may say that game has no data.
- Do not cite a record, score, or L5 form unless it is in a successful tool result.
- A pass is allowed only after the relevant tools were called, or the tool result was empty.`;

export type ToolCallStatus = 'data' | 'empty' | 'error';

export interface ToolCallTraceEntry {
  tool: string;
  eventId: string;
  status: ToolCallStatus;
  summary?: string;
}

export interface PullBeforePassAuditOptions {
  headers?: GameHeader[];
  toolCallTrace?: ToolCallTraceEntry[];
  availableTools?: string[];
  marketToolRecords?: MarketToolRecord[];
  requireAllSlateToolsOnPass?: boolean;
}

export interface PullBeforePassAuditResult {
  pass: boolean;
  violations: string[];
  flags: string[];
  unqueriedGameIds: string[];
  missingToolsByGame: Record<string, string[]>;
  feedback?: string;
}

const CORE_SPORTS_TOOLS = [
  'get_matchup_fundamentals',
  'get_injury_and_roster_delta',
  'get_market_movement'
] as const;

const STATUS_PRIORITY: Record<ToolCallStatus, number> = {
  error: 1,
  empty: 2,
  data: 3
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value: string): string {
  return value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-');
}

function normalizeToolName(name: string): string {
  return String(name || '').trim().replace(/_v1$/i, '');
}

export function isEmptyToolSummary(summary: string): boolean {
  if (!summary || typeof summary !== 'string') return false;
  return /\bno\s+canonical\s+game\s+for\b|\b0\s+snapshots\b|\bno\s+FanDuel\s+snapshots\s+tracked\b|\bNo\s+game\s+logs\s+available\b|\bsample\s+0\b|"source"\s*:\s*"empty"|"status"\s*:\s*"no_rows"/i.test(
    summary
  );
}

const FUNDAMENTALS_MOD =
  '(?:(?:any|specific|clear|detailed|supporting|underlying|verified|available|full|additional|further|sufficient|enough|adequate|game|matchup|team|form|fetched|pulled|retrieved)\\s+){0,3}';
const MARKET_MOD =
  '(?:(?:any|specific|detailed|supporting|fresh|live|current|verified|confirmed|reliable|available|actual|sufficient|enough|adequate|fetched|pulled|retrieved)\\s+){0,2}';

export function looksLikePassOrMissingDataClaim(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const norm = normalizeText(text);
  if (/"picks"\s*:\s*\[\s*\]/i.test(norm)) return true;
  if (/"status"\s*:\s*"no_play"/i.test(norm)) return true;
  if (/ui_title["']?\s*:\s*["']Insufficient data["']/i.test(norm)) return true;
  return new RegExp(
    `\\b(?:no[\\s_-]?play|passing\\s+on|pass\\s+on|recommend(?:ing)?\\s+a\\s+pass|take\\s+a\\s+pass|insufficient\\s+data|not\\s+fetched|not\\s+pulled|${FUNDAMENTALS_MOD}fundamentals\\s+(?:are\\s+|were\\s+|is\\s+|was\\s+)?(?:missing|unavailable|absent)|(?:missing|lacking|without|no)\\s+${FUNDAMENTALS_MOD}fundamentals|no\\s+${MARKET_MOD}market\\s+(?:movement|data)|${MARKET_MOD}market\\s+(?:movement|data)\\s+(?:is|was)?\\s*(?:missing|not\\s+fetched|unavailable)|no\\s+injury\\s+(?:data|reports?)|injury\\s+(?:data|reports?)\\s+(?:is|are|was|were)?\\s*(?:missing|not\\s+fetched|unavailable))\\b`,
    'i'
  ).test(norm);
}

export function mergeToolCallTraceEntries(entries: ToolCallTraceEntry[]): ToolCallTraceEntry[] {
  const merged = new Map<string, ToolCallTraceEntry>();
  for (const raw of entries || []) {
    if (!raw || !raw.tool || !raw.eventId || raw.eventId === 'unknown-game') continue;
    const tool = normalizeToolName(raw.tool);
    const eventId = raw.eventId.trim();
    const key = `${tool}::${eventId}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        tool,
        eventId,
        status: raw.status,
        ...(raw.summary ? { summary: raw.summary } : {})
      });
      continue;
    }
    if (STATUS_PRIORITY[raw.status] > STATUS_PRIORITY[existing.status]) {
      merged.set(key, {
        tool,
        eventId,
        status: raw.status,
        ...(raw.summary ? { summary: raw.summary } : (existing.summary ? { summary: existing.summary } : {}))
      });
    } else if (!existing.summary && raw.summary) {
      existing.summary = raw.summary;
    }
  }
  return Array.from(merged.values());
}

export function buildToolCoverageSummaryLine(
  trace: ToolCallTraceEntry[],
  headers: GameHeader[]
): string {
  const deduped = mergeToolCallTraceEntries(trace);
  if (deduped.length === 0) return '';

  const slateIds = headers.map(h => h.eventId).filter(Boolean);
  const traceIds = Array.from(new Set(deduped.map(t => t.eventId)));
  const denominator = slateIds.length > 0 ? slateIds.length : traceIds.length;
  const scopeSet = slateIds.length > 0 ? new Set(slateIds) : new Set(traceIds);

  const byTool = new Map<string, { data: number; empty: number; error: number; emptyIds: string[] }>();
  for (const t of CORE_SPORTS_TOOLS) {
    byTool.set(t, { data: 0, empty: 0, error: 0, emptyIds: [] });
  }
  for (const item of deduped) {
    if (!byTool.has(item.tool) || !scopeSet.has(item.eventId)) continue;
    const stats = byTool.get(item.tool)!;
    if (item.status === 'data') stats.data++;
    else if (item.status === 'empty') {
      stats.empty++;
      stats.emptyIds.push(item.eventId);
    } else stats.error++;
  }

  const parts: string[] = [];
  const emptyNotes: string[] = [];
  for (const tool of CORE_SPORTS_TOOLS) {
    const s = byTool.get(tool)!;
    const total = s.data + s.empty + s.error;
    if (total === 0) continue;
    const shortName = tool.replace('get_', '');
    parts.push(`${shortName}=${total}/${denominator} (${s.data} data, ${s.empty} empty)`);
    if (s.emptyIds.length > 0) {
      emptyNotes.push(`${shortName} empty: ${s.emptyIds.join(',')}`);
    }
  }
  if (parts.length === 0) return '';

  const prefix = `Tool pull status (${denominator} slate games): `;
  let line = `${prefix}${parts.join('; ')}.`;
  if (emptyNotes.length > 0) {
    const withEmpty = `${line} ${emptyNotes.join('; ')}.`;
    if (withEmpty.length <= 220) {
      line = withEmpty;
    }
  }
  if (line.length <= 220) return line;
  return `${line.slice(0, 217).trimEnd()}...`;
}

export interface ToolPullLedger {
  byEvent: Map<string, Map<string, ToolCallStatus>>;
  toolsSeen: Set<string>;
  eventIdsSeen: Set<string>;
}

export function buildToolPullLedger(
  evidenceText: string,
  options?: PullBeforePassAuditOptions
): ToolPullLedger {
  const byEvent = new Map<string, Map<string, ToolCallStatus>>();
  const toolsSeen = new Set<string>();
  const eventIdsSeen = new Set<string>();

  const record = (eventId: string, toolName: string, status: ToolCallStatus) => {
    const ev = String(eventId || '').trim();
    const tool = normalizeToolName(toolName);
    if (!ev || ev === 'unknown-game' || !tool) return;
    toolsSeen.add(tool);
    eventIdsSeen.add(ev);
    let m = byEvent.get(ev);
    if (!m) {
      m = new Map<string, ToolCallStatus>();
      byEvent.set(ev, m);
    }
    const prev = m.get(tool);
    if (!prev || STATUS_PRIORITY[status] > STATUS_PRIORITY[prev]) {
      m.set(tool, status);
    }
  };

  for (const entry of options?.toolCallTrace || []) {
    if (!entry) continue;
    record(entry.eventId, entry.tool, entry.status);
  }

  for (const h of options?.headers || []) {
    if (!h?.eventId) continue;
    if ((h.options || []).some(o => /\bML\s+[-+]?\d/.test(o?.text || ''))) {
      record(h.eventId, 'get_market_movement', 'data');
    }
  }

  for (const rec of options?.marketToolRecords || []) {
    if (!rec || !rec.eventId) continue;
    const status: ToolCallStatus = rec.summary && isEmptyToolSummary(rec.summary) ? 'empty' : 'data';
    record(rec.eventId, rec.tool || 'get_market_movement', status);
  }

  if (evidenceText && typeof evidenceText === 'string') {
    let currentEventId = '';
    for (const rawLine of evidenceText.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^\[Not Fetched\]:/i.test(line)) continue;

      const evMatch = line.match(/^EVENT\s+([^\s]+)/i) || line.match(/^([a-z]{2,5}-\d+):/i);
      if (evMatch && evMatch[1]) {
        currentEventId = evMatch[1].trim();
      }

      const fundErr = line.match(/Error\s+fetching\s+matchup\s+fundamentals\s+for\s+([^\s:]+):/i);
      if (fundErr) {
        record(fundErr[1], 'get_matchup_fundamentals', 'error');
        continue;
      }
      const mktErr = line.match(/Error\s+fetching\s+market\s+movement\s+for\s+([^\s:(]+)/i);
      if (mktErr) {
        record(mktErr[1], 'get_market_movement', 'error');
        continue;
      }
      const injErr = line.match(/Error\s+fetching\s+injury\/roster\s+delta\s+for\s+([^\s:]+):/i);
      if (injErr) {
        record(injErr[1], 'get_injury_and_roster_delta', 'error');
        continue;
      }

      const fundBracket = line.match(/\[MATCHUP FUNDAMENTALS:\s*([^\s|\]]+)/i);
      if (fundBracket) {
        record(
          fundBracket[1],
          'get_matchup_fundamentals',
          isEmptyToolSummary(line) ? 'empty' : 'data'
        );
      }

      const mktBracket = line.match(/\[MARKET MOVEMENT:\s*([^\s|\]]+)/i);
      if (mktBracket) {
        record(
          mktBracket[1],
          'get_market_movement',
          isEmptyToolSummary(line) ? 'empty' : 'data'
        );
      }

      const injBracket = line.match(/\[INJURY(?:\s*&\s*ROSTER\s*DELTA)?:\s*([^\s|\]]+)/i);
      if (injBracket) {
        record(
          injBracket[1],
          'get_injury_and_roster_delta',
          isEmptyToolSummary(line) ? 'empty' : 'data'
        );
      }

      if (currentEventId) {
        if (/^MKT:/i.test(line)) {
          record(
            currentEventId,
            'get_market_movement',
            isEmptyToolSummary(line) ? 'empty' : 'data'
          );
        } else if (/^FUND:/i.test(line)) {
          record(
            currentEventId,
            'get_matchup_fundamentals',
            isEmptyToolSummary(line) ? 'empty' : 'data'
          );
        } else if (/^INJ:/i.test(line)) {
          record(
            currentEventId,
            'get_injury_and_roster_delta',
            isEmptyToolSummary(line) ? 'empty' : 'data'
          );
        }
      }
    }
  }

  return { byEvent, toolsSeen, eventIdsSeen };
}

interface GameMentionEntry {
  eventId: string;
  rowIds: string[];
  nameAliases: string[];
  abbrAliases: string[];
}

const COLLEGE_RAW_STOP_TOKENS = new Set([
  'state', 'tech', 'university', 'college', 'north', 'south', 'east', 'west',
  'central', 'western', 'eastern', 'northern', 'southern', 'golden', 'blue',
  'red', 'green', 'black', 'white', 'crimson', 'city', 'team'
]);

function buildGameMentionEntries(headers: GameHeader[]): GameMentionEntry[] {
  const cityCounts = new Map<string, number>();
  const resolvedTeams = headers.map(h => ({
    header: h,
    awayEntry: matchTeamByLabel(h.away, h.sport),
    homeEntry: matchTeamByLabel(h.home, h.sport)
  }));

  for (const item of resolvedTeams) {
    for (const entry of [item.awayEntry, item.homeEntry]) {
      if (!entry) continue;
      const c = entry.city.toLowerCase();
      cityCounts.set(c, (cityCounts.get(c) || 0) + 1);
    }
  }

  const rawTokenCounts = new Map<string, number>();
  for (const item of resolvedTeams) {
    const pairs: Array<[string, EspnTeamEntry | undefined]> = [
      [item.header.away, item.awayEntry],
      [item.header.home, item.homeEntry]
    ];
    for (const [rawName, entry] of pairs) {
      if (entry) continue;
      const cleanRaw = String(rawName || '').trim().toLowerCase();
      if (!cleanRaw || /^(away|home|unknown|tbd)$/i.test(cleanRaw)) continue;
      const uniqTokens = new Set(cleanRaw.split(/\s+/).filter(t => t.length >= 3));
      for (const tok of uniqTokens) {
        rawTokenCounts.set(tok, (rawTokenCounts.get(tok) || 0) + 1);
      }
    }
  }

  return resolvedTeams.map(({ header, awayEntry, homeEntry }) => {
    const nameAliases = new Set<string>();
    const abbrAliases = new Set<string>();

    const addEntryAliases = (rawName: string, entry?: EspnTeamEntry) => {
      const cleanRaw = String(rawName || '').trim().toLowerCase();
      if (cleanRaw && !/^(away|home|unknown|tbd)$/i.test(cleanRaw)) {
        nameAliases.add(cleanRaw);
        for (const tok of cleanRaw.split(/\s+/)) {
          if (entry) {
            if (tok.length >= 4) nameAliases.add(tok);
          } else if (
            tok.length >= 3 &&
            !COLLEGE_RAW_STOP_TOKENS.has(tok) &&
            (rawTokenCounts.get(tok) || 0) < 2
          ) {
            nameAliases.add(tok);
          }
        }
      }
      if (entry) {
        nameAliases.add(entry.name.toLowerCase());
        nameAliases.add(entry.nickname.toLowerCase());
        const cityLower = entry.city.toLowerCase();
        if ((cityCounts.get(cityLower) || 0) <= 1) {
          nameAliases.add(cityLower);
        }
        for (const a of entry.aliases) {
          if (a.length >= 4 && a !== cityLower) {
            nameAliases.add(a.toLowerCase());
          }
        }
        if (entry.abbr) {
          abbrAliases.add(entry.abbr.toUpperCase());
        }
      }
    };

    addEntryAliases(header.away, awayEntry);
    addEntryAliases(header.home, homeEntry);

    return {
      eventId: header.eventId,
      rowIds: (header.options || []).map(o => o.id.toUpperCase()).filter(Boolean),
      nameAliases: Array.from(nameAliases),
      abbrAliases: Array.from(abbrAliases)
    };
  });
}

function findMentionedGameIds(text: string, entries: GameMentionEntry[]): string[] {
  if (!text || entries.length === 0) return [];
  const matched = new Set<string>();
  for (const entry of entries) {
    if (entry.eventId && text.includes(entry.eventId)) {
      matched.add(entry.eventId);
      continue;
    }
    if (entry.rowIds.some(rId => new RegExp(`\\b${escapeRegex(rId)}\\b`, 'i').test(text))) {
      matched.add(entry.eventId);
      continue;
    }
    if (
      entry.nameAliases.some(
        alias => new RegExp(`(?<![a-zA-Z0-9])${escapeRegex(alias)}(?![a-zA-Z0-9])`, 'i').test(text)
      )
    ) {
      matched.add(entry.eventId);
      continue;
    }
    if (
      entry.abbrAliases.some(
        abbr => new RegExp(`(?<![a-zA-Z0-9])${escapeRegex(abbr)}(?![a-zA-Z0-9])`).test(text)
      )
    ) {
      matched.add(entry.eventId);
    }
  }
  return Array.from(matched);
}

const POLICY_ECHO_OR_NEGATED_REGEX =
  /\b(?:before\s+saying\s+a\s+game\s+has\s+no|do\s+not\s+say\s+(?:it\s+was\s+not\s+fetched|fundamentals\s+or\s+market\s+data|market\s+data)|pull\s+before\s+pass|no\s+missing\s+(?:fundamentals|injur|market)|(?<!\bno\s+|\bwithout\s+|\blacking\s+|\bno\s+\w+\s+)fundamentals\s+(?:are\s+|were\s+|is\s+|was\s+)?(?:present|available|complete|fetched|pulled)|(?<!\bno\s+|\bwithout\s+|\blacking\s+|\bno\s+\w+\s+)market\s+(?:movement|data)\s+(?:was|were|is|are)\s+(?:fetched|pulled|available|present))\b/i;

const MARKET_MISSING_REGEX = new RegExp(
  `\\b(?:no\\s+${MARKET_MOD}(?:(?:market(?:\\/odds)?|odds|betting)\\s+(?:movement|data)|line\\s+movement)(?:\\s+(?:or|and)\\s+(?:prop|props|player\\s+prop)\\s+data)?\\s+(?:was|were|has\\s+been)?\\s*(?:fetched|pulled|available|found|provided|returned)|${MARKET_MOD}(?:(?:market(?:\\/odds)?|odds|betting)\\s+(?:movement|data)|line\\s+movement)(?:\\s+(?:or|and)\\s+(?:prop|props)\\s+data)?\\s+(?:was|were|is|are)?\\s*(?:not\\s+(?:fetched|pulled|available|found|provided|returned)|missing|unavailable|absent)|(?:missing|lack(?:s|ing)?(?:\\s+of)?|without|no)\\s+${MARKET_MOD}(?:(?:market(?:\\/odds)?|odds|betting)\\s+(?:movement|data)|line\\s+movement))\\b`,
  'i'
);

const FUNDAMENTALS_MISSING_REGEX = new RegExp(
  `\\b(?:${FUNDAMENTALS_MOD}fundamentals\\s+(?:are|were|is|was)?\\s*(?:missing|unavailable|not\\s+(?:fetched|pulled|available|found|provided|returned)|absent|incomplete)|(?:missing|no|lack(?:s|ing)?(?:\\s+of)?|without)\\s+${FUNDAMENTALS_MOD}fundamentals(?:\\s+data)?|no\\s+${FUNDAMENTALS_MOD}fundamentals\\s+(?:data\\s+)?(?:was|were)?\\s*(?:fetched|pulled|available|found|returned))\\b`,
  'i'
);

const INJURY_MISSING_REGEX =
  /\b(?:no\s+(?:injury|injuries|roster\s+delta)\s+(?:data|reports?|info)\s+(?:was|were)?\s*(?:fetched|pulled|available|found|provided|returned)|(?:injury|injuries|roster\s+delta)\s+(?:data|reports?|info)\s+(?:is|are|was|were)?\s*(?:missing|unavailable|not\s+(?:fetched|pulled|available|found|provided|returned)|absent)|(?:missing|lack(?:s|ing)?(?:\s+of)?|without)\s+(?:any\s+)?(?:injury|injuries|roster\s+delta)\s+(?:data|reports?))\b/i;

interface ClauseAuditFinding {
  flag: 'false_market_not_fetched' | 'false_missing_data_claim' | 'unqueried_missing_data_claim';
  violation: string;
}

function collectProposalTextSnippets(proposal: any): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  };

  if (typeof proposal === 'string') {
    push(proposal);
    return out;
  }
  if (!proposal || typeof proposal !== 'object') return out;

  push(proposal.summary);
  push(proposal.analysis);
  push(proposal.reason);
  push(proposal.rationale);
  push(proposal.conclusion);

  if (Array.isArray(proposal.insights)) {
    for (const ins of proposal.insights) push(ins);
  }
  if (Array.isArray(proposal.anomalies)) {
    for (const anom of proposal.anomalies) push(anom);
  }
  if (Array.isArray(proposal.picks)) {
    for (const pk of proposal.picks) {
      if (!pk || typeof pk !== 'object') {
        push(pk);
        continue;
      }
      push(pk.reason);
      push(pk.rationale);
      push(pk.edge);
      push(pk.note);
      push(pk.description);
      push(pk.claim);
      if (Array.isArray(pk.reasons)) {
        for (const r of pk.reasons) push(r);
      }
    }
  }
  if (Array.isArray(proposal.scorecards)) {
    for (const sc of proposal.scorecards) {
      if (!sc || typeof sc !== 'object') continue;
      push(sc.note);
      push(sc.reason);
      push(sc.summary);
      if (Array.isArray(sc.reasons)) {
        for (const r of sc.reasons) push(r);
      }
    }
  }
  if (proposal.scorecard && typeof proposal.scorecard === 'object') {
    push(proposal.scorecard.note);
    push(proposal.scorecard.reason);
    push(proposal.scorecard.summary);
  }
  if (Array.isArray(proposal.components)) {
    for (const comp of proposal.components) {
      if (!comp || typeof comp !== 'object' || !comp.props) continue;
      if (comp.type === 'InsightList' && Array.isArray(comp.props.insights)) {
        for (const ins of comp.props.insights) {
          push(typeof ins === 'string' ? ins : ins?.message);
        }
      } else if (comp.type === 'MetricCard') {
        push(comp.props.title);
        push(comp.props.value);
        push(comp.props.subtitle);
      } else if (comp.type === 'DataTable' && Array.isArray(comp.props.rows)) {
        for (const row of comp.props.rows) {
          if (!row || typeof row !== 'object') continue;
          for (const val of Object.values(row)) push(val);
        }
      }
    }
  }

  return out;
}

function auditMissingDataClaimInClause(
  clause: string,
  ledger: ToolPullLedger,
  mentionEntries: GameMentionEntry[],
  targetSlateIds: string[],
  availableToolsSet: Set<string>,
  hasExplicitAvailableTools: boolean,
  unqueriedSet: Set<string>,
  missingByGame: Record<string, string[]>
): ClauseAuditFinding[] {
  const norm = normalizeText(clause).trim();
  if (!norm || POLICY_ECHO_OR_NEGATED_REGEX.test(norm)) return [];

  const findings: ClauseAuditFinding[] = [];
  const mentionedGameIds = findMentionedGameIds(norm, mentionEntries);

  const getStatus = (eventId: string, tool: string): ToolCallStatus | undefined =>
    ledger.byEvent.get(eventId)?.get(tool);

  const isToolAvailable = (tool: string): boolean => {
    if (hasExplicitAvailableTools) return availableToolsSet.has(tool);
    return ledger.toolsSeen.has(tool);
  };

  const recordMissing = (eventId: string, tool: string) => {
    unqueriedSet.add(eventId);
    if (!missingByGame[eventId]) missingByGame[eventId] = [];
    if (!missingByGame[eventId].includes(tool)) missingByGame[eventId].push(tool);
  };

  // Check A: Market movement/data not fetched or missing
  if (MARKET_MISSING_REGEX.test(norm)) {
    const tool = 'get_market_movement';
    if (mentionedGameIds.length > 0) {
      for (const gId of mentionedGameIds) {
        const status = getStatus(gId, tool);
        if (status === 'data') {
          findings.push({
            flag: 'false_market_not_fetched',
            violation: `Claimed market movement/data was not fetched or missing for ${gId}, but ${tool} returned data.`
          });
        } else if (status === undefined && isToolAvailable(tool)) {
          recordMissing(gId, tool);
          findings.push({
            flag: 'unqueried_missing_data_claim',
            violation: `Claimed market movement/data is missing for ${gId} without calling ${tool}.`
          });
        }
      }
    } else {
      const dataGames = targetSlateIds.filter(gId => getStatus(gId, tool) === 'data');
      const emptyOrErrorGames = targetSlateIds.filter(gId => {
        const s = getStatus(gId, tool);
        return s === 'empty' || s === 'error';
      });
      const uncalledGames = targetSlateIds.filter(gId => getStatus(gId, tool) === undefined);

      if (dataGames.length > 0) {
        findings.push({
          flag: 'false_market_not_fetched',
          violation: `Claimed market movement/data was not fetched or missing, but ${tool} returned data for: ${dataGames.join(', ')}.`
        });
      } else if (isToolAvailable(tool) && uncalledGames.length > 0 && emptyOrErrorGames.length === 0) {
        for (const gId of uncalledGames) recordMissing(gId, tool);
        findings.push({
          flag: 'unqueried_missing_data_claim',
          violation: `Claimed market movement/data was not fetched without calling ${tool} for: ${uncalledGames.join(', ')}.`
        });
      }
    }
  }

  const hasAnyDataForGame = (gId: string): boolean => {
    const m = ledger.byEvent.get(gId);
    if (!m) return false;
    for (const st of m.values()) {
      if (st === 'data') return true;
    }
    return false;
  };
  const hasAnyDataAcrossSlate = (): boolean =>
    targetSlateIds.some(gId => hasAnyDataForGame(gId));

  // Check B: Matchup fundamentals or injury data missing / not fetched
  const checks: Array<{ tool: string; label: string; regex: RegExp }> = [
    { tool: 'get_matchup_fundamentals', label: 'matchup fundamentals', regex: FUNDAMENTALS_MISSING_REGEX },
    { tool: 'get_injury_and_roster_delta', label: 'injury data', regex: INJURY_MISSING_REGEX }
  ];

  for (const { tool, label, regex } of checks) {
    if (!regex.test(norm)) continue;

    if (mentionedGameIds.length > 0) {
      for (const gId of mentionedGameIds) {
        const status = getStatus(gId, tool);
        if (status === 'data') {
          findings.push({
            flag: 'false_missing_data_claim',
            violation: `Claimed ${label} missing/not fetched for ${gId}, but ${tool} returned data.`
          });
        } else if (status === undefined && (isToolAvailable(tool) || (!hasExplicitAvailableTools && hasAnyDataForGame(gId)))) {
          if (isToolAvailable(tool)) {
            recordMissing(gId, tool);
          }
          findings.push({
            flag: 'unqueried_missing_data_claim',
            violation: `Claimed ${label} missing for ${gId} without calling ${tool}.`
          });
        }
      }
      continue;
    }

    const countMatch = norm.match(/\b(\d+)\s+of\s+(\d+)\s+games?\b|\bfor\s+(\d+)\s+games?\b/i);
    const claimedCountStr = countMatch ? (countMatch[1] || countMatch[3]) : undefined;
    const claimedCount = claimedCountStr ? parseInt(claimedCountStr, 10) : NaN;

    const dataGames = targetSlateIds.filter(gId => getStatus(gId, tool) === 'data');
    const emptyOrErrorGames = targetSlateIds.filter(gId => {
      const s = getStatus(gId, tool);
      return s === 'empty' || s === 'error';
    });
    const uncalledGames = targetSlateIds.filter(gId => getStatus(gId, tool) === undefined);

    if (Number.isFinite(claimedCount) && claimedCount > 0) {
      if (claimedCount > emptyOrErrorGames.length) {
        if (uncalledGames.length > 0 && isToolAvailable(tool)) {
          for (const gId of uncalledGames) recordMissing(gId, tool);
          findings.push({
            flag: 'unqueried_missing_data_claim',
            violation: `Claimed ${label} missing for ${claimedCount} game(s), but only ${emptyOrErrorGames.length} returned empty/error and ${uncalledGames.length} game(s) were never queried (${uncalledGames.join(', ')}).`
          });
        } else if (targetSlateIds.length > 0) {
          findings.push({
            flag: 'false_missing_data_claim',
            violation: `Claimed ${label} missing for ${claimedCount} game(s), but only ${emptyOrErrorGames.length} returned empty/error.`
          });
        }
      }
    } else {
      if (uncalledGames.length > 0 && isToolAvailable(tool)) {
        for (const gId of uncalledGames) recordMissing(gId, tool);
        findings.push({
          flag: 'unqueried_missing_data_claim',
          violation: `Claimed ${label} missing/not fetched without calling ${tool} for: ${uncalledGames.join(', ')}.`
        });
      } else if (dataGames.length > 0 && emptyOrErrorGames.length === 0) {
        findings.push({
          flag: 'false_missing_data_claim',
          violation: `Claimed ${label} missing/not fetched, but ${tool} returned data for: ${dataGames.join(', ')}.`
        });
      } else if (uncalledGames.length > 0 && !hasExplicitAvailableTools && hasAnyDataAcrossSlate() && emptyOrErrorGames.length === 0) {
        findings.push({
          flag: 'unqueried_missing_data_claim',
          violation: `Claimed ${label} missing/not fetched without calling ${tool} while other tools returned data.`
        });
      }
    }
  }

  return findings;
}

/**
 * Deterministically audits a proposal or analyst report against PULL BEFORE PASS rules:
 *  A) Never claim market movement/data was not fetched when get_market_movement returned data
 *  B) Never claim fundamentals/injuries/market data missing for games that were never queried (or when tools returned data)
 *  C) Never pass without calling relevant tools for the discussed/slate games
 */
export function auditPullBeforePass(
  proposal: any,
  evidenceText: string,
  slateText?: string,
  options?: PullBeforePassAuditOptions
): PullBeforePassAuditResult {
  if (!proposal) {
    return { pass: true, violations: [], flags: [], unqueriedGameIds: [], missingToolsByGame: {} };
  }

  const headers = options?.headers && options.headers.length > 0
    ? options.headers
    : parseGameHeaders(slateText);
  const ledger = buildToolPullLedger(evidenceText, options);
  const mentionEntries = buildGameMentionEntries(headers);

  const slateIds = headers.map(h => h.eventId).filter(Boolean);
  const targetSlateIds = slateIds.length > 0
    ? slateIds
    : Array.from(ledger.eventIdsSeen);

  const hasExplicitAvailableTools = Array.isArray(options?.availableTools);
  const availableToolsSet = new Set(
    (options?.availableTools || []).map(normalizeToolName)
  );

  const violations: string[] = [];
  const flags: string[] = [];
  const unqueriedSet = new Set<string>();
  const missingByGame: Record<string, string[]> = {};

  const addViolation = (flag: string, msg: string) => {
    if (!flags.includes(flag)) flags.push(flag);
    if (!violations.includes(msg)) violations.push(msg);
  };

  const snippets = collectProposalTextSnippets(proposal);
  for (const snippet of snippets) {
    const clauses = snippet.split(/(?<=[.!?])\s+|\n+|;\s+/);
    for (const clause of clauses) {
      if (!clause.trim()) continue;
      const findings = auditMissingDataClaimInClause(
        clause,
        ledger,
        mentionEntries,
        targetSlateIds,
        availableToolsSet,
        hasExplicitAvailableTools,
        unqueriedSet,
        missingByGame
      );
      for (const f of findings) {
        addViolation(f.flag, f.violation);
      }
    }
  }

  // Empty-picks passes do not trigger Check C (premature_pass_without_tools) or top-up pulls.
  const unqueriedGameIds = Array.from(unqueriedSet);
  if (violations.length > 0) {
    return {
      pass: false,
      violations,
      flags,
      unqueriedGameIds,
      missingToolsByGame: missingByGame,
      feedback: `Veto (PULL BEFORE PASS): ${violations.join(' ')}`
    };
  }

  return {
    pass: true,
    violations: [],
    flags: [],
    unqueriedGameIds: [],
    missingToolsByGame: {}
  };
}

/**
 * Deterministically strips false "not fetched" or unqueried "missing data" claims from report prose
 * while preserving valid empty-tool or fatal-injury pass explanations.
 */
export function sanitizePullBeforePassClaims<T extends Record<string, any>>(
  report: T,
  evidenceText: string,
  slateText?: string,
  options?: PullBeforePassAuditOptions
): T {
  if (!report || typeof report !== 'object') return report;

  const headers = options?.headers && options.headers.length > 0
    ? options.headers
    : parseGameHeaders(slateText);
  const ledger = buildToolPullLedger(evidenceText, options);
  const mentionEntries = buildGameMentionEntries(headers);
  const slateIds = headers.map(h => h.eventId).filter(Boolean);
  const targetSlateIds = slateIds.length > 0 ? slateIds : Array.from(ledger.eventIdsSeen);
  const hasExplicitAvailableTools = Array.isArray(options?.availableTools);
  const availableToolsSet = new Set((options?.availableTools || []).map(normalizeToolName));

  const clauseHasViolation = (clause: string): boolean => {
    if (!clause.trim()) return false;
    const dummyUnqueried = new Set<string>();
    const dummyMissing: Record<string, string[]> = {};
    const findings = auditMissingDataClaimInClause(
      clause,
      ledger,
      mentionEntries,
      targetSlateIds,
      availableToolsSet,
      hasExplicitAvailableTools,
      dummyUnqueried,
      dummyMissing
    );
    return findings.length > 0;
  };

  const cleanTextField = (text: string): string => {
    const sentences = text.split(/(?<=[.!?])\s+|\n+/);
    const kept: string[] = [];
    for (const s of sentences) {
      if (!clauseHasViolation(s)) {
        kept.push(s);
        continue;
      }
      const withoutParen = s.replace(/\s*\([^)]*\)/g, '').replace(/\s{2,}/g, ' ').trim();
      if (withoutParen && withoutParen !== s.trim() && !clauseHasViolation(withoutParen)) {
        kept.push(withoutParen);
        continue;
      }
      const withoutInlineMissing = s
        .replace(
          new RegExp(
            `,?\\s*\\bwithout\\s+(?:${FUNDAMENTALS_MOD}fundamentals(?:\\s+data)?|${MARKET_MOD}(?:(?:market(?:\\/odds)?|odds|betting)\\s+(?:movement|data)|line\\s+movement)|(?:any\\s+)?(?:injury|injuries|roster\\s+delta)\\s+(?:data|reports?))\\b`,
            'gi'
          ),
          ''
        )
        .replace(/\s+([,.;!?])/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (withoutInlineMissing && withoutInlineMissing !== s.trim() && !clauseHasViolation(withoutInlineMissing)) {
        kept.push(withoutInlineMissing);
        continue;
      }
      const subParts = s.split(/;\s+|,\s*(?=(?:while|whereas|but|although|though|so|yet|and)\b)/i);
      if (subParts.length > 1) {
        const cleanSubs = subParts.filter(part => {
          if (clauseHasViolation(part)) return false;
          const strippedPart = part.replace(/^(?:and|so|but|while)\s+/i, '').trim();
          return strippedPart.split(/\s+/).filter(Boolean).length >= 3;
        });
        let rejoined = cleanSubs
          .join(', ')
          .replace(/^(?:and|so|but|while)\s+/i, '')
          .trim();
        if (rejoined) {
          rejoined = rejoined.charAt(0).toUpperCase() + rejoined.slice(1);
          if (!clauseHasViolation(rejoined)) {
            kept.push(rejoined);
          }
        }
      }
    }
    return kept.join(' ').trim();
  };

  const rep = report as Record<string, any>;

  if (Array.isArray(rep.picks)) {
    for (const pk of rep.picks) {
      if (!pk || typeof pk !== 'object') continue;
      for (const field of ['reason', 'rationale', 'edge', 'note', 'description', 'claim'] as const) {
        if (typeof pk[field] === 'string' && pk[field].trim()) {
          pk[field] = cleanTextField(pk[field]);
        }
      }
      if (Array.isArray(pk.reasons)) {
        pk.reasons = pk.reasons
          .map((r: any) => (typeof r === 'string' ? cleanTextField(r) : r))
          .filter((r: any) => typeof r !== 'string' || r.trim().length > 0);
      }
    }
  }

  if (Array.isArray(rep.scorecards)) {
    for (const sc of rep.scorecards) {
      if (!sc || typeof sc !== 'object') continue;
      for (const field of ['note', 'reason', 'summary'] as const) {
        if (typeof sc[field] === 'string' && sc[field].trim()) {
          sc[field] = cleanTextField(sc[field]);
        }
      }
    }
  }

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
            if (ins && typeof ins === 'object' && typeof ins.message === 'string') {
              return ins.message.trim().length > 0;
            }
            return true;
          });
      } else if (comp.type === 'MetricCard') {
        for (const pKey of ['title', 'value', 'subtitle'] as const) {
          if (typeof comp.props[pKey] === 'string') {
            comp.props[pKey] = cleanTextField(comp.props[pKey]);
          }
        }
      } else if (comp.type === 'DataTable' && Array.isArray(comp.props.rows)) {
        for (const row of comp.props.rows) {
          if (!row || typeof row !== 'object') continue;
          for (const rk of Object.keys(row)) {
            if (typeof row[rk] === 'string' && row[rk].trim()) {
              row[rk] = cleanTextField(row[rk]);
            }
          }
        }
      }
    }
  }

  return report;
}
