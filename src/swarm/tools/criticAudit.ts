import { filterPicksByCoverage, parseGameHeaders, type GameHeader } from '../context/gameHeaders.ts';
import {
  extractRowOptions,
  resolveTeamFromText,
  type RowOptionEntry
} from './marketRowBinding.ts';
import { ESPN_TEAMS, matchTeamByLabel } from './injuryAttribution.ts';
import { normalizePassIfAllLegsVetoed, type VetoedLegTarget } from './claimGrounding.ts';

export const CRITIC_AUDIT_RULE = `CRITIC AUDIT:
- If Quant proposes picks, the Critic must audit those picks.
- "No picks to evaluate" is only valid when the picks array is empty.
- Reject a pick whose spread does not match the tool or slate row.
- Reject a pick that cites PPG, a record, or form with no successful tool result.
- Do not keep a leg the Critic did not audit.
- If the Critic does not evaluate proposed picks, the result is a pass, not a recommendation.`;

export interface ProposedPickSummary {
  key: string;
  seat?: string;
  rowId?: string;
  eventId?: string;
  sideText: string;
  teamLabel?: string;
  teamAliases: string[];
  reason?: string;
  rawPick: any;
}

export interface CriticAuditState {
  proposedLegCount: number;
  criticSkippedAudit: boolean;
  auditedLegKeys: string[];
  unauditedLegs: VetoedLegTarget[];
  auditNote?: string;
}

const NO_PICKS_TO_EVALUATE_REGEX =
  /\b(?:no\s+picks?\s+(?:to\s+(?:evaluate|audit|review|verify|check|assess|veto)|were\s+proposed|proposed|provided|submitted|found|present|available|given)|nothing\s+to\s+(?:evaluate|audit|verify)|picks?\s+array\s+is\s+empty|empty\s+picks?\s+(?:array|list)|0\s+picks?\s+(?:to\s+evaluate|proposed))\b/i;

