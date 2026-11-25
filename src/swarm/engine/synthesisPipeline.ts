import type { Agent } from '../agent.ts';
import type { SwarmContext } from '../context.ts';
import type { SwarmWorkflowParams } from './types.ts';
import type { SwarmEngineSettings } from '../types.ts';
import type { AgentVariantConfig } from '../experiment.ts';
import type { ClusterDigest } from '../communication.ts';
import { globalPromptCompressor } from '../compression.ts';
import { guardManagerResponse, sanitizeCompilerProposalOddsAndSummary } from '../parser.ts';
import { ManagerResponseSchema } from '../schemas.ts';
import { MANAGER_SYSTEM_INSTRUCTION, NO_ROUNDED_PPG_RULE } from './constants.ts';
import {
    detectOpposingSeatConflicts,
    findingMentionsSeatConflict,
    renderPromptConsensusBlock,
    renderSeatConflictPromptBlock,
    type AnalystConsensusDigest
} from './consensusPipeline.ts';
import { compileDebateDigest } from './coordinationPipeline.ts';
import { TokenEstimator } from '../compression/tokenEstimator.ts';
import { seatBudget } from '../context/promptBudget.ts';
import { parseGameHeaders, renderHeaders, filterPicksByCoverage } from '../context/gameHeaders.ts';
import { formatRunDebugOutputDigest, recordRunDebugAgreement, recordRunDebugSeat, recordRunDebugDrop, recordRunDebugEdit } from './runDebugRecord.ts';
import { partitionTaskAndContract, formatUserTaskSection } from './analystExecution.ts';
import { sanitizeMisattributedPicksAndText } from '../tools/injuryAttribution.ts';
import { sanitizeRowMismatchedPicks, type MarketToolRecord } from '../tools/marketRowBinding.ts';
import {
    mergeVetoedClaims,
    mergeVetoedLegTargets,
    normalizePassIfAllLegsVetoed,
    sanitizeUngroundedClaims,
    type VetoedLegTarget
} from '../tools/claimGrounding.ts';
import {
    buildToolCoverageSummaryLine,
    sanitizePullBeforePassClaims,
    type ToolCallTraceEntry
} from '../tools/pullBeforePass.ts';
import { enforceCriticAuditOnFinalAnalysis, resolveFinalCriticApproved } from '../tools/criticAudit.ts';
import { syncCompilerProseWithFinalPicks } from '../tools/compilerProseSync.ts';

export const MANAGER_MAX_PROMPT_CHARS = 9000;

export interface SynthesisPipelineParams {
    task: string;
    rawInput: string;
    analysts: Agent[];
    managerAgent: Agent;
    allAnalystReports: any[][];
    clusterDigests: Record<string, ClusterDigest>;
    historicalContext: string;
    workflowConsensus?: AnalystConsensusDigest;
    settings?: SwarmEngineSettings;
    activeVariant?: AgentVariantConfig;
    context: SwarmContext;
    params: SwarmWorkflowParams;
    bypassCache: boolean;
    verifierEvidence?: string;
    toolCallTrace?: ToolCallTraceEntry[];
    vetoedLegs?: VetoedLegTarget[];
}

export interface SynthesisPipelineResult {
    effectiveDynamicPrompt: string;
    effectiveCompiledReports: string;
    effectiveHistoricalContext: string;
    appComputedCounts?: string;
    workflowOriginalPromptTokens: number;
    workflowCompressedPromptTokens: number;
    workflowPromptTokensSaved: number;
    workflowDeduplicatedCount: number;
}

export function getManagerContextTokenCeiling(provider?: string): number {
    const p = provider?.toLowerCase() || '';
    if (p === 'groq') return 6000;
    if (p === 'mistral') return 8000;
    if (p === 'openrouter') return 16000;
    if (p === 'gemini') return 32000;
    if (p === 'nvidia') return 16000;
    if (p === 'cloudflare') return 12000;
    return 8000;
}

