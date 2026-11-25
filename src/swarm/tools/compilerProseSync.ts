import { parseGameHeaders, type GameHeader } from '../context/gameHeaders.ts';
import { matchTeamByLabel } from './injuryAttribution.ts';
import { extractRowOptions, type RowOptionEntry } from './marketRowBinding.ts';
import { splitSentencesSafe } from '../parser/responseGuards.ts';
import {
  normalizePassIfAllLegsVetoed,
  stripVetoedLegsFromParlayText,
  type VetoedLegTarget,
} from './claimGrounding.ts';

function extractPickRowId(pk: any): string | undefined {
  if (!pk) return undefined;
  if (typeof pk === 'string') {
    const m = pk.match(/\b(R\d+)\b/i);
    return m ? m[1].toUpperCase() : undefined;
  }
  if (typeof pk !== 'object') return undefined;
  for (const cand of [pk.row, pk.id]) {
    if (typeof cand === 'string') {
      const m = cand.trim().match(/\b(R\d+)\b/i);
      if (m) return m[1].toUpperCase();
    }
  }
  const sideText = [pk.side, pk.pick, pk.selection, pk.team]
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
  const m = sideText.match(/\b(R\d+)\b/i);
  return m ? m[1].toUpperCase() : undefined;
}

function extractPickSideText(pk: any): string {
  if (!pk) return '';
  if (typeof pk === 'string') return pk.trim();
  if (typeof pk !== 'object') return '';
  return String(pk.side || pk.pick || pk.selection || pk.team || '').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildAliasesForText(raw: string): string[] {
  const aliases = new Set<string>();
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const clean = trimmed
    .replace(/\b(?:R\d+|SPR|ML|TOT|moneyline|over|under|home|away)\b/gi, ' ')
    .replace(/[+-]\d+(?:\.\d+)?/g, ' ')
    .replace(/[()[\]:|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length >= 4) {
    aliases.add(clean.toLowerCase());
    const words = clean.split(/\s+/).filter((w) => w.length >= 4);
    const mascot = words[words.length - 1];
    if (mascot && mascot.length >= 4) {
      aliases.add(mascot.toLowerCase());
    }
  }
  const teamEntry = matchTeamByLabel(trimmed);
  if (teamEntry) {
    aliases.add(teamEntry.name.toLowerCase());
    if (teamEntry.abbr && teamEntry.abbr.length >= 2) {
      aliases.add(teamEntry.abbr.toLowerCase());
    }
    const teamWords = teamEntry.name.toLowerCase().split(/\s+/).filter((w) => w.length >= 4);
    const mascot = teamWords[teamWords.length - 1];
    if (mascot) aliases.add(mascot);
  }
  return Array.from(aliases);
}

function collectRowIdsInText(text: string): string[] {
  const out: string[] = [];
  const rx = /\b(R\d+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    const rid = m[1].toUpperCase();
    if (!out.includes(rid)) out.push(rid);
  }
  return out;
}

function targetMatchesSpanSafe(span: string, target: VetoedLegTarget): boolean {
  if (!span || !span.trim()) return false;
  if (target.rowId && new RegExp(`\\b${escapeRegExp(target.rowId)}\\b`, 'i').test(span)) {
    return true;
  }
  const lower = span.toLowerCase();
  for (const alias of target.teamAliases) {
    if (!alias || alias.length < 2) continue;
    const rx = alias.length <= 4
      ? new RegExp(`\\b${escapeRegExp(alias.toUpperCase())}\\b`)
      : new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'i');
    if (alias.length <= 4 ? rx.test(span) : rx.test(lower)) {
      return true;
    }
  }
  return false;
}

function reconcileLegCountText(text: string, pickCount: number): string {
  if (!text || pickCount <= 0) return text;
  let out = text;
  if (pickCount === 1) {
    out = out
      .replace(/\b(?:\d+|two|three|four|five|six)\s*-\s*leg(?:\s+same[\s-]*game)?\s+parlay\b/gi, 'single-leg play')
      .replace(/\b(?:\d+|two|three|four|five|six)\s+leg(?:\s+same[\s-]*game)?\s+parlay\b/gi, 'single-leg play')
      .replace(/\b(?:\d+|two|three|four|five|six)\s+legs\b/gi, '1 leg');
  } else {
    out = out
      .replace(/\b(?:\d+|two|three|four|five|six)\s*-\s*leg(?=\s+(?:same[\s-]*game\s+)?parlay\b)/gi, `${pickCount}-leg`)
      .replace(/\b(?:\d+|two|three|four|five|six)\s+leg(?=\s+(?:same[\s-]*game\s+)?parlay\b)/gi, `${pickCount}-leg`)
      .replace(/\b(?:\d+|two|three|four|five|six)\s+legs\b/gi, `${pickCount} legs`);
  }
  return out;
}

function formatPickSummaryClause(pk: any, rowMap: Map<string, RowOptionEntry>): string {
  const rowId = extractPickRowId(pk);
  const sideText = extractPickSideText(pk);
  const rowText = rowId ? rowMap.get(rowId)?.text : undefined;
  const label = sideText || rowText || rowId || 'Pick';
  return rowId && !new RegExp(`\\b${escapeRegExp(rowId)}\\b`, 'i').test(label)
    ? `${label} (${rowId})`
    : label;
}

function formatPickInsightBullet(pk: any, rowMap: Map<string, RowOptionEntry>): string {
  const rowId = extractPickRowId(pk);
  const sideText = extractPickSideText(pk) || (rowId ? rowMap.get(rowId)?.text : '') || 'Selected leg';
  const reasonText = typeof pk?.reason === 'string' && pk.reason.trim()
    ? pk.reason.trim()
    : '';
  const prefix = rowId && !new RegExp(`\\b${escapeRegExp(rowId)}\\b`, 'i').test(sideText)
    ? `[${rowId}] ${sideText}`
    : sideText;
  return reasonText ? `${prefix} — ${reasonText}` : prefix;
}

function extractInsightText(ins: any): string {
  if (typeof ins === 'string') return ins;
  if (ins && typeof ins === 'object' && typeof ins.message === 'string') return ins.message;
  return '';
}

function normalizeCleanSentence(raw: string): string {
  let out = raw.replace(/\s+/g, ' ').trim();
  if (!out) return '';
  if (/^[a-z]/.test(out)) {
    out = out[0].toUpperCase() + out.slice(1);
  }
  if (!/[.!?]$/.test(out)) {
    out = `${out}.`;
  }
  return out;
}

function stripOrphanReferencesFromProse(
  text: string,
  orphanTargets: VetoedLegTarget[],
  _activeRowIds: Set<string>,
  activePickCount: number,
): { text: string; changed: boolean } {
  if (!text || !text.trim()) return { text, changed: false };
  let working = text;
  if (orphanTargets.length > 0 && activePickCount > 0) {
    working = stripVetoedLegsFromParlayText(working, orphanTargets);
  }
  working = reconcileLegCountText(working, activePickCount);

  if (orphanTargets.length === 0) {
    return { text: working, changed: working !== text };
  }

  const containsOrphan = (s: string) => orphanTargets.some((t) => targetMatchesSpanSafe(s, t));

  // S1: Whole-sentence removal only using the abbreviation-safe splitter — never slice mid-sentence at a comma or clause.
  const sentences = splitSentencesSafe(working);
  const kept: string[] = [];

  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
    if (!sentence) continue;
    if (containsOrphan(sentence)) {
      continue;
    }
    kept.push(normalizeCleanSentence(sentence));
  }

  const out = kept
    .join(' ')
    .replace(/\s*\+\s*(?=[.,;]|$)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { text: out, changed: out !== text };
}

/**
 * Deterministically synchronizes Compiler prose fields (`summary`, `analysis`),
 * `components` (`InsightList`, `DataTable`), and top-level `insights` with the
 * surviving `picks[]` array after any pre/post-verification leg pruning.
 */
export function syncCompilerProseWithFinalPicks<T extends Record<string, any>>(
  report: T,
  options?: {
    initialPicks?: any[];
    headers?: GameHeader[];
    rowMap?: Map<string, RowOptionEntry>;
    slateText?: string;
    vetoedLegs?: VetoedLegTarget[];
    vetoTexts?: string[];
    criticApproved?: boolean;
    seatScorecards?: any[];
  },
): {
  report: T;
  synced: boolean;
  droppedRowIds: string[];
  droppedTeams: string[];
} {
  if (!report || typeof report !== 'object' || !Array.isArray(report.picks)) {
    return { report, synced: false, droppedRowIds: [], droppedTeams: [] };
  }

  const headers = options?.headers && options.headers.length > 0
    ? options.headers
    : (options?.slateText ? parseGameHeaders(options.slateText) : []);
  const rowMap = options?.rowMap ?? extractRowOptions(options?.slateText ? [options.slateText] : [], headers);

  const rep = report as Record<string, any>;
  const activePicks = rep.picks;
  const activeRowIds = new Set<string>();
  const activeSidesNorm = new Set<string>();
  const activeAliases = new Set<string>();

  for (const pk of activePicks) {
    const rid = extractPickRowId(pk);
    if (rid) activeRowIds.add(rid);
    const side = extractPickSideText(pk);
    if (side) activeSidesNorm.add(side.toLowerCase());
    const rowEntry = rid ? rowMap.get(rid) : undefined;
    for (const a of [
      ...buildAliasesForText(side),
      ...(rowEntry?.text ? buildAliasesForText(rowEntry.text) : []),
    ]) {
      activeAliases.add(a);
    }
  }

  const orphanTargetsMap = new Map<string, VetoedLegTarget>();
  const registerOrphan = (rowId?: string, labelHint?: string, extraAliases?: string[]) => {
    const normRow = rowId ? rowId.toUpperCase() : undefined;
    if (normRow && activeRowIds.has(normRow)) return;
    const rowText = normRow ? rowMap.get(normRow)?.text : undefined;
    const combinedLabel = [labelHint, rowText].filter(Boolean).join(' ').trim();
    const rawAliases = [
      ...buildAliasesForText(combinedLabel),
      ...(Array.isArray(extraAliases) ? extraAliases.map((a) => a.toLowerCase().trim()).filter(Boolean) : [])
    ];
    const filteredAliases = Array.from(new Set(rawAliases.filter((a) => !activeAliases.has(a))));
    const key = normRow || filteredAliases[0] || combinedLabel.toLowerCase();
    if (!key) return;
    const prev = orphanTargetsMap.get(key);
    if (prev) {
      prev.teamAliases = Array.from(new Set([...prev.teamAliases, ...filteredAliases]));
      if (!prev.teamLabel && (labelHint || rowText)) {
        prev.teamLabel = (labelHint || rowText)!.slice(0, 80);
      }
      return;
    }
    orphanTargetsMap.set(key, {
      ...(normRow ? { rowId: normRow } : {}),
      ...(labelHint || rowText ? { teamLabel: (labelHint || rowText)!.slice(0, 80) } : {}),
      teamAliases: filteredAliases,
      reason: 'Pruned from final picks[]',
    });
  };

  for (const initPk of options?.initialPicks || []) {
    const rid = extractPickRowId(initPk);
    const side = extractPickSideText(initPk);
    const matchesActive =
      (rid && activeRowIds.has(rid)) ||
      (!rid && side && activeSidesNorm.has(side.toLowerCase()));
    if (!matchesActive && (rid || side)) {
      registerOrphan(rid, side);
    }
  }

  for (const vLeg of options?.vetoedLegs || []) {
    if (!vLeg) continue;
    const rid = vLeg.rowId ? vLeg.rowId.toUpperCase() : undefined;
    const aliases = Array.isArray(vLeg.teamAliases) ? vLeg.teamAliases : [];
    const matchesActive =
      (rid && activeRowIds.has(rid)) ||
      (aliases.length > 0 && aliases.some((a) => activeAliases.has(a.toLowerCase().trim())));
    if (!matchesActive) {
      registerOrphan(rid, vLeg.teamLabel, aliases);
    }
  }

  // Also detect any orphan R# citations still lingering in prose/insights when picks[] is non-empty
  if (activePicks.length > 0 && activeRowIds.size > 0) {
    const textSources: string[] = [
      typeof rep.summary === 'string' ? rep.summary : '',
      typeof rep.analysis === 'string' ? rep.analysis : '',
      ...(Array.isArray(rep.insights) ? rep.insights.map((i: any) => extractInsightText(i)) : []),
    ];
    if (Array.isArray(rep.components)) {
      for (const comp of rep.components) {
        if (comp?.type === 'InsightList' && Array.isArray(comp?.props?.insights)) {
          for (const ins of comp.props.insights) {
            textSources.push(extractInsightText(ins));
          }
        }
      }
    }
    for (const src of textSources) {
      for (const rid of collectRowIdsInText(src)) {
        if (!activeRowIds.has(rid)) {
          registerOrphan(rid);
        }
      }
    }
  }

  const orphanTargets = Array.from(orphanTargetsMap.values());
  const droppedRowIds = orphanTargets.map((t) => t.rowId).filter((r): r is string => Boolean(r));
  const droppedTeams = orphanTargets.map((t) => t.teamLabel).filter((l): l is string => Boolean(l));

  let synced = false;

  const syncInsightArray = (arr: any[], asObjects: boolean): any[] => {
    const itemHasOrphan = (txt: string) => {
      if (orphanTargets.some((t) => targetMatchesSpanSafe(txt, t))) return true;
      if (activeRowIds.size > 0) {
        const citedRows = collectRowIdsInText(txt);
        if (citedRows.length > 0 && citedRows.every((r) => !activeRowIds.has(r))) {
          return true;
        }
      }
      return false;
    };

    const filtered: any[] = [];
    const coveredActiveRows = new Set<string>();
    for (const item of arr) {
      const txt = extractInsightText(item);
      if (!txt.trim()) {
        synced = true;
        continue;
      }
      if (itemHasOrphan(txt)) {
        // Only try salvaging if item also explicitly names an active row on a separate clause
        const activeRowsHere = collectRowIdsInText(txt).filter((r) => activeRowIds.has(r));
        if (activeRowsHere.length > 0 && !activeRowsHere.some((r) => coveredActiveRows.has(r))) {
          const salvaged = stripOrphanReferencesFromProse(txt, orphanTargets, activeRowIds, activePicks.length);
          if (salvaged.text && !itemHasOrphan(salvaged.text)) {
            activeRowsHere.forEach((r) => coveredActiveRows.add(r));
            synced = true;
            filtered.push(asObjects && typeof item === 'object' ? { ...item, message: salvaged.text } : salvaged.text);
            continue;
          }
        }
        synced = true;
        continue;
      }
      const rowsInItem = collectRowIdsInText(txt).filter((r) => activeRowIds.has(r));
      if (rowsInItem.length > 0) {
        if (rowsInItem.every((r) => coveredActiveRows.has(r))) {
          synced = true;
          continue;
        }
        rowsInItem.forEach((r) => coveredActiveRows.add(r));
      } else if (orphanTargets.length > 0 && activePicks.length > 0) {
        // Drop orphan un-keyed filler bullet when pruning happened so InsightList stays 1:1 with picks[]
        synced = true;
        continue;
      }
      const normalizedTxt = normalizeCleanSentence(txt);
      const normalizedItem = asObjects && typeof item === 'object'
        ? { ...item, message: normalizedTxt }
        : normalizedTxt;
      if (normalizedTxt !== txt) synced = true;
      filtered.push(normalizedItem);
    }

    if (activePicks.length > 0 && (orphanTargets.length > 0 || filtered.length !== arr.length)) {
      for (const pk of activePicks) {
        const rid = extractPickRowId(pk);
        const side = extractPickSideText(pk);
        const alreadyPresent = rid
          ? coveredActiveRows.has(rid) || filtered.some((x) => new RegExp(`\\b${escapeRegExp(rid)}\\b`, 'i').test(extractInsightText(x)))
          : (side && filtered.some((x) => extractInsightText(x).toLowerCase().includes(side.toLowerCase())));
        if (!alreadyPresent) {
          const bullet = formatPickInsightBullet(pk, rowMap);
          filtered.push(asObjects ? { message: bullet, type: 'neutral' } : bullet);
          if (rid) coveredActiveRows.add(rid);
          synced = true;
        }
      }
    }

    return filtered;
  };

  if (Array.isArray(rep.insights)) {
    const nextInsights = syncInsightArray(rep.insights, false);
    if (nextInsights.length !== rep.insights.length || synced) {
      rep.insights = nextInsights;
    }
  }

  if (Array.isArray(rep.components)) {
    for (const comp of rep.components) {
      if (!comp || typeof comp !== 'object' || !comp.props) continue;
      if (comp.type === 'InsightList' && Array.isArray(comp.props.insights)) {
        const hasObjects = comp.props.insights.some((i: any) => i && typeof i === 'object');
        const nextCompInsights = syncInsightArray(comp.props.insights, hasObjects);
        if (nextCompInsights.length !== comp.props.insights.length || synced) {
          comp.props.insights = nextCompInsights;
        }
      } else if (comp.type === 'DataTable' && Array.isArray(comp.props.rows) && orphanTargets.length > 0) {
        const title = String(comp.props.title || '');
        if (!/\b(?:slate\s+overview|odds\s+board)\b/i.test(title)) {
          const beforeLen = comp.props.rows.length;
          comp.props.rows = comp.props.rows.filter(
            (row: any) => !orphanTargets.some((t) => targetMatchesSpanSafe(JSON.stringify(row), t)),
          );
          if (comp.props.rows.length !== beforeLen) synced = true;
        }
      }
    }
  }

  // Sync summary & analysis prose
  const rebuildSummary = () => {
    const prefix = activePicks.length >= 2 ? `${activePicks.length}-leg parlay` : 'Single-leg play';
    const items = activePicks.map((pk: any) => formatPickSummaryClause(pk, rowMap)).join(' + ');
    return `${prefix}: ${items}.`;
  };
  const rebuildAnalysis = () => {
    const prefix = activePicks.length >= 2 ? `${activePicks.length}-leg parlay` : 'Single-leg play';
    const details = activePicks.map((pk: any) => formatPickInsightBullet(pk, rowMap)).join('; ');
    return `${prefix} featuring ${details}.`;
  };

  const GENERIC_PROSE_STOP_WORDS = new Set([
    'over', 'under', 'home', 'away', 'moneyline', 'spread', 'total', 'game', 'team',
  ]);
  const isPickRepresentedInProse = (pk: any, text: string): boolean => {
    const rid = extractPickRowId(pk);
    if (rid && new RegExp(`\\b${escapeRegExp(rid)}\\b`, 'i').test(text)) return true;
    const side = extractPickSideText(pk);
    if (!side) return false;
    const rowText = rid ? rowMap.get(rid)?.text : undefined;
    const aliases = new Set<string>([
      ...buildAliasesForText(side),
      ...(rowText ? buildAliasesForText(rowText) : []),
    ]);
    for (const src of [side, rowText].filter((s): s is string => Boolean(s))) {
      const teamEntry = matchTeamByLabel(src);
      if (teamEntry?.city && teamEntry.city.length >= 3) {
        aliases.add(teamEntry.city.toLowerCase());
      }
      if (teamEntry?.name) aliases.add(teamEntry.name.toLowerCase());
      if (teamEntry?.abbr) aliases.add(teamEntry.abbr.toLowerCase());
      const cleaned = src
        .replace(/\b(?:R\d+|SPR|ML|TOT|moneyline|over|under|home|away)\b/gi, ' ')
        .replace(/[+-]\d+(?:\.\d+)?/g, ' ');
      for (const word of cleaned.split(/[^A-Za-z0-9']+/).map((w) => w.toLowerCase())) {
        if (word.length >= 4 && !GENERIC_PROSE_STOP_WORDS.has(word)) {
          aliases.add(word);
        }
      }
    }
    const lower = text.toLowerCase();
    return Array.from(aliases).some((a) =>
      a.length <= 4
        ? new RegExp(`\\b${escapeRegExp(a.toUpperCase())}\\b`).test(text) || new RegExp(`\\b${escapeRegExp(a)}\\b`, 'i').test(lower)
        : new RegExp(`\\b${escapeRegExp(a)}\\b`, 'i').test(lower),
    );
  };

  const isFullVetoPass =
    activePicks.length === 0 &&
    (options?.criticApproved === false ||
      rep.criticApproved === false ||
      (orphanTargets.length > 0 &&
        ((options?.initialPicks?.length ?? 0) > 0 || (options?.vetoedLegs?.length ?? 0) > 0)));

  if (isFullVetoPass) {
    normalizePassIfAllLegsVetoed(
      rep,
      Math.max(options?.initialPicks?.length ?? 0, orphanTargets.length),
      true,
      {
        vetoTexts: options?.vetoTexts,
        vetoedLegs: (options?.vetoedLegs && options.vetoedLegs.length > 0) ? options.vetoedLegs : orphanTargets,
        seatScorecards: options?.seatScorecards,
        criticApproved: false,
      },
    );
    synced = true;
  } else {
    for (const field of ['summary', 'analysis'] as const) {
      if (typeof rep[field] !== 'string' || !rep[field].trim()) continue;
      const orig = rep[field];
      const stripped = stripOrphanReferencesFromProse(orig, orphanTargets, activeRowIds, activePicks.length);
      let nextVal = stripped.text;
      const stillHasOrphan = orphanTargets.some((t) => targetMatchesSpanSafe(nextVal, t));
      if (
        activePicks.length > 0 &&
        (!nextVal ||
          stillHasOrphan ||
          (orphanTargets.length > 0 && activePicks.some((pk: any) => !isPickRepresentedInProse(pk, nextVal))))
      ) {
        nextVal = field === 'summary' ? rebuildSummary() : rebuildAnalysis();
      }
      if (Array.isArray(rep.picks) && /\bpicks\s*=\s*\d+\b/i.test(nextVal)) {
        nextVal = nextVal.replace(/\bpicks\s*=\s*\d+\b/gi, `picks=${activePicks.length}`);
      }
      if (nextVal !== orig) {
        rep[field] = nextVal;
        synced = true;
      }
    }
  }

  return {
    report,
    synced,
    droppedRowIds,
    droppedTeams,
  };
}