const COLLEGE_STOP_TOKENS = new Set([
  'state', 'tech', 'university', 'college', 'north', 'south', 'east', 'west',
  'central', 'western', 'eastern', 'northern', 'southern', 'golden', 'blue',
  'red', 'green', 'black', 'white', 'crimson', 'city', 'team', 'new', 'san',
  'saint', 'santa', 'los', 'las', 'el', 'la', 'de', 'of', 'the', 'at'
]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeWhitespace(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Detects Critic outputs that claim "No picks to evaluate" (or close variants).
 * Valid ONLY when the picks array is genuinely empty.
 */
export function isNoPicksToEvaluateText(text: unknown): boolean {
  if (typeof text !== 'string' || !text.trim()) return false;
  return NO_PICKS_TO_EVALUATE_REGEX.test(text);
}

/**
 * Extracts team aliases for a proposed pick label (supports both ESPN pro teams and college teams like "New Mexico Lobos").
 */
function buildPickAliases(
  sideText: string,
  rowEntry?: RowOptionEntry,
  header?: GameHeader
): { teamLabel?: string; teamAliases: string[] } {
  const aliases = new Set<string>();
  const contextTeams = [
    rowEntry?.away,
    rowEntry?.home,
    header?.away,
    header?.home
  ].filter((t): t is string => Boolean(t && t.trim()));

  const resolved = resolveTeamFromText(sideText || rowEntry?.text || '', rowEntry?.sport || header?.sport, contextTeams);
  let teamLabel = resolved?.name;

  const addTeamLabel = (raw?: string, sportHint?: string) => {
    const clean = normalizeWhitespace(raw || '');
    if (!clean || /^(away|home|unknown|tbd)$/i.test(clean)) return;
    const lower = clean.toLowerCase();
    aliases.add(lower);
    const entry = matchTeamByLabel(clean, sportHint);
    if (entry) {
      teamLabel = teamLabel || entry.name;
      aliases.add(entry.name.toLowerCase());
      aliases.add(entry.nickname.toLowerCase());
      if (entry.city.length >= 4) aliases.add(entry.city.toLowerCase());
      if (entry.abbr.length >= 2) aliases.add(entry.abbr.toLowerCase());
      for (const a of entry.aliases) {
        if (a.length >= 3) aliases.add(a.toLowerCase());
      }
      return;
    }

    // College / non-ESPN team aliases: full name, leading school phrase, and trailing mascot token
    const words = lower.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      const mascot = words[words.length - 1];
      if (mascot.length >= 4 && !COLLEGE_STOP_TOKENS.has(mascot)) {
        aliases.add(mascot);
      }
      const schoolPhrase = words.slice(0, words.length - 1).join(' ');
      if (schoolPhrase.length >= 4 && !COLLEGE_STOP_TOKENS.has(schoolPhrase)) {
        aliases.add(schoolPhrase);
      }
    }
    for (const w of words) {
      if (w.length >= 5 && !COLLEGE_STOP_TOKENS.has(w)) {
        aliases.add(w);
      }
    }
  };

  if (resolved) {
    const matchedEntry = ESPN_TEAMS.find(t => `${t.sport}:${t.abbr}` === resolved.canonical || t.name === resolved.name);
    if (matchedEntry) {
      addTeamLabel(matchedEntry.name, matchedEntry.sport);
    } else {
      addTeamLabel(resolved.name, rowEntry?.sport || header?.sport);
    }
  } else {
    // Try matching side text directly against context team names or tokens
    const sideClean = sideText
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[+-]\d+(?:\.\d+)?/g, ' ')
      .replace(/\b(?:ml|moneyline|spread|over|under|total|r\d+)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (sideClean.length >= 3) {
      addTeamLabel(sideClean, rowEntry?.sport || header?.sport);
    }
  }

  // Also add full team aliases from matching header side if resolved matches one side
  if (header && teamLabel) {
    const tlLower = teamLabel.toLowerCase();
    for (const sideTeam of [header.away, header.home]) {
      const stLower = String(sideTeam || '').toLowerCase();
      if (stLower && (stLower === tlLower || stLower.includes(tlLower) || tlLower.includes(stLower))) {
        addTeamLabel(sideTeam, header.sport);
      }
    }
  }

  return {
    ...(teamLabel ? { teamLabel } : {}),
    teamAliases: Array.from(aliases).filter(a => a.length >= 2)
  };
}

/**
 * Extracts normalized proposed pick summaries from a single proposal object or an array of proposer reports.
 */
export function extractProposedPickSummaries(
  proposalOrReports: unknown,
  headersInput?: GameHeader[],
  boardSource?: unknown
): ProposedPickSummary[] {
  const headers = headersInput && headersInput.length > 0
    ? headersInput
    : (boardSource ? parseGameHeaders(boardSource) : []);
  const rowMap = extractRowOptions(boardSource ? [boardSource] : [], headers);
  const headerById = new Map<string, GameHeader>(headers.map(h => [h.eventId, h]));

  const reports: any[] = Array.isArray(proposalOrReports)
    ? proposalOrReports
    : (proposalOrReports && typeof proposalOrReports === 'object' ? [proposalOrReports] : []);

  const summaries: ProposedPickSummary[] = [];
  const seenKeys = new Set<string>();

  const pushLeg = (rawPick: any, seatLabel?: string) => {
    if (!rawPick) return;
    let rowId: string | undefined;
    let eventId: string | undefined;
    let sideText = '';
    let reason = '';

    if (typeof rawPick === 'string') {
      sideText = normalizeWhitespace(rawPick);
      const rm = sideText.match(/\b(R\d+)\b/i);
      if (rm) rowId = rm[1].toUpperCase();
    } else if (typeof rawPick === 'object') {
      const rawRow = rawPick.row || rawPick.id;
      if (typeof rawRow === 'string' && /^R\d+$/i.test(rawRow.trim())) {
        rowId = rawRow.trim().toUpperCase();
      }
      const rawEv = rawPick.event_id || rawPick.eventId || rawPick.game_id;
      if (typeof rawEv === 'string' && rawEv.trim() && rawEv.trim() !== 'unknown-game') {
        eventId = rawEv.trim();
      }
      sideText = normalizeWhitespace(
        [rawPick.side, rawPick.pick, rawPick.selection, rawPick.team, rawPick.market]
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
          .join(' ')
      );
      if (!rowId && sideText) {
        const rm = sideText.match(/\b(R\d+)\b/i);
        if (rm) rowId = rm[1].toUpperCase();
      }
      reason = normalizeWhitespace(
        typeof rawPick.reason === 'string'
          ? rawPick.reason
          : (typeof rawPick.rationale === 'string'
              ? rawPick.rationale
              : (Array.isArray(rawPick.reasons) ? rawPick.reasons.join('; ') : ''))
      );
    }

    if (!sideText && !rowId) return;

    const rowEntry = rowId ? rowMap.get(rowId) : undefined;
    if (!eventId && rowEntry?.eventId) {
      eventId = rowEntry.eventId;
    }

    // Resolve eventId from header team match if still missing
    if (!eventId && sideText && headers.length > 0) {
      for (const h of headers) {
        const resolved = resolveTeamFromText(sideText, h.sport, [h.away, h.home]);
        if (resolved) {
          const awayR = resolveTeamFromText(h.away, h.sport, [h.away, h.home]);
          const homeR = resolveTeamFromText(h.home, h.sport, [h.away, h.home]);
          if (
            (awayR && awayR.canonical === resolved.canonical) ||
            (homeR && homeR.canonical === resolved.canonical)
          ) {
            eventId = h.eventId;
            break;
          }
        }
      }
    }

    const header = eventId ? headerById.get(eventId) : undefined;
    const { teamLabel, teamAliases } = buildPickAliases(sideText, rowEntry, header);

    const key = [
      rowId || '',
      eventId || '',
      (teamLabel || sideText).toLowerCase().replace(/\s+/g, ' ')
    ].join('|');

    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    summaries.push({
      key,
      ...(seatLabel ? { seat: seatLabel } : {}),
      ...(rowId ? { rowId } : {}),
      ...(eventId ? { eventId } : {}),
      sideText: sideText || rowEntry?.text || rowId || 'proposed pick',
      ...(teamLabel ? { teamLabel } : {}),
      teamAliases,
      ...(reason ? { reason } : {}),
      rawPick
    });
  };

  for (const rep of reports) {
    if (!rep || typeof rep !== 'object') continue;
    const seatLabel = typeof rep.role === 'string' ? rep.role : (typeof rep.seat === 'string' ? rep.seat : undefined);
    if (Array.isArray(rep.picks)) {
      for (const pk of rep.picks) pushLeg(pk, seatLabel);
    }
    if (rep.scorecard && typeof rep.scorecard === 'object') {
      if (Array.isArray(rep.scorecard.picks)) {
        for (const pk of rep.scorecard.picks) pushLeg(pk, seatLabel);
      } else if (rep.scorecard.pick) {
        pushLeg(
          {
            row: rep.scorecard.row,
            event_id: rep.scorecard.event_id,
            pick: rep.scorecard.pick,
            reason: rep.scorecard.summary || rep.scorecard.reason
          },
          seatLabel
        );
      }
    }
    if (Array.isArray(rep.scorecards)) {
      for (const sc of rep.scorecards) {
        if (!sc || typeof sc !== 'object') continue;
        if (Array.isArray(sc.picks)) {
          for (const pk of sc.picks) pushLeg(pk, seatLabel);
        } else if (sc.pick) {
          pushLeg(
            {
              row: sc.row,
              event_id: sc.event_id,
              pick: sc.pick,
              reason: sc.summary || sc.reason
            },
            seatLabel
          );
        }
      }
    }
  }

  return summaries;
}

/**
 * Formats proposed picks into a compact explicit list for Critic audit prompts and re-prompts.
 */
export function formatProposedLegsForPrompt(legs: ProposedPickSummary[], maxChars: number = 900): string {
  if (!legs || legs.length === 0) return '';
  const lines = legs.map((leg, i) => {
    const parts = [
      `${i + 1}.`,
      leg.seat ? `[${leg.seat}]` : '',
      leg.rowId || '',
      leg.eventId ? `(${leg.eventId})` : '',
      leg.sideText,
      leg.reason ? `— ${leg.reason.slice(0, 140)}` : ''
    ].filter(Boolean);
    return parts.join(' ');
  });
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…` : text;
}

/**
 * Builds a corrective re-prompt when the Critic outputs "No picks to evaluate" despite non-empty picks.
 */
export function buildCriticAuditReprompt(
  legs: ProposedPickSummary[],
  mode: 'stage2' | 'lifecycle'
): string {
  const listText = formatProposedLegsForPrompt(legs, 700);
  const schemaReminder = mode === 'stage2'
    ? 'Do not call any tools or emit tool/search arguments. Reply ONLY with valid JSON: {"pass": boolean, "verdict": string, "flags": string[]}.'
    : 'Do not call any tools or emit tool/search arguments. Reply ONLY with valid JSON: {"pass": boolean, "feedback": string}.';

  return `CORRECTION — CRITIC AUDIT REQUIRED:
You answered "No picks to evaluate", which is INVALID because ${legs.length} pick(s) WERE proposed.
"No picks to evaluate" is only valid when the picks array is empty.

Proposed Picks To Audit (${legs.length}):
${listText}

${CRITIC_AUDIT_RULE}

Audit EVERY proposed leg above against the tool evidence and Game Slate rows:
- Reject any leg whose spread sign or number does not match the tool snapshot or slate row.
- Reject any leg citing PPG, a record, or form without a successful tool result.
- Confirm which leg(s) pass and which leg(s) fail, naming each leg explicitly.
${schemaReminder}`;
}

/**
 * Converts a ProposedPickSummary into a VetoedLegTarget (used to strip unaudited legs).
 */
export function proposedLegToUnauditedTarget(leg: ProposedPickSummary, reason: string): VetoedLegTarget {
  return {
    ...(leg.rowId ? { rowId: leg.rowId } : {}),
    ...(leg.eventId ? { eventId: leg.eventId } : {}),
    ...(leg.teamLabel ? { teamLabel: leg.teamLabel } : { teamLabel: leg.sideText }),
    teamAliases: Array.from(
      new Set([
        ...leg.teamAliases,
        leg.sideText.toLowerCase()
      ].filter(Boolean))
    ),
    reason: reason.slice(0, 140)
  };
}

/**
 * Checks whether a Critic response text references a specific proposed leg by rowId, eventId, team alias, or side text.
 */
export function criticTextMentionsLeg(text: string, leg: ProposedPickSummary): boolean {
  if (!text || !text.trim()) return false;
  if (leg.rowId && new RegExp(`\\b${escapeRegex(leg.rowId)}\\b`, 'i').test(text)) {
    return true;
  }
  if (leg.eventId && text.includes(leg.eventId)) {
    return true;
  }
  for (const alias of leg.teamAliases) {
    if (alias.length >= 3 && new RegExp(`(?<![a-zA-Z0-9])${escapeRegex(alias)}(?![a-zA-Z0-9])`, 'i').test(text)) {
      return true;
    }
  }
  const cleanSide = leg.sideText
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[+-]\d+(?:\.\d+)?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleanSide.length >= 4 && new RegExp(`(?<![a-zA-Z0-9])${escapeRegex(cleanSide)}(?![a-zA-Z0-9])`, 'i').test(text)) {
    return true;
  }
  return false;
}

/**
 * Evaluates whether the Critic actually audited the proposed picks.
 *
 * Rules:
 * - If proposedLegs is empty, no picks needed auditing (criticSkippedAudit: false).
 * - If Critic text says "No picks to evaluate" (or parse failed / empty), Critic did NOT audit the picks
 *   -> criticSkippedAudit: true, ALL proposed legs are marked unaudited.
 * - Otherwise, if the Critic gave a substantive audit verdict (evaluating the picks, confirming or vetoing legs),
 *   every proposed leg is considered audited.
 */
export function evaluateCriticAuditCoverage(params: {
  proposedLegs: ProposedPickSummary[];
  criticResponseText: string;
  criticParseFailed?: boolean;
  criticPass?: boolean;
  deterministicVetoedLegs?: VetoedLegTarget[];
}): CriticAuditState {
  const { proposedLegs, criticResponseText, criticParseFailed } = params;
  if (!proposedLegs || proposedLegs.length === 0) {
    return {
      proposedLegCount: 0,
      criticSkippedAudit: false,
      auditedLegKeys: [],
      unauditedLegs: []
    };
  }

  const trimmed = normalizeWhitespace(criticResponseText);
  const claimedNoPicks = isNoPicksToEvaluateText(trimmed);
  const isUnparsed = Boolean(criticParseFailed);

  if (claimedNoPicks || isUnparsed) {
    const reason = claimedNoPicks
      ? 'Critic skipped auditing the proposed picks despite non-empty picks.'
      : 'Critic did not return a valid audit verdict for the proposed picks.';
    return {
      proposedLegCount: proposedLegs.length,
      criticSkippedAudit: true,
      auditedLegKeys: [],
      unauditedLegs: proposedLegs.map(leg => proposedLegToUnauditedTarget(leg, reason)),
      auditNote: reason
    };
  }

  return {
    proposedLegCount: proposedLegs.length,
    criticSkippedAudit: false,
    auditedLegKeys: proposedLegs.map(l => l.key),
    unauditedLegs: []
  };
}

/**
 * Checks whether a pick matches any entry in an audited leg list or unaudited leg list.
 */
function pickMatchesTarget(pk: any, target: VetoedLegTarget): boolean {
  if (!pk) return false;
  const sideText = typeof pk === 'string'
    ? pk
    : [pk.row, pk.id, pk.event_id, pk.eventId, pk.game_id, pk.game, pk.match, pk.side, pk.pick, pk.selection, pk.team, pk.reason]
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .join(' ');
  const lower = sideText.toLowerCase();

  if (target.rowId && new RegExp(`\\b${escapeRegex(target.rowId)}\\b`, 'i').test(sideText)) {
    return true;
  }
  if (target.eventId && sideText.includes(target.eventId)) {
    return true;
  }
  if (target.teamLabel && target.teamLabel.length >= 3 && new RegExp(`(?<![a-zA-Z0-9])${escapeRegex(target.teamLabel.toLowerCase())}(?![a-zA-Z0-9])`, 'i').test(lower)) {
    return true;
  }
  for (const alias of target.teamAliases || []) {
    if (alias.length >= 3 && new RegExp(`(?<![a-zA-Z0-9])${escapeRegex(alias.toLowerCase())}(?![a-zA-Z0-9])`, 'i').test(lower)) {
      return true;
    }
  }
  return false;
}

/**
 * Scrubs any stray "No picks to evaluate" sentence/phrase from final output text when picks were proposed.
 */
export function scrubNoPicksToEvaluateText<T extends Record<string, any>>(target: T): T {
  if (!target || typeof target !== 'object') return target;
  const cleanText = (txt: string): string => {
    if (!isNoPicksToEvaluateText(txt)) return txt;
    const clauses = txt.split(/(?<=[.!?\n;])\s+/).filter(Boolean);
    const kept = clauses.filter(c => !isNoPicksToEvaluateText(c));
    return kept.join(' ').trim();
  };

  for (const k of ['summary', 'analysis', 'reason', 'rationale', 'verdict', 'feedback']) {
    if (typeof (target as any)[k] === 'string' && isNoPicksToEvaluateText((target as any)[k])) {
      (target as any)[k] = cleanText((target as any)[k]);
    }
  }
  if (Array.isArray((target as any).insights)) {
    (target as any).insights = (target as any).insights
      .map((x: any) => (typeof x === 'string' ? cleanText(x) : x))
      .filter((x: any) => typeof x !== 'string' || x.trim().length > 0);
  }
  return target;
}

/**
 * Enforces CRITIC AUDIT on the final synthesized output:
 * - Never keeps a leg the Critic did not audit.
 * - If the Critic did not evaluate proposed picks at all, converts the final result into a clean pass
 *   (picks: [], pass: true, status: 'no_play') rather than shipping an unaudited recommendation.
 * - Scrubs invalid "No picks to evaluate" strings whenever picks were proposed.
 */
export function enforceCriticAuditOnFinalAnalysis<T extends Record<string, any>>(
  finalAnalysis: T,
  options: {
    criticAuditFailed?: boolean;
    unauditedLegs?: VetoedLegTarget[];
    hadProposedPicks?: boolean;
    auditNote?: string;
  }
): T {
  if (!finalAnalysis || typeof finalAnalysis !== 'object') return finalAnalysis;

  const rep = finalAnalysis as Record<string, any>;
  const initialPickCount = Array.isArray(rep.picks) ? rep.picks.length : 0;

  if (options.hadProposedPicks || initialPickCount > 0) {
    scrubNoPicksToEvaluateText(rep);
  }

  // Case 1: Critic completely failed to evaluate proposed picks -> result MUST be a pass, not a recommendation
  if (options.criticAuditFailed) {
    rep.picks = [];
    rep.components = [];
    rep.pass = true;
    rep.criticApproved = false;
    rep.status = 'no_play';
    rep.verified = false;
    rep.ui_title = 'Pass — Unaudited Proposal';
    const passMsg = options.auditNote
      ? `Pass: ${options.auditNote} Proposed picks were not audited by the Critic and cannot be recommended.`
      : 'Pass: Proposed picks were not audited by the Critic and cannot be recommended.';
    rep.reason = passMsg;
    rep.summary = passMsg;
    rep.analysis = passMsg;
    return finalAnalysis;
  }

  // Case 2: Specific legs were left unaudited -> strip those legs, and normalize to pass if none remain
  const unaudited = Array.isArray(options.unauditedLegs) ? options.unauditedLegs : [];
  if (unaudited.length > 0 && Array.isArray(rep.picks) && rep.picks.length > 0) {
    const before = rep.picks.length;
    rep.picks = rep.picks.filter((pk: any) => !unaudited.some(u => pickMatchesTarget(pk, u)));
    if (rep.picks.length === 0 && before > 0) {
      rep.components = [];
      rep.criticApproved = false;
      normalizePassIfAllLegsVetoed(rep, before, true);
      if (!rep.reason || /vetoed/i.test(rep.reason)) {
        const msg = 'Pass: Proposed picks were not audited by the Critic and were removed.';
        rep.reason = msg;
        rep.summary = msg;
        rep.analysis = msg;
      }
    }
  }

  return finalAnalysis;
}

const SCORECARD_VETO_VERDICT_REGEX = /^(?:veto|vetoed|reject|rejected|fail|failed)$/i;
const SCORECARD_APPROVE_VERDICT_REGEX = /^(?:approve|approved|pass|passed|accept|accepted)$/i;

function isRiskCriticScorecard(sc: any): boolean {
  return Boolean(sc && typeof sc === 'object' && /critic|\brisk\b/i.test(String(sc.seat || sc.role || '')));
}

function isContradictoryManagerVetoScorecard(sc: any, picksCount: number): boolean {
  if (!isRiskCriticScorecard(sc)) return false;
  return (
    sc.criticApproved === true &&
    sc.wageringPass === false &&
    picksCount > 0 &&
    SCORECARD_VETO_VERDICT_REGEX.test(String(sc.verdict || '').trim())
  );
}

/**
 * Resolves the authoritative top-level boolean `criticApproved` flag for a final
 * compiled analysis payload, synchronized with Risk Critic's verdict and verification state.
 */
export function resolveFinalCriticApproved(
  finalAnalysis: Record<string, any>,
  options?: {
    criticAuditFailed?: boolean;
    criticVerdictApproved?: boolean;
    verificationSuccess?: boolean;
    verificationApproved?: boolean;
    hadFullVeto?: boolean;
    hadDeterministicVetoes?: boolean;
  }
): boolean {
  if (
    options?.criticAuditFailed === true ||
    finalAnalysis?.verified === false ||
    finalAnalysis?.verification?.success === false ||
    options?.verificationSuccess === false
  ) {
    return false;
  }
  if (options?.hadFullVeto === true) {
    return false;
  }

  const survivingPicks = Array.isArray(finalAnalysis?.picks) ? finalAnalysis.picks.length : 0;

  // S1 (wf-1795711383683): Authoritative Pass 1 Risk Critic approval with zero deterministic vetoes
  // and non-empty compiled picks locks criticApproved = true even if Manager hallucinated
  // { seat: "Risk Critic", verdict: "veto" } or a Market Proposer seat dissented.
  if (
    options?.criticVerdictApproved === true &&
    options?.hadDeterministicVetoes !== true &&
    survivingPicks > 0
  ) {
    return true;
  }

  // Genuine Pass 1 Risk Critic veto sticks unless Pass 2 verification explicitly approved
  // a clean repaired proposal without deterministic vetoes covering any surviving picks.
  if (options?.criticVerdictApproved === false && options?.verificationApproved !== true) {
    return false;
  }
  if (
    options?.verificationApproved === true &&
    options?.hadDeterministicVetoes !== true &&
    survivingPicks > 0
  ) {
    return true;
  }

  if (Array.isArray(finalAnalysis?.scorecards) && finalAnalysis.scorecards.length > 0) {
    const criticCards = finalAnalysis.scorecards.filter(isRiskCriticScorecard);
    const cardsToCheck = criticCards.length > 0
      ? criticCards
      : finalAnalysis.scorecards.filter((sc: any) => sc && typeof sc === 'object' && typeof sc.verdict === 'string');

    if (cardsToCheck.length > 0) {
      const hasEffectiveVeto = cardsToCheck.some((sc: any) => {
        if (isContradictoryManagerVetoScorecard(sc, survivingPicks) && options?.hadDeterministicVetoes !== true) {
          return false;
        }
        return (
          SCORECARD_VETO_VERDICT_REGEX.test(String(sc.verdict || '').trim()) ||
          (isRiskCriticScorecard(sc) && sc.criticApproved === false)
        );
      });
      if (hasEffectiveVeto) return false;

      const hasApprove = cardsToCheck.some(
        (sc: any) =>
          SCORECARD_APPROVE_VERDICT_REGEX.test(String(sc.verdict || '').trim()) ||
          sc.criticApproved === true
      );
      if (hasApprove) {
        if (options?.criticVerdictApproved === false && survivingPicks === 0) {
          return false;
        }
        return true;
      }
    }
  }

  if (typeof options?.criticVerdictApproved === 'boolean') {
    return options.criticVerdictApproved;
  }
  if (
    finalAnalysis?.verified === true ||
    finalAnalysis?.verification?.success === true ||
    options?.verificationSuccess === true
  ) {
    return true;
  }
  if (typeof finalAnalysis?.criticApproved === 'boolean') {
    return finalAnalysis.criticApproved;
  }
  if (
    finalAnalysis?.ui_title === 'Insufficient data' ||
    finalAnalysis?.ui_title === 'Pass — Unaudited Proposal'
  ) {
    return false;
  }
  if (finalAnalysis?.wageringPass === true) {
    return true;
  }
  return true;
}

export interface ReconcileFinalVerdictOptions {
  criticPass1Approved?: boolean;
  criticVerdictApproved?: boolean;
  deterministicVetoes?: Array<unknown>;
  hadDeterministicVetoes?: boolean;
  hadFullVeto?: boolean;
  criticAuditFailed?: boolean;
  verificationSuccess?: boolean;
  verificationApproved?: boolean;
  vetoTexts?: string[];
  vetoedLegs?: VetoedLegTarget[];
  seatScorecards?: any[];
  initialPicks?: any[];
  preserveCleanSubsetPicks?: boolean;
}

/**
 * Enforces the authoritative Risk Critic verdict lock, normalizes contradictory
 * Manager `Risk Critic` scorecard verdicts when Pass 1 approved cleanly, always emits
 * explicit top-level boolean `wageringPass`, and enforces strict mutual exclusion:
 * - `criticApproved === false` => ALWAYS `picks: []` and `wageringPass: true`
 * - `criticApproved === true && picks.length > 0` => ALWAYS `wageringPass: false`
 */
export function reconcileFinalVerdictAndPicks<T extends Record<string, any>>(
  finalAnalysis: T,
  options?: ReconcileFinalVerdictOptions
): T {
  if (!finalAnalysis || typeof finalAnalysis !== 'object') return finalAnalysis;

  const rep = finalAnalysis as Record<string, any>;
  if ('winProbHome' in rep || 'win_prob_home' in rep) {
    return finalAnalysis;
  }

  const pass1Approved =
    typeof options?.criticPass1Approved === 'boolean'
      ? options.criticPass1Approved
      : options?.criticVerdictApproved;
  const deterministicVetoesCount = Array.isArray(options?.deterministicVetoes)
    ? options.deterministicVetoes.length
    : 0;
  const hadDeterministicVetoes = Boolean(
    options?.hadDeterministicVetoes ||
      deterministicVetoesCount > 0 ||
      options?.criticAuditFailed === true ||
      options?.verificationSuccess === false ||
      rep.verified === false ||
      rep.verification?.success === false
  );

  const currentPicksCount = Array.isArray(rep.picks) ? rep.picks.length : 0;
  const authoritativelyApproved =
    pass1Approved === true &&
    !hadDeterministicVetoes &&
    options?.hadFullVeto !== true &&
    currentPicksCount > 0;

  if (authoritativelyApproved) {
    rep.criticApproved = true;
    rep.wageringPass = false;
    if (Array.isArray(rep.scorecards)) {
      rep.scorecards = rep.scorecards.map((sc: any) => {
        if (!isRiskCriticScorecard(sc)) return sc;
        return {
          ...sc,
          seat: sc.seat || 'Risk Critic',
          verdict: 'approve',
          criticApproved: true,
          wageringPass: false
        };
      });
    }
    return finalAnalysis;
  }

  const resolvedApproved = resolveFinalCriticApproved(rep, {
    criticAuditFailed: options?.criticAuditFailed,
    criticVerdictApproved: pass1Approved,
    verificationSuccess: options?.verificationSuccess,
    verificationApproved: options?.verificationApproved,
    hadFullVeto: options?.hadFullVeto,
    hadDeterministicVetoes
  });

  rep.criticApproved = resolvedApproved;

  if (!resolvedApproved) {
    if (options?.preserveCleanSubsetPicks === true && currentPicksCount > 0) {
      rep.criticApproved = false;
      rep.wageringPass = true;
      return finalAnalysis;
    }

    const initialCount = Math.max(
      options?.initialPicks?.length ?? 0,
      currentPicksCount,
      options?.vetoedLegs?.length ?? 0
    );
    const hadAnyCandidateOrPicks =
      initialCount > 0 ||
      Boolean(options?.vetoTexts?.length) ||
      Boolean(options?.vetoedLegs?.length);

    rep.picks = [];
    if (Array.isArray(rep.components)) {
      rep.components = rep.components.filter((c: any) => {
        if (!c || typeof c !== 'object') return false;
        if (c.type === 'DataTable') {
          const title = String(c.props?.title || '');
          if (/\b(?:selected|recommended)\s+(?:wagers?|bets?|picks?|plays?)|parlay\s+legs?\b/i.test(title)) {
            return false;
          }
          return true;
        }
        return c.type === 'InsightList';
      });
    }

    if (hadAnyCandidateOrPicks) {
      const normalizedVetoTexts =
        Array.isArray(options?.vetoTexts) && options.vetoTexts.length > 0
          ? options.vetoTexts
          : (typeof rep.reason === 'string' && rep.reason.trim()
              ? [rep.reason.trim()]
              : ['All proposed selections were vetoed by the Risk Critic.']);
      normalizePassIfAllLegsVetoed(rep, Math.max(initialCount, 1), true, {
        vetoTexts: normalizedVetoTexts,
        vetoedLegs: options?.vetoedLegs,
        seatScorecards: options?.seatScorecards,
        criticApproved: false
      });
    }
    rep.criticApproved = false;
    rep.wageringPass = true;
    rep.pass = true;
    if (!rep.status) rep.status = 'no_play';
    stripContradictoryWagerProseOnPass(finalAnalysis);
    return finalAnalysis;
  }

  // resolvedApproved === true
  const survivingCount = Array.isArray(rep.picks) ? rep.picks.length : 0;
  rep.wageringPass = survivingCount === 0;
  if (survivingCount > 0 && Array.isArray(rep.scorecards)) {
    rep.scorecards = rep.scorecards.map((sc: any) => {
      if (!isContradictoryManagerVetoScorecard(sc, survivingCount)) return sc;
      return {
        ...sc,
        seat: sc.seat || 'Risk Critic',
        verdict: 'approve',
        criticApproved: true,
        wageringPass: false
      };
    });
  }
  if (rep.wageringPass === true && survivingCount === 0) {
    stripContradictoryWagerProseOnPass(finalAnalysis);
  }

  return finalAnalysis;
}

export interface MissingPicksSchemaAuditResult {
  pass: boolean;
  citedRows: string[];
  fromDataTable: string[];
  fromProse: boolean;
  feedback?: string;
}

const SLATE_OVERVIEW_TABLE_TITLE_REGEX = /\b(?:slate\s+overview|full\s+slate|odds\s+board|available\s+board|scoreboard)\b/i;
const ROW_PASS_OR_VETO_STATUS_REGEX = /^(?:veto(?:ed)?|pass(?:ed)?|no[\s_-]*bet|no[\s_-]*play|skip(?:ped)?|reject(?:ed)?)$/i;
const WAGER_RECOMMENDATION_PROSE_REGEX =
  /\b(?:construct\s+(?:a|the)?[^.\n]{0,40}\bparlay|build\s+(?:a|the)?[^.\n]{0,40}\bparlay|place\s+(?:a|the)\s+(?:[^.\n]{0,25})?(?:parlay|bet|wager|play)|proceed\s+with\s+(?:a|the|selected|this)?[^.\n]{0,30}\b(?:parlay|bet|wager|legs?|plays?|picks?)|proceed\s+with\b|selected\s+legs?\b|recommended\s+(?:legs?|picks?|bets?|wagers?|plays?|parlay)\b|lock\s+in\b|risk\s+critic\s+approved\s+(?:all|every|both|the))\b/i;
const EXPLICIT_PASS_PROSE_REGEX =
  /\b(?:bottom-?line\s+call:\s*(?:pass|no[\s_-]*bet|no[\s_-]*play)|no[\s_-]*bet\s+recommendation|pass(?:ing)?\s+on\s+(?:this\s+|all\s+)?slate|do\s+not\s+(?:place|bet|wager)|cannot\s+construct\s+(?:a\s+)?(?:valid\s+)?parlay|no\s+playable\s+(?:legs?|wagers?|bets?)|no\s+qualified\s+wagers?|no\s+bets?\s+recommended)\b/i;
const RECOMMENDATION_TABLE_TITLE_OR_COL_REGEX = /\b(?:recommend|bet|pick|parlay|play|selection|card|leg)\b/i;

function collectRowIdsFromString(text: string, validRowMap: Map<string, RowOptionEntry>): string[] {
  const found: string[] = [];
  if (!text) return found;
  const rx = /\b(R\d+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    const rid = m[1].toUpperCase();
    if ((validRowMap.size === 0 || validRowMap.has(rid)) && !found.includes(rid)) {
      found.push(rid);
    }
  }
  return found;
}

/**
 * Deterministic schema guard (S1.2):
 * Detects missing or empty top-level `picks[]` when `summary`/`analysis` or a `DataTable`
 * recommends placing wagers or cites valid board `R#` rows.
 */
export function auditMissingPicksSchemaViolation(
  proposal: any,
  headers?: GameHeader[],
  slateText?: unknown
): MissingPicksSchemaAuditResult {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    return { pass: true, citedRows: [], fromDataTable: [], fromProse: false };
  }
  if ('winProbHome' in proposal || 'win_prob_home' in proposal) {
    return { pass: true, citedRows: [], fromDataTable: [], fromProse: false };
  }
  if (Array.isArray(proposal.picks) && proposal.picks.length > 0) {
    return { pass: true, citedRows: [], fromDataTable: [], fromProse: false };
  }

  const slateStr = typeof slateText === 'string'
    ? slateText
    : (slateText && typeof slateText === 'object' && typeof (slateText as any).fullBoard === 'string'
        ? (slateText as any).fullBoard
        : '');
  const effHeaders = headers && headers.length > 0 ? headers : (slateStr ? parseGameHeaders(slateStr) : []);
  const rowMap = extractRowOptions(slateStr ? [slateStr] : [], effHeaders);

  const fromDataTable: string[] = [];
  if (Array.isArray(proposal.components)) {
    for (const comp of proposal.components) {
      if (!comp || typeof comp !== 'object' || comp.type !== 'DataTable' || !comp.props) continue;
      const title = String(comp.props.title || '');
      if (SLATE_OVERVIEW_TABLE_TITLE_REGEX.test(title)) continue;
      const rows = Array.isArray(comp.props.rows) ? comp.props.rows : [];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const rowStatus = String(row.status ?? row.verdict ?? row.action ?? row.recommendation ?? '').trim();
        if (rowStatus && ROW_PASS_OR_VETO_STATUS_REGEX.test(rowStatus)) continue;
        const prioritizedValues = [
          row.row,
          row.Row,
          row.id,
          row.ID,
          row.rowId,
          ...Object.values(row)
        ]
          .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
          .join(' ');
        for (const rid of collectRowIdsFromString(prioritizedValues, rowMap)) {
          if (!fromDataTable.includes(rid)) fromDataTable.push(rid);
        }
      }
    }
  }

  const proseParts = [proposal.summary, proposal.analysis]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  const proseText = proseParts.join('\n');
  const fromProse = Boolean(
    proseText &&
    WAGER_RECOMMENDATION_PROSE_REGEX.test(proseText) &&
    !EXPLICIT_PASS_PROSE_REGEX.test(proseText)
  );

  const proseRows = fromProse ? collectRowIdsFromString(proseText, rowMap) : [];
  const citedRows: string[] = [];
  for (const rid of [...fromDataTable, ...proseRows]) {
    if (!citedRows.includes(rid)) citedRows.push(rid);
  }

  if (fromDataTable.length > 0 || fromProse) {
    const rowLabel = citedRows.length > 0 ? `[${citedRows.join(', ')}]` : 'selected legs';
    return {
      pass: false,
      citedRows,
      fromDataTable,
      fromProse,
      feedback: `Schema violation: top-level 'picks' array is missing or empty while summary/analysis/DataTable recommend ${rowLabel}. Populate top-level 'picks' with exact pick objects for those rows and set wageringPass: false.`
    };
  }

  return { pass: true, citedRows: [], fromDataTable: [], fromProse: false };
}