export function compileSynthesisPrompt(p: SynthesisPipelineParams): SynthesisPipelineResult {
    const {
        task,
        analysts,
        managerAgent,
        allAnalystReports,
        clusterDigests,
        historicalContext,
        workflowConsensus,
        settings,
        activeVariant,
        context,
        params
    } = p;

    let workflowOriginalPromptTokens = 0;
    let workflowCompressedPromptTokens = 0;
    let workflowPromptTokensSaved = 0;
    let workflowDeduplicatedCount = 0;

    const isMorningJudge = (settings as any)?.responseSchema === 'morning_judge';
    const isBettingRun = isMorningJudge
        || (params as any)?.originApp === 'duelodds'
        || (params as any)?.callerAppId === 'duelodds'
        || (params as any)?.appId === 'duelodds'
        || (params as any)?.isBettingRun === true;

    const totalChunkReports = allAnalystReports.reduce((sum, r) => sum + (r ? r.length : 0), 0);
    const isHierarchicalTreeReduction = !isBettingRun && (totalChunkReports > 6 || Object.keys(clusterDigests).length > 4);

    let compiledReports = '';
    let clusterDigestText = '';

    if (isHierarchicalTreeReduction) {
        // Module 6: Hierarchical Map-Reduce Synthesis
        // The root manager synthesizes only the resulting ClusterDigests.
        compiledReports = `[Hierarchical Map-Reduce]: Synthesized ${totalChunkReports} specialist chunk reports into ${Object.keys(clusterDigests).length} intermediate cluster digests below.`;

        // Calculate original tokens from raw reports to track reduction metrics
        const originalRawTokens = allAnalystReports.reduce((acc, reps) => {
            if (!reps || reps.length === 0) return acc;
            return acc + reps.reduce((s: number, r: any) => s + TokenEstimator.estimatePayloadTokens(typeof r === 'string' ? r : JSON.stringify(r)), 0);
        }, 0);

        // Strict token capping on intermediate summaries (< 4,000 tokens for root manager input)
        const digestsList = Object.values(clusterDigests);
        const maxTokensForDigests = 3200;
        const tokensPerDigest = Math.max(100, Math.floor(maxTokensForDigests / Math.max(1, digestsList.length)));

        clusterDigestText = `Cluster Digests:\n` + digestsList.map(d => {
            const findings = d.keyFindings.slice(0, 5).join('; ');
            const anomalies = d.anomalies.length > 0 ? d.anomalies.slice(0, 3).join('; ') : 'None';
            const rawSummary = d.summary.length > 300 ? d.summary.slice(0, 300) + '...' : d.summary;
            const digestEntry = `[Cluster: ${d.clusterId}] (Specialists: ${d.specialistRoles.join(', ')} | Token Reduction: ${Math.round(d.tokenReductionRatio * 100)}%)\n` +
                `• Key Findings: ${findings}\n` +
                `• Anomalies: ${anomalies}\n` +
                `• Summary: ${rawSummary}`;
            return TokenEstimator.truncateToTokens(digestEntry, tokensPerDigest);
        }).join('\n\n') + '\n\n';

        const reducedTokens = TokenEstimator.estimatePayloadTokens(compiledReports) + TokenEstimator.estimatePayloadTokens(clusterDigestText);
        const saved = Math.max(0, originalRawTokens - reducedTokens);
        workflowPromptTokensSaved += saved;
        workflowOriginalPromptTokens += originalRawTokens;
        workflowCompressedPromptTokens += reducedTokens;
    } else {
        const formatSeatDigest = (role: string, r: any): string => {
            if (typeof r === 'string') return `[${role}] prose: ${r.trim().slice(0, 300)}`;
            if (!r || typeof r !== 'object') return `[${role}] ${String(r ?? '')}`;
            const summary = typeof r.summary === 'string' && r.summary.trim() ? r.summary.trim() : '';
            const insights = Array.isArray(r.insights) && r.insights.length > 0
                ? r.insights.map((x: any) => String(x).trim()).filter(Boolean).join('; ')
                : '';
            const anomalies = Array.isArray(r.anomalies) && r.anomalies.length > 0
                ? r.anomalies.map((x: any) => String(x).trim()).filter(Boolean).join('; ')
                : '';
            const parts = [summary, insights, anomalies].filter(Boolean);
            return `[${role}] ${parts.join(' | ') || 'Completed'}`;
        };

        const verifierDigest = analysts.map((a, i) => {
            const reports = allAnalystReports[i];
            if (!reports || reports.length === 0) return null;
            return reports.map((r) => formatSeatDigest(a.role, r)).join('\n');
        }).filter(Boolean).join('\n\n');

        compiledReports = analysts.map((a, i) => {
            const reports = allAnalystReports[i];
            if (!reports || reports.length === 0) return null;
            const combinedStr = reports
                .map((r) => {
                    const chunkLabel = r._chunkIndex !== undefined ? `--- Chunk ${r._chunkIndex + 1} ---` : '--- Report ---';
                    const content = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
                    return `${chunkLabel}\n${content}`;
                })
                .join('\n\n');
            return `[${a.role} Report]:\n${combinedStr}`;
        }).filter(Boolean).join('\n\n');
        var verifierCompiledDigest = verifierDigest;

        clusterDigestText = Object.values(clusterDigests).length > 0
            ? `Cluster Digests:\n` + Object.values(clusterDigests).map(d =>
                `[Cluster: ${d.clusterId}] (Specialists: ${d.specialistRoles.join(', ')} | Token Reduction: ${Math.round(d.tokenReductionRatio * 100)}%)\n` +
                `• Key Findings: ${d.keyFindings.join('; ')}\n` +
                `• Anomalies: ${d.anomalies.length > 0 ? d.anomalies.join('; ') : 'None'}\n` +
                `• Summary: ${d.summary}`
            ).join('\n\n') + '\n\n'
            : '';
    }

    const rawInputForConflict = p.rawInput || (params as any)?.rawInput || '';
    const conflictHeaders = parseGameHeaders(rawInputForConflict || task, (params as any)?.eventIds);
    const detectedSeatConflicts = detectOpposingSeatConflicts(allAnalystReports, analysts, conflictHeaders);
    const effectiveConsensus: AnalystConsensusDigest | undefined = workflowConsensus
        ? (detectedSeatConflicts.length > 0
            ? {
                ...workflowConsensus,
                unanimousFindings: (workflowConsensus.unanimousFindings || []).filter(f => !findingMentionsSeatConflict(f, detectedSeatConflicts)),
                majorityFindings: (workflowConsensus.majorityFindings || []).filter(f => !findingMentionsSeatConflict(f, detectedSeatConflicts)),
                isContested: true,
                seatConflicts: workflowConsensus.seatConflicts && workflowConsensus.seatConflicts.length > 0
                    ? workflowConsensus.seatConflicts
                    : detectedSeatConflicts
            }
            : workflowConsensus)
        : undefined;
    const consensusPromptBlock = effectiveConsensus ? renderPromptConsensusBlock(effectiveConsensus) : '';
    const standaloneConflictBlock = !consensusPromptBlock && detectedSeatConflicts.length > 0
        ? renderSeatConflictPromptBlock(detectedSeatConflicts)
        : '';
    const consensusSection = [consensusPromptBlock, standaloneConflictBlock].filter(Boolean).join('\n\n')
        ? `${[consensusPromptBlock, standaloneConflictBlock].filter(Boolean).join('\n\n')}\n\n`
        : '';
    if (workflowConsensus?.agreementLevel) {
        recordRunDebugAgreement((context as any)?.id, workflowConsensus.agreementLevel);
    }

    params.onStage?.({
        stage: 'manager_synthesis',
        task,
        digests: clusterDigests
    });

    const baseManagerInstruction = (settings as any)?.managerInstruction
        || (settings as any)?.systemPrompts?.[managerAgent.id || managerAgent.role]
        || (settings as any)?.systemPrompts?.[managerAgent.role]
        || (settings as any)?.systemPrompts?.['manager']
        || activeVariant?.systemPrompts?.[managerAgent.id || managerAgent.role]
        || activeVariant?.systemPrompts?.[managerAgent.role]
        || activeVariant?.systemPrompts?.['manager']
        || MANAGER_SYSTEM_INSTRUCTION;
    const isMorningJudgePrep = (settings as any)?.responseSchema === 'morning_judge';
    const managerInstruction = !isMorningJudgePrep && typeof baseManagerInstruction === 'string' && !baseManagerInstruction.includes('NEVER round or estimate PPG')
        ? `${baseManagerInstruction}\n\n${NO_ROUNDED_PPG_RULE}`
        : baseManagerInstruction;
    managerAgent.setSystemInstruction(managerInstruction);

    const targetCeiling = getManagerContextTokenCeiling(managerAgent.provider);
    const maxChars = targetCeiling * 4;

    const criticResult = (params as any)?.criticResult || (params as any)?.criticFeedback || (settings as any)?.criticResult;
    const criticSection = criticResult
        ? `Critic Result:\n${typeof criticResult === 'string' ? criticResult : JSON.stringify(criticResult, null, 2)}\n\n`
        : '';

    const debateDigest = compileDebateDigest(criticResult);
    const debateSection = debateDigest ? `${debateDigest}\n\n` : '';

    let evidenceChars = 0;
    let evidenceDropped = false;
    let appComputedCountsLine: string | undefined;

    let dynamicPrompt: string;
    if (isBettingRun) {
        const rawInput = p.rawInput || (params as any)?.rawInput || '';
        const parsedHeaders = parseGameHeaders(rawInput || task, (params as any)?.eventIds);

        // S1: Scope Manager synthesis context to proposed/approved games when >= 1 pick was proposed.
        const vetoedLegList: VetoedLegTarget[] = [
            ...(Array.isArray(p.vetoedLegs) ? p.vetoedLegs : []),
            ...(criticResult && typeof criticResult === 'object' && Array.isArray((criticResult as any).vetoedLegs)
                ? (criticResult as any).vetoedLegs
                : [])
        ];
        const isCriticReport = (r: any, role?: string): boolean => {
            const label = String(r?.seat || r?.role || role || '').toLowerCase();
            return label === 'critic' || label === 'risk' || label === 'risk_critic' || label.includes('critic') || label.includes('risk');
        };
        const isVetoedPick = (pick: any): boolean => {
            if (vetoedLegList.length === 0) return false;
            const pEv = String(pick?.eventId || pick?.event_id || pick?.gameId || pick?.game_id || '').toLowerCase().trim();
            const pRow = String(pick?.row || pick?.rowId || pick?.row_id || '').toUpperCase().trim();
            const pText = (typeof pick === 'string'
                ? pick
                : [pick?.row, pick?.team, pick?.pick, pick?.selection, pick?.market, pick?.matchup, pick?.label]
                    .filter(Boolean)
                    .join(' ')
            ).toLowerCase();
            return vetoedLegList.some((v) => {
                const vEv = String((v as any)?.eventId || '').toLowerCase().trim();
                const vRow = String((v as any)?.rowId || (v as any)?.row || '').toUpperCase().trim();
                const vTeam = String((v as any)?.team || '').toLowerCase().trim();
                if (vEv && pEv && vEv === pEv) return true;
                if (vRow && (pRow === vRow || new RegExp(`\\b${vRow}\\b`, 'i').test(pText))) return true;
                if (vTeam && vTeam.length >= 3 && pText.includes(vTeam)) return true;
                return false;
            });
        };

        const rowToEventId = new Map<string, string>();
        for (const h of parsedHeaders) {
            for (const opt of h.options || []) {
                const id = String(opt?.id || '').toUpperCase().trim();
                if (id) rowToEventId.set(id, h.eventId);
            }
            const rawMatches = String((h as any).raw || '').match(/\bR\d+\b/gi) || [];
            for (const rm of rawMatches) {
                const key = rm.toUpperCase();
                if (!rowToEventId.has(key)) rowToEventId.set(key, h.eventId);
            }
        }
        const matchPickToEventId = (pick: any): string | null => {
            if (!pick) return null;
            if (typeof pick === 'object') {
                const direct = String(pick.eventId || pick.event_id || pick.gameId || pick.game_id || '').trim();
                if (direct) return direct;
                const rowRaw = String(pick.row || pick.rowId || pick.row_id || '').toUpperCase().trim();
                if (rowRaw && rowToEventId.has(rowRaw)) return rowToEventId.get(rowRaw)!;
            }
            const text = typeof pick === 'string'
                ? pick
                : [pick.row, pick.rowId, pick.team, pick.pick, pick.selection, pick.matchup, pick.label]
                    .filter(Boolean)
                    .join(' ');
            const rowMatch = text.match(/\b(R\d+)\b/i);
            if (rowMatch) {
                const mapped = rowToEventId.get(rowMatch[1].toUpperCase());
                if (mapped) return mapped;
            }
            const lower = text.toLowerCase();
            if (lower) {
                for (const h of parsedHeaders) {
                    if (h.eventId && lower.includes(h.eventId.toLowerCase())) return h.eventId;
                    const teams = Array.isArray((h as any).teams)
                        ? (h as any).teams
                        : [h.away, h.home, ...String((h as any).matchup || '').split(/\s*(?:@|vs\.?|v\.?)\s*/i)];
                    for (const t of teams) {
                        const tok = String(t || '').trim().toLowerCase();
                        if (tok.length >= 4 && lower.includes(tok)) return h.eventId;
                        const lastWord = tok.split(/\s+/).pop() || '';
                        if (lastWord.length >= 4 && lower.includes(lastWord)) return h.eventId;
                    }
                }
            }
            return null;
        };

        const proposedEventIds = new Set<string>();
        const allProposedPicks: any[] = [];
        allAnalystReports.forEach((seatReports, idx) => {
            const role = analysts[idx]?.role;
            const list = Array.isArray(seatReports) ? seatReports : [];
            for (const r of list) {
                if (!r || typeof r !== 'object' || (r as any)._placeholder === true) continue;
                if (isCriticReport(r, role)) continue;
                const candidatePicks: any[] = [];
                if (Array.isArray((r as any).picks)) candidatePicks.push(...(r as any).picks);
                if ((r as any).scorecard?.pick) candidatePicks.push((r as any).scorecard.pick);
                if (Array.isArray((r as any).scorecards)) {
                    for (const sc of (r as any).scorecards) {
                        if (sc?.pick) candidatePicks.push(sc.pick);
                        if (Array.isArray(sc?.picks)) candidatePicks.push(...sc.picks);
                    }
                }
                for (const pk of candidatePicks) {
                    if (isVetoedPick(pk)) continue;
                    allProposedPicks.push(pk);
                    const evId = matchPickToEventId(pk);
                    if (evId) proposedEventIds.add(evId);
                }
            }
        });

        const hasScopedGames = proposedEventIds.size > 0;
        const scopedHeaders = hasScopedGames
            ? parsedHeaders.filter(h => proposedEventIds.has(h.eventId))
            : parsedHeaders;
        const effectiveHeaders = scopedHeaders.length > 0 ? scopedHeaders : parsedHeaders;
        const renderedHeadersText = renderHeaders(effectiveHeaders, 1600);
        const headersLength = renderedHeadersText.length;
        const { userTask: cappedTask, contractBlock } = partitionTaskAndContract(
            task,
            params.userPrompt ?? params.userQuestion
        );
        const contractSection = contractBlock ? `\nOutput & Slate Contract:\n${contractBlock}` : '';

        const coveredSet = new Set<string>();
        let picksCount = 0;
        let parsedSeats = 0;
        for (const seatReports of allAnalystReports) {
            const list = Array.isArray(seatReports) ? seatReports : [];
            let seatHasRealSummary = false;
            for (const r of list) {
                if (!r || typeof r !== 'object') continue;
                if (Array.isArray((r as any).coveredEventIds)) {
                    for (const id of (r as any).coveredEventIds) {
                        if (id) coveredSet.add(String(id));
                    }
                }
                if ((r as any)._placeholder !== true) {
                    if (Array.isArray((r as any).picks)) {
                        picksCount += (r as any).picks.length;
                    }
                    if (typeof (r as any).summary === 'string' && (r as any).summary.trim().length > 0) {
                        seatHasRealSummary = true;
                    }
                }
            }
            if (seatHasRealSummary) parsedSeats++;
        }
        const agreementPart = workflowConsensus
            ? `, agreement=${workflowConsensus.agreementLevel} ${Math.round(workflowConsensus.consensusScore * 100)}%`
            : '';
        appComputedCountsLine = `App-computed counts: games=${parsedHeaders.length}, covered=${coveredSet.size}, picks=${picksCount}, seats_parsed=${parsedSeats}/${analysts.length}${agreementPart}`;
        const toolStatusLine = Array.isArray(p.toolCallTrace) && p.toolCallTrace.length > 0
            ? buildToolCoverageSummaryLine(p.toolCallTrace, effectiveHeaders)
            : '';

        const pBudget = seatBudget(managerAgent.provider);
        const promptCap = Math.min(maxChars, pBudget.maxPromptChars, MANAGER_MAX_PROMPT_CHARS);
        const seatCount = Math.max(1, analysts.length);
        const perReportCap = Math.max(
            200,
            Math.min(
                1400,
                Math.floor((promptCap - headersLength - contractSection.length - toolStatusLine.length - 1200) / seatCount)
            )
        );

        const seenProseFingerprints = new Set<string>();
        const compactAnalystReport = (r: any): string => {
            if (typeof r === 'string') {
                const norm = r.trim();
                const fp = norm.toLowerCase().replace(/\s+/g, ' ').slice(0, 140);
                if (fp && seenProseFingerprints.has(fp)) return '';
                if (fp) seenProseFingerprints.add(fp);
                return norm;
            }
            if (!r || typeof r !== 'object') return JSON.stringify(r);
            const {
                toolEvidence: _te,
                toolEvidenceItems: _tei,
                toolCallTrace: _tct,
                marketToolRecords: _mtr,
                raw: _raw,
                rawText: _rt,
                coveredEventIds: rawCoveredIds,
                ...rest
            } = r as any;
            const cleaned: Record<string, any> = { ...rest };
            if (Array.isArray(rawCoveredIds) && rawCoveredIds.length > 0 && hasScopedGames) {
                const scopedCovered = rawCoveredIds.filter((id: any) => proposedEventIds.has(String(id)));
                if (scopedCovered.length > 0) cleaned.coveredEventIds = scopedCovered;
            } else if (Array.isArray(rawCoveredIds) && rawCoveredIds.length > 0 && !hasScopedGames) {
                cleaned.coveredEventIds = rawCoveredIds;
            }
            const summaryStr = typeof cleaned.summary === 'string' ? cleaned.summary.trim() : '';
            if (summaryStr) {
                const sfp = summaryStr.toLowerCase().replace(/\s+/g, ' ').slice(0, 140);
                if (seenProseFingerprints.has(sfp)) {
                    cleaned.summary = '[duplicate summary omitted]';
                } else {
                    seenProseFingerprints.add(sfp);
                }
            }
            if (Array.isArray(cleaned.insights)) {
                const dedupedInsights: string[] = [];
                for (const ins of cleaned.insights) {
                    const s = String(ins || '').trim();
                    if (!s) continue;
                    const ifp = s.toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
                    if (summaryStr && summaryStr.toLowerCase().includes(s.toLowerCase().slice(0, 80))) continue;
                    if (seenProseFingerprints.has(ifp)) continue;
                    seenProseFingerprints.add(ifp);
                    dedupedInsights.push(s);
                }
                if (dedupedInsights.length > 0) cleaned.insights = dedupedInsights.slice(0, 6);
                else delete cleaned.insights;
            }
            return JSON.stringify(cleaned);
        };

        let cappedCompiledReports = analysts.map((a, i) => {
            const reports = allAnalystReports[i];
            if (!reports || reports.length === 0) return null;
            const combinedStr = reports
                .map((r) => {
                    let content = compactAnalystReport(r);
                    if (!content) return '';
                    if (content.length > perReportCap) {
                        content = content.slice(0, Math.max(0, perReportCap - 15)) + '\n…[truncated]';
                    }
                    return content;
                })
                .filter(Boolean)
                .join('\n\n');
            if (!combinedStr) return null;
            return `[${a.role} Report]:\n${combinedStr}`;
        }).filter(Boolean).join('\n\n');

        const unionEvidence = typeof p.verifierEvidence === 'string' && p.verifierEvidence.trim()
            ? p.verifierEvidence.trim()
            : '';
        const rawToolEvidence = unionEvidence || analysts.map((a, i) => {
            const reports = allAnalystReports[i];
            if (!reports || reports.length === 0) return null;
            const evStr = reports
                .map((r) => (typeof (r as any)?.toolEvidence === 'string' ? (r as any).toolEvidence.trim() : ''))
                .filter(Boolean)
                .join('\n');
            if (!evStr) return null;
            return `[${a.role}]:\n${evStr}`;
        }).filter(Boolean).join('\n\n');

        // Deduplicate evidence blocks and scope strictly to proposedEventIds when picks were proposed.
        const allKnownEventIds = new Set(parsedHeaders.map(h => h.eventId.toLowerCase()));
        const scopeAndDedupEvidence = (ev: string): string => {
            if (!ev.trim()) return '';
            const rawBlocks = ev
                .split(/\n\n+|(?==== GAME DOSSIER:)|(?=\nEVENT\s+)/)
                .map(b => b.trim())
                .filter(Boolean);
            const seenBlocks = new Set<string>();
            const kept: string[] = [];
            for (const blk of rawBlocks) {
                // Filter TOP PILLAR CANDIDATES header lines to only proposed games when scoped
                if (blk.startsWith('=== TOP PILLAR CANDIDATES') && hasScopedGames) {
                    const lines = blk.split('\n');
                    const filteredLines = [
                        lines[0],
                        ...lines.slice(1).filter((ln) => {
                            const lowerLn = ln.toLowerCase();
                            return Array.from(proposedEventIds).some(id => lowerLn.includes(id.toLowerCase()));
                        })
                    ];
                    if (filteredLines.length > 1) {
                        const joined = filteredLines.join('\n');
                        const fp = joined.toLowerCase().replace(/\s+/g, ' ');
                        if (!seenBlocks.has(fp)) {
                            seenBlocks.add(fp);
                            kept.push(joined);
                        }
                    }
                    continue;
                }
                const fp = blk.toLowerCase().replace(/\s+/g, ' ');
                if (seenBlocks.has(fp)) continue;
                if (hasScopedGames) {
                    const lowerBlk = blk.toLowerCase();
                    const matchesProposed = Array.from(proposedEventIds).some(id => lowerBlk.includes(id.toLowerCase()));
                    if (!matchesProposed) {
                        // Drop any block belonging to another event or non-proposed game
                        const mentionsOtherKnownEvent = Array.from(allKnownEventIds).some(id => lowerBlk.includes(id));
                        const looksLikeEventBlock = /(?:=== GAME DOSSIER:|^\s*EVENT\s+|\b(?:nba|nfl|nhl|mlb|ncaab|ncaaf|mls|soccer|mma|ufc)-[a-z0-9_-]+)/i.test(blk);
                        if (mentionsOtherKnownEvent || looksLikeEventBlock) {
                            continue;
                        }
                    }
                }
                seenBlocks.add(fp);
                kept.push(blk);
            }
            return kept.join('\n\n');
        };

        const cappedToolEvidence = scopeAndDedupEvidence(rawToolEvidence);

        let baselinesText = historicalContext ? `Historical Baselines:\n${historicalContext}\n\n` : '';
        let digestsText = clusterDigestText;
        let toolEvidenceSection = cappedToolEvidence ? `Tool evidence:\n${cappedToolEvidence}\n\n` : '';
        evidenceChars = cappedToolEvidence.length;

        const countsBlock = toolStatusLine ? `${appComputedCountsLine}\n${toolStatusLine}` : appComputedCountsLine;
        const buildBettingPrompt = (bText: string, dText: string, eText: string, reportsText: string = cappedCompiledReports, cSection: string = contractSection) =>
            `${formatUserTaskSection(cappedTask)}${cSection}\nCite only facts present in Game Slate, Tool evidence, or seat summaries.\n${countsBlock}\n\nGame Slate:\n${renderedHeadersText}\n\n${criticSection}${bText}${consensusSection}${dText}${eText}Analyst Reports:\n${reportsText}`;

        let candidate = buildBettingPrompt(baselinesText, digestsText, toolEvidenceSection);
        if (candidate.length > promptCap && digestsText) {
            digestsText = '';
            candidate = buildBettingPrompt(baselinesText, digestsText, toolEvidenceSection);
        }
        if (candidate.length > promptCap && baselinesText) {
            baselinesText = '';
            candidate = buildBettingPrompt(baselinesText, digestsText, toolEvidenceSection);
        }
        if (candidate.length > promptCap && toolEvidenceSection) {
            const prefix = 'Tool evidence:\n';
            const suffix = '\n\n';
            const trimMarker = '\n[evidence trimmed]';
            const restLen = buildBettingPrompt(baselinesText, digestsText, '').length;
            const availableForBody = promptCap - restLen - prefix.length - suffix.length;
            const blocks = cappedToolEvidence
                .split(/\n\n+|\n(?=EVENT\s+)|(?==== GAME DOSSIER:)/)
                .map(b => b.trim())
                .filter(Boolean);
            const keptBlocks: string[] = [];
            let usedLen = 0;
            for (const blk of blocks) {
                const sepLen = keptBlocks.length > 0 ? 2 : 0;
                if (usedLen + sepLen + blk.length + trimMarker.length <= availableForBody) {
                    keptBlocks.push(blk);
                    usedLen += sepLen + blk.length;
                } else if (keptBlocks.length > 0) {
                    break;
                } else if (availableForBody > 120) {
                    keptBlocks.push(blk.slice(0, Math.max(0, availableForBody - trimMarker.length - 3)) + '...');
                    break;
                }
            }
            if (keptBlocks.length > 0) {
                const trimmedBody = `${keptBlocks.join('\n\n')}${trimMarker}`;
                toolEvidenceSection = `${prefix}${trimmedBody}${suffix}`;
                evidenceChars = trimmedBody.length;
                evidenceDropped = false;
            } else {
                toolEvidenceSection = 'Tool evidence:\n[tool evidence omitted: over budget]\n\n';
                evidenceChars = 0;
                evidenceDropped = true;
            }
            candidate = buildBettingPrompt(baselinesText, digestsText, toolEvidenceSection);
        }
        // Final hard backstop: ensure Manager betting prompt never exceeds promptCap (<= 9,000 chars)
        if (candidate.length > promptCap) {
            const overflow = candidate.length - promptCap;
            if (cappedCompiledReports.length > overflow + 200) {
                cappedCompiledReports = cappedCompiledReports.slice(0, cappedCompiledReports.length - overflow - 20) + '\n…[reports trimmed]';
                candidate = buildBettingPrompt(baselinesText, digestsText, toolEvidenceSection, cappedCompiledReports);
            }
            if (candidate.length > promptCap) {
                candidate = candidate.slice(0, Math.max(0, promptCap - 16)) + '\n[prompt capped]';
            }
        }
        dynamicPrompt = candidate;
    } else {
        const { userTask: cleanTask, contractBlock: nonBetContract } = partitionTaskAndContract(
            task,
            params.userPrompt ?? params.userQuestion
        );
        const contractNote = nonBetContract ? `\n\nOutput & Slate Contract:\n${nonBetContract}` : '';
        dynamicPrompt = `${formatUserTaskSection(cleanTask)}${contractNote}\n\nHistorical Baselines:\n${historicalContext}\n\n${consensusSection}${debateSection}${clusterDigestText}Analyst Reports:\n${compiledReports}`;
    }

    let effectiveDynamicPrompt = dynamicPrompt;
    let effectiveCompiledReports = typeof verifierCompiledDigest === 'string' ? verifierCompiledDigest : compiledReports;
    let effectiveHistoricalContext = historicalContext;

    const estimatedPromptTokens = TokenEstimator.estimatePayloadTokens(dynamicPrompt);
    const shouldCompress = !isBettingRun && Boolean(settings?.compressionSettings?.enabled || estimatedPromptTokens > (targetCeiling * 0.60));

    if (shouldCompress) {
        const rawReportsForComp = analysts.map((a, i) => {
            const reports = allAnalystReports[i];
            if (!reports || reports.length === 0) return null;
            const content = reports.map(r => typeof r === 'string' ? r : JSON.stringify(r, null, 2)).join('\n');
            return { role: a.role, content };
        }).filter(Boolean) as Array<{ role: string; content: string }>;

        if (rawReportsForComp.length > 0) {
            const compressionTargetRatio = settings?.compressionSettings?.targetReductionRatio
                || Math.min(0.70, Math.max(0.35, (targetCeiling * 0.70) / Math.max(1, estimatedPromptTokens)));

            const reportComp = globalPromptCompressor.compressAnalystReports(rawReportsForComp, {
                targetReductionRatio: compressionTargetRatio,
                similarityThreshold: settings?.compressionSettings?.similarityThreshold ?? 0.75,
                preserveAnomalies: settings?.compressionSettings?.preserveAnomalies ?? true
            });

            if (reportComp.tokensSaved > 0) {
                effectiveCompiledReports = reportComp.compressedReportsText;
                workflowPromptTokensSaved += reportComp.tokensSaved;
                workflowOriginalPromptTokens += reportComp.originalTokens;
                workflowCompressedPromptTokens += reportComp.compressedTokens;
                workflowDeduplicatedCount += reportComp.deduplicatedSegmentsCount;

                context.addEvent({
                    agentRole: 'Prompt Compression Engine',
                    action: 'Prompt Compressed',
                    modelName: 'Local/PromptCompressor',
                    prompt: `Deduplicated and compressed ${rawReportsForComp.length} specialist reports: ${reportComp.originalTokens} -> ${reportComp.compressedTokens} tokens (${Math.round(reportComp.reductionRatio * 100)}% reduction)`,
                    output: {
                        stage: 'analyst_reports_deduplication',
                        originalTokens: reportComp.originalTokens,
                        compressedTokens: reportComp.compressedTokens,
                        tokensSaved: reportComp.tokensSaved,
                        reductionRatio: reportComp.reductionRatio,
                        deduplicatedSegmentsCount: reportComp.deduplicatedSegmentsCount
                    },
                    durationMs: reportComp.processingTimeMs
                });
            }
        }

        const { userTask: cleanSynTask, contractBlock: synContract } = partitionTaskAndContract(
            task,
            params.userPrompt ?? params.userQuestion
        );
        const synContractNote = synContract ? `\n\nOutput & Slate Contract:\n${synContract}` : '';
        const rawSynthesisPrompt = `${formatUserTaskSection(cleanSynTask)}${synContractNote}\n\nHistorical Baselines:\n${historicalContext}\n\n${consensusSection}${clusterDigestText}Analyst Reports:\n${effectiveCompiledReports}`;
        const currentTokens = Math.ceil(rawSynthesisPrompt.length / 4);

        if (settings?.compressionSettings?.enabled || currentTokens > (targetCeiling * 0.85)) {
            const maxAllowedTokens = settings?.compressionSettings?.maxTokens || Math.floor(targetCeiling * 0.85);
            const synthesisComp = globalPromptCompressor.compress(rawSynthesisPrompt, {
                targetReductionRatio: settings?.compressionSettings?.targetReductionRatio || 0.5,
                similarityThreshold: settings?.compressionSettings?.similarityThreshold ?? 0.75,
                maxTokens: maxAllowedTokens,
                preserveAnomalies: settings?.compressionSettings?.preserveAnomalies ?? true,
                stripBoilerplate: settings?.compressionSettings?.stripBoilerplate ?? true
            });

            effectiveDynamicPrompt = synthesisComp.compressedText;
            if (synthesisComp.tokensSaved > 0) {
                workflowPromptTokensSaved += synthesisComp.tokensSaved;
                workflowOriginalPromptTokens += synthesisComp.originalTokens;
                workflowCompressedPromptTokens += synthesisComp.compressedTokens;
                workflowDeduplicatedCount += synthesisComp.deduplicatedSegmentsCount;

                context.addEvent({
                    agentRole: 'Prompt Compression Engine',
                    action: 'Prompt Compressed',
                    modelName: 'Local/PromptCompressor',
                    prompt: `Compressed Manager synthesis prompt: ${synthesisComp.originalTokens} -> ${synthesisComp.compressedTokens} tokens (${Math.round(synthesisComp.reductionRatio * 100)}% reduction)`,
                    output: {
                        stage: 'manager_synthesis',
                        originalTokens: synthesisComp.originalTokens,
                        compressedTokens: synthesisComp.compressedTokens,
                        tokensSaved: synthesisComp.tokensSaved,
                        reductionRatio: synthesisComp.reductionRatio,
                        deduplicatedSegmentsCount: synthesisComp.deduplicatedSegmentsCount
                    },
                    durationMs: synthesisComp.processingTimeMs
                });
            }
        } else {
            effectiveDynamicPrompt = rawSynthesisPrompt;
        }
    }

    if (isHierarchicalTreeReduction && TokenEstimator.estimatePayloadTokens(effectiveDynamicPrompt) >= 4000) {
        effectiveDynamicPrompt = TokenEstimator.truncateToTokens(effectiveDynamicPrompt, 3900);
    }

    context.addEvent({
        agentRole: managerAgent.role,
        action: 'Manager Synthesis Context',
        modelName: `${managerAgent.provider}/${managerAgent.modelName || 'manager'}`,
        prompt: `promptChars=${effectiveDynamicPrompt.length}, evidenceChars=${evidenceChars}, evidenceDropped=${evidenceDropped}`,
        output: {
            provider: managerAgent.provider,
            model: managerAgent.modelName || 'manager',
            promptChars: effectiveDynamicPrompt.length,
            evidenceChars,
            evidenceDropped
        },
        durationMs: 0
    });

    return {
        effectiveDynamicPrompt,
        effectiveCompiledReports,
        effectiveHistoricalContext,
        ...(appComputedCountsLine ? { appComputedCounts: appComputedCountsLine } : {}),
        workflowOriginalPromptTokens,
        workflowCompressedPromptTokens,
        workflowPromptTokensSaved,
        workflowDeduplicatedCount
    };
}

function extractToolEvidenceSection(promptText: string): string {
    if (!promptText) return '';
    const match = /(?:^|\n)Tool evidence:\s*\n([\s\S]*?)(?=\n\n(?:Analyst Reports:|Specialist Coverage:)|$)/i.exec(promptText);
    return match ? match[1].trim() : '';
}

function stripSeatAgreementText(text: string): string {
    return text
        .replace(/\b\d+\s*\/\s*\d+\s+seats?\s+agree(?:d|s|ment)?\b[^.;\n]*[.;]?/gi, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+([,.;:])/g, '$1')
        .trim();
}

export function sanitizeDivergentSeatAgreement(result: any): void {
    if (!result || typeof result !== 'object') return;
    if (Array.isArray(result)) {
        for (let i = 0; i < result.length; i++) {
            if (typeof result[i] === 'string') {
                result[i] = stripSeatAgreementText(result[i]);
            } else if (result[i] && typeof result[i] === 'object') {
                sanitizeDivergentSeatAgreement(result[i]);
            }
        }
        return;
    }
    for (const key of Object.keys(result)) {
        const val = result[key];
        if (typeof val === 'string') {
            result[key] = stripSeatAgreementText(val);
        } else if (val && typeof val === 'object') {
            sanitizeDivergentSeatAgreement(val);
        }
    }
}