export function isMissingPicksSchemaViolationFeedback(text: unknown): boolean {
  return typeof text === 'string' && /Schema violation:\s*top-level 'picks' array is missing or empty/i.test(text);
}

function getStructuredPickRowId(pk: any): string | undefined {
  if (!pk || typeof pk !== 'object') {
    if (typeof pk === 'string') {
      const m = pk.match(/\b(R\d+)\b/i);
      return m ? m[1].toUpperCase() : undefined;
    }
    return undefined;
  }
  for (const raw of [pk.row, pk.Row, pk.rowId, pk.id]) {
    if (typeof raw === 'string') {
      const m = raw.trim().match(/\b(R\d+)\b/i);
      if (m) return m[1].toUpperCase();
    }
  }
  const sideText = [pk.side, pk.pick, pk.selection, pk.team]
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
  const m = sideText.match(/\b(R\d+)\b/i);
  return m ? m[1].toUpperCase() : undefined;
}

function isCleanSpecialistPickCandidate(pk: any): boolean {
  if (!pk || typeof pk !== 'object' || Array.isArray(pk)) return false;
  if (pk.vetoed === true || /^veto/i.test(String(pk.verdict || pk.status || '').trim())) return false;
  return Boolean(getStructuredPickRowId(pk));
}

function parseNonCriticPicksFromCompiledText(compiledReportsText?: string): any[] {
  if (!compiledReportsText || typeof compiledReportsText !== 'string') return [];
  const extracted: any[] = [];
  // Match seat blocks like `[QuantSpecialist Report]:\n{...}` or raw JSON blocks
  const seatBlockRx = /(?:^|\n)\[([^\]]+?)\]:\s*\n([^\n]*(?:\n(?!\[[^\]]+?\]:)[^\n]*)*)/g;
  let match: RegExpExecArray | null;
  let matchedAnyBlock = false;
  while ((match = seatBlockRx.exec(compiledReportsText)) !== null) {
    matchedAnyBlock = true;
    const seatHeader = match[1] || '';
    if (/risk\s*critic|\bcritic\b/i.test(seatHeader)) continue;
    const body = (match[2] || '').trim();
    if (!body) continue;
    try {
      const parsed = JSON.parse(body);
      const seatRole = String(parsed?.role || parsed?.seat || seatHeader);
      if (/risk\s*critic|\bcritic\b/i.test(seatRole)) continue;
      if (Array.isArray(parsed?.picks)) {
        for (const pk of parsed.picks) {
          if (isCleanSpecialistPickCandidate(pk)) extracted.push(pk);
        }
      }
    } catch {
      // Fallback: extract embedded `"picks":[...]` array if truncated after picks
      const picksMatch = /"picks"\s*:\s*(\[[\s\S]*?\])(?=\s*[,}])/i.exec(body);
      if (picksMatch) {
        try {
          const arr = JSON.parse(picksMatch[1]);
          if (Array.isArray(arr)) {
            for (const pk of arr) {
              if (isCleanSpecialistPickCandidate(pk)) extracted.push(pk);
            }
          }
        } catch {
          // ignore unparseable fragment
        }
      }
    }
  }

  if (!matchedAnyBlock) {
    const picksMatch = /"picks"\s*:\s*(\[[\s\S]*?\])(?=\s*[,}])/i.exec(compiledReportsText);
    if (picksMatch) {
      try {
        const arr = JSON.parse(picksMatch[1]);
        if (Array.isArray(arr)) {
          for (const pk of arr) {
            if (isCleanSpecialistPickCandidate(pk)) extracted.push(pk);
          }
        }
      } catch {
        // ignore
      }
    }
  }
  return extracted;
}

/**
 * Collects unique non-vetoed Pass 1 specialist pick objects from explicit `specialistPicks`
 * and/or serialized `compiledReportsText`.
 */
export function extractSpecialistPicksFromSources(
  explicitPicks?: any[],
  compiledReportsText?: string
): any[] {
  const combined = [
    ...(Array.isArray(explicitPicks) ? explicitPicks : []),
    ...parseNonCriticPicksFromCompiledText(compiledReportsText)
  ];
  const deduped: any[] = [];
  const seenRowIds = new Set<string>();
  for (const pk of combined) {
    if (!isCleanSpecialistPickCandidate(pk)) continue;
    const rowId = getStructuredPickRowId(pk);
    if (!rowId || seenRowIds.has(rowId)) continue;
    seenRowIds.add(rowId);
    deduped.push(pk);
  }
  return deduped;
}

/**
 * Deterministic fallback hydration (S1.3):
 * When Manager still omits/empties `picks[]` on final output despite Critic approval,
 * cites valid non-vetoed board `R#` rows across `DataTable`/`summary`/`analysis`,
 * and matching Pass 1 specialist pick objects exist for those exact rows, hydrates
 * `finalAnalysis.picks` and sets `wageringPass: false`.
 */
export function hydrateMissingPicksFromSpecialists<T extends Record<string, any>>(
  finalAnalysis: T,
  options: {
    specialistPicks?: any[];
    compiledReportsText?: string;
    headers?: GameHeader[];
    slateText?: string;
    vetoedLegs?: VetoedLegTarget[];
    coveredEventIds?: string[];
    criticVerdictApproved?: boolean;
  }
): { hydrated: boolean; hydratedPicks: any[]; citedRows: string[] } {
  if (!finalAnalysis || typeof finalAnalysis !== 'object' || Array.isArray(finalAnalysis)) {
    return { hydrated: false, hydratedPicks: [], citedRows: [] };
  }
  const rep = finalAnalysis as Record<string, any>;
  if ('winProbHome' in rep || 'win_prob_home' in rep) {
    return { hydrated: false, hydratedPicks: [], citedRows: [] };
  }
  if (Array.isArray(rep.picks) && rep.picks.length > 0) {
    return { hydrated: false, hydratedPicks: [], citedRows: [] };
  }
  if (options.criticVerdictApproved === false) {
    return { hydrated: false, hydratedPicks: [], citedRows: [] };
  }
  const criticApprovedRun = options.criticVerdictApproved === true || rep.criticApproved === true;
  if (!criticApprovedRun) {
    return { hydrated: false, hydratedPicks: [], citedRows: [] };
  }

  const headers = options.headers && options.headers.length > 0
    ? options.headers
    : (options.slateText ? parseGameHeaders(options.slateText) : []);
  const schemaCheck = auditMissingPicksSchemaViolation(rep, headers, options.slateText);
  if (schemaCheck.pass || schemaCheck.citedRows.length === 0) {
    return { hydrated: false, hydratedPicks: [], citedRows: [] };
  }

  const vetoedRows = new Set(
    (options.vetoedLegs || [])
      .map(vl => (vl?.rowId ? vl.rowId.toUpperCase() : ''))
      .filter(Boolean)
  );
  const targetRows = schemaCheck.citedRows.filter(rid => !vetoedRows.has(rid));
  if (targetRows.length === 0 || targetRows.length !== schemaCheck.citedRows.length) {
    return { hydrated: false, hydratedPicks: [], citedRows: [] };
  }

  const specialistPool = extractSpecialistPicksFromSources(
    options.specialistPicks,
    options.compiledReportsText
  );
  if (specialistPool.length === 0) {
    return { hydrated: false, hydratedPicks: [], citedRows: [] };
  }

  const poolByRow = new Map<string, any>();
  for (const pk of specialistPool) {
    const rid = getStructuredPickRowId(pk);
    if (rid && !poolByRow.has(rid)) {
      poolByRow.set(rid, pk);
    }
  }

  const matched: any[] = [];
  for (const rid of targetRows) {
    const found = poolByRow.get(rid);
    if (!found) {
      return { hydrated: false, hydratedPicks: [], citedRows: targetRows };
    }
    matched.push({ ...JSON.parse(JSON.stringify(found)), row: rid });
  }

  const coveredPicks = options.coveredEventIds && options.coveredEventIds.length > 0
    ? filterPicksByCoverage(matched, options.coveredEventIds, headers)
    : matched;
  if (coveredPicks.length === 0 || coveredPicks.length !== targetRows.length) {
    return { hydrated: false, hydratedPicks: [], citedRows: targetRows };
  }

  rep.picks = coveredPicks;
  rep.wageringPass = false;
  rep.pass = false;
  rep.criticApproved = true;
  if (rep.status === 'no_play') {
    delete rep.status;
  }

  return { hydrated: true, hydratedPicks: coveredPicks, citedRows: targetRows };
}