export async function executeManagerSynthesis(
    managerAgent: Agent,
    effectiveDynamicPrompt: string,
    context: SwarmContext,
    activeVariant?: AgentVariantConfig,
    bypassCache: boolean = false,
    settings?: SwarmEngineSettings,
    coveredEventIds?: string[],
    groundingContext?: {
        toolResults?: string;
        marketToolRecords?: MarketToolRecord[];
        criticVetoes?: string[];
        vetoedLegs?: VetoedLegTarget[];
        vetoedClaims?: string[];
        rawBoard?: string;
        toolCallTrace?: ToolCallTraceEntry[];
        availableTools?: string[];
        criticAuditFailed?: boolean;
        unauditedLegs?: VetoedLegTarget[];
        hadProposedPicks?: boolean;
        criticVerdictApproved?: boolean;
        auditNote?: string;
        agreementLevel?: 'strong' | 'moderate' | 'divergent';
        activeEventIds?: string[];
        seatScorecards?: any[];
    }
): Promise<any> {
    const baseManagerInstruction = (settings as any)?.managerInstruction
        || (settings as any)?.systemPrompts?.[managerAgent.id || managerAgent.role]
        || (settings as any)?.systemPrompts?.[managerAgent.role]
        || (settings as any)?.systemPrompts?.['manager']
        || activeVariant?.systemPrompts?.[managerAgent.id || managerAgent.role]
        || activeVariant?.systemPrompts?.[managerAgent.role]
        || activeVariant?.systemPrompts?.['manager']
        || MANAGER_SYSTEM_INSTRUCTION;
    const isMorningJudge = (settings as any)?.responseSchema === 'morning_judge';
    const managerInstruction = !isMorningJudge && typeof baseManagerInstruction === 'string' && !baseManagerInstruction.includes('NEVER round or estimate PPG')
        ? `${baseManagerInstruction}\n\n${NO_ROUNDED_PPG_RULE}`
        : baseManagerInstruction;
    managerAgent.setSystemInstruction(managerInstruction);
    const zodSchema = isMorningJudge
        ? undefined
        : ((settings as any)?.zodSchema || (settings as any)?.responseSchema || ManagerResponseSchema);

    const ceilingTokens = getManagerContextTokenCeiling(managerAgent.provider);
    const maxChars = ceilingTokens * 4;
    let safeDynamicPrompt = effectiveDynamicPrompt;

    if (coveredEventIds && coveredEventIds.length > 0) {
        safeDynamicPrompt += `\n\nSpecialist Coverage: Analyst tools only covered event ID(s): ${coveredEventIds.join(', ')}. Only recommend picks from covered games.`;
    }

    if (safeDynamicPrompt.length > maxChars) {
        if (safeDynamicPrompt.includes('Cluster Digests:')) {
            safeDynamicPrompt = safeDynamicPrompt.replace(/Cluster Digests:[\s\S]*?(?=\n\n(?:Analyst Reports|Raw Board|Critic Result|Task:|$))/i, '');
            recordRunDebugDrop((context as any)?.id, 'manager', 'Cluster Digests');
        }
        if (safeDynamicPrompt.length > maxChars && safeDynamicPrompt.includes('Historical Baselines:')) {
            safeDynamicPrompt = safeDynamicPrompt.replace(/Historical Baselines:[\s\S]*?(?=\n\n(?:Analyst Reports|Raw Board|Critic Result|Task:|$))/i, '');
            recordRunDebugDrop((context as any)?.id, 'manager', 'Historical Baselines');
        }
        if (safeDynamicPrompt.length > maxChars) {
            const trimTarget = maxChars - 120;
            const lastBreak = Math.max(safeDynamicPrompt.lastIndexOf('\n\n', trimTarget), safeDynamicPrompt.lastIndexOf('\n', trimTarget));
            const cut = lastBreak > (maxChars * 0.5) ? lastBreak : trimTarget;
            safeDynamicPrompt = safeDynamicPrompt.slice(0, cut) + '\n\n[trimmed for manager context ceiling]';
            recordRunDebugDrop((context as any)?.id, 'manager', 'manager prompt tail');
        }
    }

    recordRunDebugSeat((context as any)?.id, 'manager', {
        role: managerAgent.role,
        provider: String(managerAgent.provider),
        model: managerAgent.modelName,
        promptChars: safeDynamicPrompt.length,
        limitChars: maxChars,
        toolResultsSent: extractToolEvidenceSection(safeDynamicPrompt)
    });

    const parsedManagerOutput = await managerAgent.run(safeDynamicPrompt, context, {
        responseMimeType: "application/json",
        zodSchema,
        bypassCache,
        // The morning judge on Groq gets the chat caps too (18k-char prompt, max_tokens = min(2000, 7000 - ceil(chars/4)),
        // < 800 => skip to the next fallback), so its debate transcript isn't cut at the 6k legacy cap.
        groqMode: 'chat',
        ...activeVariant?.parameters
    });

    const finalResult = (isMorningJudge || (parsedManagerOutput && typeof parsedManagerOutput === 'object' && ('winProbHome' in parsedManagerOutput || 'win_prob_home' in parsedManagerOutput)))
        ? parsedManagerOutput
        : guardManagerResponse(parsedManagerOutput, "Executive Swarm Synthesis");
    const initialPicksSnapshot = Array.isArray(finalResult?.picks) ? [...finalResult.picks] : [];

    if (finalResult && typeof finalResult === 'object') {
        const initialPickCount = Array.isArray(finalResult.picks) ? finalResult.picks.length : 0;
        const slateSourceForGrounding = groundingContext?.rawBoard || safeDynamicPrompt;
        const parsedHeaders = parseGameHeaders(slateSourceForGrounding);
        const toolEvidenceForGrounding = groundingContext?.toolResults !== undefined
            ? groundingContext.toolResults
            : extractToolEvidenceSection(safeDynamicPrompt);
        sanitizeMisattributedPicksAndText(finalResult, safeDynamicPrompt, safeDynamicPrompt);
        sanitizeRowMismatchedPicks(finalResult, slateSourceForGrounding, parsedHeaders, {
            toolEvidenceText: toolEvidenceForGrounding,
            toolRecords: groundingContext?.marketToolRecords
        });
        const criticVetoes = groundingContext?.criticVetoes || [];
        const vetoedLegs = mergeVetoedLegTargets(groundingContext?.vetoedLegs);
        const vetoedClaims = mergeVetoedClaims(groundingContext?.vetoedClaims);
        if (
            parsedHeaders.length > 0 ||
            Boolean(toolEvidenceForGrounding) ||
            criticVetoes.length > 0 ||
            vetoedLegs.length > 0 ||
            vetoedClaims.length > 0
        ) {
            sanitizeUngroundedClaims(finalResult, toolEvidenceForGrounding, slateSourceForGrounding, {
                headers: parsedHeaders,
                vetoTexts: criticVetoes,
                vetoedLegs,
                vetoedClaims,
                stripVetoedLegRecommendations: true
            });
        }
        if (
            parsedHeaders.length > 0 ||
            Boolean(toolEvidenceForGrounding) ||
            Boolean(groundingContext?.toolCallTrace?.length)
        ) {
            sanitizePullBeforePassClaims(finalResult, toolEvidenceForGrounding, slateSourceForGrounding, {
                headers: parsedHeaders,
                toolCallTrace: groundingContext?.toolCallTrace,
                ...(groundingContext?.availableTools && groundingContext.availableTools.length > 0
                    ? { availableTools: groundingContext.availableTools }
                    : {}),
                marketToolRecords: groundingContext?.marketToolRecords,
                ...(Array.isArray(groundingContext?.activeEventIds)
                    ? { activeEventIds: groundingContext.activeEventIds }
                    : {})
            });
        }
        const hadVetoes = criticVetoes.length > 0 || vetoedLegs.length > 0 || vetoedClaims.length > 0;
        normalizePassIfAllLegsVetoed(finalResult, initialPickCount, hadVetoes, {
            vetoTexts: criticVetoes,
            vetoedLegs,
            seatScorecards: groundingContext?.seatScorecards,
            ...(hadVetoes && Array.isArray(finalResult.picks) && finalResult.picks.length === 0 ? { criticApproved: false } : {})
        });
        enforceCriticAuditOnFinalAnalysis(finalResult, {
            criticAuditFailed: groundingContext?.criticAuditFailed === true,
            unauditedLegs: groundingContext?.unauditedLegs,
            hadProposedPicks: Boolean(groundingContext?.hadProposedPicks || initialPickCount > 0),
            auditNote: groundingContext?.auditNote
        });
        const hadFullVeto = initialPickCount > 0 && hadVetoes && Array.isArray(finalResult.picks) && finalResult.picks.length === 0;
        finalResult.criticApproved = resolveFinalCriticApproved(finalResult, {
            criticAuditFailed: groundingContext?.criticAuditFailed === true,
            criticVerdictApproved: groundingContext?.criticVerdictApproved,
            hadFullVeto
        });
        const isDivergentRun = groundingContext?.agreementLevel === 'divergent'
            || /\bagreement=divergent\b/i.test(safeDynamicPrompt)
            || /\bLevel:\s*divergent\b/i.test(safeDynamicPrompt);
        if (isDivergentRun) {
            const beforeDiv = JSON.stringify(finalResult);
            sanitizeDivergentSeatAgreement(finalResult);
            const afterDiv = JSON.stringify(finalResult);
            if (afterDiv !== beforeDiv) {
                recordRunDebugEdit((context as any)?.id, 'manager', {
                    check: 'sanitizeDivergentSeatAgreement',
                    before: beforeDiv,
                    after: afterDiv,
                    reason: 'Stripped N/N seats agree claim on divergent run'
                });
            }
        }
    }

    if (coveredEventIds && Array.isArray(finalResult?.picks)) {
        const headers = parseGameHeaders(safeDynamicPrompt);
        const originalCount = finalResult.picks.length;
        finalResult.picks = filterPicksByCoverage(finalResult.picks, coveredEventIds, headers);
        if (finalResult.picks.length === 0 && originalCount > 0) {
            finalResult.ui_title = 'Insufficient data';
            finalResult.reason = 'no picks with specialist coverage';
            finalResult.criticApproved = false;
        }
    }

    if (finalResult && typeof finalResult === 'object' && Array.isArray(finalResult.picks)) {
        const syncBoardSource = groundingContext?.rawBoard || safeDynamicPrompt;
        const syncVetoedLegs = mergeVetoedLegTargets(groundingContext?.vetoedLegs);
        syncCompilerProseWithFinalPicks(finalResult, {
            initialPicks: initialPicksSnapshot,
            headers: parseGameHeaders(syncBoardSource),
            slateText: syncBoardSource,
            ...(syncVetoedLegs.length > 0 ? { vetoedLegs: syncVetoedLegs } : {}),
            ...(groundingContext?.criticVetoes && groundingContext.criticVetoes.length > 0 ? { vetoTexts: groundingContext.criticVetoes } : {}),
            ...(groundingContext?.seatScorecards && groundingContext.seatScorecards.length > 0 ? { seatScorecards: groundingContext.seatScorecards } : {}),
            ...(finalResult.criticApproved === false ? { criticApproved: false } : {})
        });
        sanitizeCompilerProposalOddsAndSummary(finalResult);
    }

    if (groundingContext?.agreementLevel) {
        recordRunDebugAgreement((context as any)?.id, groundingContext.agreementLevel);
    }
    recordRunDebugSeat((context as any)?.id, 'manager', {
        outputDigest: formatRunDebugOutputDigest(finalResult)
    });

    return finalResult;
}