/**
 * Ensures `wageringPass: true` with empty `picks: []` never coexists with contradictory
 * "construct/place a parlay" prose or recommendation DataTables.
 */
export function stripContradictoryWagerProseOnPass<T extends Record<string, any>>(finalAnalysis: T): T {
  if (!finalAnalysis || typeof finalAnalysis !== 'object' || Array.isArray(finalAnalysis)) {
    return finalAnalysis;
  }
  const rep = finalAnalysis as Record<string, any>;
  if ('winProbHome' in rep || 'win_prob_home' in rep) {
    return finalAnalysis;
  }
  if (!Array.isArray(rep.picks) || rep.picks.length > 0 || rep.wageringPass !== true) {
    return finalAnalysis;
  }

  if (Array.isArray(rep.components)) {
    rep.components = rep.components.filter((comp: any) => {
      if (!comp || typeof comp !== 'object') return false;
      if (comp.type !== 'DataTable' || !comp.props) return true;
      const title = String(comp.props.title || '');
      if (SLATE_OVERVIEW_TABLE_TITLE_REGEX.test(title)) return true;
      if (RECOMMENDATION_TABLE_TITLE_OR_COL_REGEX.test(title)) return false;
      const cols = Array.isArray(comp.props.columns) ? comp.props.columns : [];
      if (cols.some((c: any) => /^(?:pick|leg|selection|bet|side|parlay)$/i.test(String(c?.key || c?.header || '')))) {
        return false;
      }
      const rows = Array.isArray(comp.props.rows) ? comp.props.rows : [];
      const hasActiveRowRefs = rows.some((row: any) => {
        if (!row || typeof row !== 'object') return false;
        const st = String(row.status ?? row.verdict ?? row.action ?? '').trim();
        if (st && ROW_PASS_OR_VETO_STATUS_REGEX.test(st)) return false;
        return /\bR\d+\b/i.test(Object.values(row).map(v => String(v ?? '')).join(' '));
      });
      return !hasActiveRowRefs;
    });
  }

  const hasContradictoryText = (txt: unknown): boolean =>
    typeof txt === 'string' &&
    WAGER_RECOMMENDATION_PROSE_REGEX.test(txt) &&
    !EXPLICIT_PASS_PROSE_REGEX.test(txt);

  if (hasContradictoryText(rep.summary) || hasContradictoryText(rep.analysis)) {
    const rawReason = typeof rep.reason === 'string' && rep.reason.trim() && !hasContradictoryText(rep.reason)
      ? rep.reason.trim()
      : '';
    const passMsg = rawReason
      ? (/^pass\b/i.test(rawReason) ? rawReason : `Pass: ${rawReason}`)
      : 'Pass: No qualified wagers approved on this slate; no bets recommended.';
    rep.summary = passMsg;
    rep.analysis = passMsg;
    rep.reason = passMsg;
    if (!rep.ui_title || /\bparlay\b|\bpicks?\b|\blegs?\b/i.test(String(rep.ui_title))) {
      rep.ui_title = 'Pass';
    }
    rep.pass = true;
    if (!rep.status) rep.status = 'no_play';
  }

  return finalAnalysis;
}

const DETERMINISTIC_VETO_FLAG_REGEX =
  /^(?:injury_misattribution|row_side_mismatch|spread_side_mismatch|spread_value_mismatch|missing_market_coverage|ungrounded_claim|contra_steam_misread|sharp_contra_steam|symmetric_injury_misread|model_signal_misread|duplicate_leg|critic_did_not_audit|pull_before_pass)$/i;

const NO_FATAL_CONTRADICTION_REGEX = /\bno\s+fatal\b/i;

export interface UncitedBlanketVetoResult {
  isUncitedBlanketVeto: boolean;
  reason?: 'contradictory_no_fatal_with_zero_vetoed_legs' | 'uncited_blanket_veto_zero_legs';
}

/**
 * Detects invalid Risk Critic blanket vetoes when zero deterministic verifiers failed:
 * 1) Critic emits `"No fatal ..."` while returning `pass: false` / `verdict: "veto"` and `vetoedLegs.length === 0`.
 * 2) Critic returns `verdict: "veto"` / `pass: false` / `criticApproved: false` with `vetoedLegs.length === 0`,
 *    `vetoedClaims.length === 0`, zero cited `R#` row IDs, and zero deterministic veto flags.
 */
export function detectUncitedBlanketCriticVeto(options: {
  report: Record<string, any>;
  vetoedLegs?: VetoedLegTarget[];
  vetoedClaims?: string[];
  hasDeterministicFailures?: boolean;
  criticSkippedAudit?: boolean;
}): UncitedBlanketVetoResult {
  const { report, vetoedLegs, vetoedClaims, hasDeterministicFailures, criticSkippedAudit } = options;
  if (!report || typeof report !== 'object') {
    return { isUncitedBlanketVeto: false };
  }
  if (hasDeterministicFailures || criticSkippedAudit) {
    return { isUncitedBlanketVeto: false };
  }

  const verdictStr = typeof report.verdict === 'string' ? report.verdict.trim() : '';
  const explicitVetoVerdict = /^(?:veto|vetoed|reject|rejected|fail|failed)$/i.test(verdictStr);
  const scorecardVetoNotes: string[] = [];
  let hasCitedScorecardVeto = false;
  if (Array.isArray(report.scorecards)) {
    for (const sc of report.scorecards) {
      if (!sc || typeof sc !== 'object') continue;
      const scVerdict = String(sc.verdict || '').trim();
      const scNotes = String(sc.notes || sc.note || sc.reason || '').trim();
      if (scNotes) scorecardVetoNotes.push(scNotes);
      if (SCORECARD_VETO_VERDICT_REGEX.test(scVerdict) || sc.criticApproved === false) {
        if (/\bR\d+\b/i.test(scNotes)) {
          hasCitedScorecardVeto = true;
        }
      }
    }
  }

  const indicatesVeto =
    report.pass === false ||
    report.criticApproved === false ||
    explicitVetoVerdict ||
    (Array.isArray(report.scorecards) &&
      report.scorecards.some(
        (sc: any) =>
          sc &&
          typeof sc === 'object' &&
          (SCORECARD_VETO_VERDICT_REGEX.test(String(sc.verdict || '').trim()) || sc.criticApproved === false)
      ));

  if (!indicatesVeto) {
    return { isUncitedBlanketVeto: false };
  }

  const explicitReportVetoedLegs = Array.isArray(report.vetoedLegs)
    ? report.vetoedLegs.filter((x: any) => Boolean(x && (typeof x !== 'string' || x.trim())))
    : [];
  const totalVetoedLegs = (Array.isArray(vetoedLegs) ? vetoedLegs.length : 0) + explicitReportVetoedLegs.length;
  const totalVetoedClaims = Array.isArray(vetoedClaims) ? vetoedClaims.length : 0;

  if (totalVetoedLegs > 0 || totalVetoedClaims > 0 || hasCitedScorecardVeto) {
    return { isUncitedBlanketVeto: false };
  }

  const combinedText = [
    verdictStr,
    typeof report.feedback === 'string' ? report.feedback.trim() : '',
    typeof report.summary === 'string' ? report.summary.trim() : '',
    typeof report.analysis === 'string' ? report.analysis.trim() : '',
    typeof report.reason === 'string' ? report.reason.trim() : '',
    ...scorecardVetoNotes
  ]
    .filter(Boolean)
    .join(' ');

  if (NO_FATAL_CONTRADICTION_REGEX.test(combinedText)) {
    return {
      isUncitedBlanketVeto: true,
      reason: 'contradictory_no_fatal_with_zero_vetoed_legs'
    };
  }

  const flags = Array.isArray(report.flags) ? report.flags.map((f: any) => String(f || '').trim()).filter(Boolean) : [];
  const hasDeterministicFlag = flags.some(f => DETERMINISTIC_VETO_FLAG_REGEX.test(f));
  if (hasDeterministicFlag) {
    return { isUncitedBlanketVeto: false };
  }

  const hasCitedRowId = /\bR\d+\b/i.test(combinedText);
  if (!hasCitedRowId) {
    return {
      isUncitedBlanketVeto: true,
      reason: 'uncited_blanket_veto_zero_legs'
    };
  }

  return { isUncitedBlanketVeto: false };
}

