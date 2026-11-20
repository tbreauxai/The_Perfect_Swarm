import { describe, it, expect, beforeEach } from 'vitest';
import { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import {
  ANALYST_SYSTEM_INSTRUCTION,
  CRITIC_AUDIT_RULE,
  CRITIC_VERDICT_SYSTEM_INSTRUCTION,
  MANAGER_SYSTEM_INSTRUCTION,
  RED_TEAM_ANALYST_SYSTEM_INSTRUCTION
} from '../swarm/engine/constants.ts';
import { runDeepAnalysisVerification } from '../swarm/engine/verificationPipeline.ts';
import { executeManagerSynthesis } from '../swarm/engine/synthesisPipeline.ts';
import { auditMarketCoverageAndRowBinding, sanitizeRowMismatchedPicks } from '../swarm/tools/marketRowBinding.ts';
import { auditClaimGrounding, sanitizeUngroundedClaims } from '../swarm/tools/claimGrounding.ts';
import { isNoPicksToEvaluateText, enforceCriticAuditOnFinalAnalysis } from '../swarm/tools/criticAudit.ts';
import { parseGameHeaders } from '../swarm/context/gameHeaders.ts';
import { runClusterPipeline } from '../swarm/engine/clusterPipeline.ts';

const SLATE_TEXT = [
  'event_id=ncaaf-401800101 | sport=ncaaf | New Mexico Lobos @ UNLV Rebels | R1: New Mexico Lobos -7.5 (-110) | R2: UNLV Rebels +7.5 (-110)',
  'event_id=nba-401800202 | sport=nba | New Orleans Pelicans @ Oklahoma City Thunder | R3: New Orleans Pelicans +12.5 (-110) | R4: Oklahoma City Thunder -12.5 (-110)'
].join('\n');

const SNAPSHOT_ONLY_SLATE_TEXT = [
  'event_id=ncaaf-401800101 | sport=ncaaf | New Mexico Lobos @ UNLV Rebels',
  'event_id=nba-401800202 | sport=nba | New Orleans Pelicans @ Oklahoma City Thunder'
].join('\n');

const NM_MARKET_SUMMARY =
  '[MARKET MOVEMENT: ncaaf-401800101 | spread] Current: spread 7.5, ml_away -290, ml_home +240, Total: 58.5.';

const OKC_MARKET_SUMMARY =
  '[MARKET MOVEMENT: nba-401800202 | all] Current: home Oklahoma City Thunder -12.5 / away New Orleans Pelicans +12.5 | ml_home -650, ml_away +460.';

const OKC_INJURY_SUMMARY =
  '[INJURY & ROSTER DELTA: nba-401800202] Oklahoma City Thunder: Chet Holmgren (OUT), Jalen Williams (OUT), Cason Wallace (OUT), Thomas Sorber (OUT). New Orleans Pelicans: No key injuries reported.';

function makeStubRegistry(): ToolRegistry {
  return new ToolRegistry([
    {
      name: 'get_market_movement',
      description: 'Market movement snapshot',
      parameters: { game_id: { type: 'string', description: 'Game ID', required: true } },
      execute: async (params: any) => {
        const id = String(params?.game_id || '');
        if (id === 'ncaaf-401800101') {
          return {
            success: true,
            summary: NM_MARKET_SUMMARY,
            data: { spread: 7.5, ml_away: -290, ml_home: 240, total: 58.5 },
            markets_covered: ['spread', 'ml', 'total']
          } as any;
        }
        if (id === 'nba-401800202') {
          return {
            success: true,
            summary: OKC_MARKET_SUMMARY,
            data: { spread_home: -12.5, spread_away: 12.5, ml_home: -650, ml_away: 460 },
            markets_covered: ['spread', 'ml']
          } as any;
        }
        return { success: true, empty: true, summary: 'No market data.' } as any;
      }
    },
    {
      name: 'get_injury_and_roster_delta',
      description: 'Injury report',
      parameters: { game_id: { type: 'string', description: 'Game ID', required: true } },
      execute: async (params: any) => {
        const id = String(params?.game_id || '');
        if (id === 'nba-401800202') {
          return {
            success: true,
            summary: OKC_INJURY_SUMMARY,
            data: {
              injuries: [
                { player: 'Chet Holmgren', team: 'Oklahoma City Thunder', status: 'OUT' },
                { player: 'Jalen Williams', team: 'Oklahoma City Thunder', status: 'OUT' },
                { player: 'Cason Wallace', team: 'Oklahoma City Thunder', status: 'OUT' },
                { player: 'Thomas Sorber', team: 'Oklahoma City Thunder', status: 'OUT' }
              ]
            }
          } as any;
        }
        return { success: true, empty: true, summary: 'No injury report available.' } as any;
      }
    },
    {
      name: 'get_matchup_fundamentals',
      description: 'Matchup fundamentals',
      parameters: { game_id: { type: 'string', description: 'Game ID', required: true } },
      execute: async () => {
        // No form tool result for New Mexico (empty)
        return { success: true, empty: true, summary: 'No matchup fundamentals found.' } as any;
      }
    }
  ]);
}

function makeMockAgent(
  id: string,
  role: string,
  handler: (prompt: string, systemInstruction: string, callIdx: number) => string | Promise<string>
): Agent {
  const agent = new Agent(role, 'mock-model', 'mock-provider', 'mock-key');
  (agent as any).id = id;
  let callIdx = 0;
  (agent as any).run = async (prompt: string) => {
    const idx = callIdx++;
    return handler(prompt, (agent as any).systemInstruction || '', idx);
  };
  return agent;
}

describe('Swarm Fix: Critic must audit proposed picks', () => {
  beforeEach(() => {
    // Clean slate per test
  });

  it('(1) embeds verbatim CRITIC_AUDIT_RULE across Critic, Analyst, Manager, Verification Critic, and Retry Rules', async () => {
    const expected = [
      'CRITIC AUDIT:',
      '- If Quant proposes picks, the Critic must audit those picks.',
      '- "No picks to evaluate" is only valid when the picks array is empty.',
      '- Reject a pick whose spread does not match the tool or slate row.',
      '- Reject a pick that cites PPG, a record, or form with no successful tool result.',
      '- Do not keep a leg the Critic did not audit.',
      '- If the Critic does not evaluate proposed picks, the result is a pass, not a recommendation.'
    ].join('\n');

    expect(CRITIC_AUDIT_RULE).toBe(expected);
    expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).toContain(expected);
    expect(ANALYST_SYSTEM_INSTRUCTION).toContain(expected);
    expect(RED_TEAM_ANALYST_SYSTEM_INSTRUCTION).toContain(expected);
    expect(MANAGER_SYSTEM_INSTRUCTION).toContain(expected);

    let capturedRetryPrompt = '';
    const manager = makeMockAgent('manager', 'Swarm Orchestrator', (prompt, _sys, idx) => {
      if (idx === 1) capturedRetryPrompt = prompt;
      if (idx === 0) {
        return JSON.stringify({
          ui_title: '2-Leg Parlay',
          summary: 'Lobos -8.5 and Pelicans +12.5.',
          picks: [
            { event_id: 'ncaaf-401800101', side: 'New Mexico Lobos -8.5', reason: 'New Mexico averaging 35+ PPG.' },
            { event_id: 'nba-401800202', side: 'New Orleans Pelicans +12.5', reason: 'OKC missing Holmgren, Williams, Wallace, Sorber.' }
          ],
          components: []
        });
      }
      return JSON.stringify({
        ui_title: 'Grounded Single',
        summary: 'Pelicans +12.5 backed by OKC injuries (Holmgren, Williams, Wallace, Sorber OUT).',
        picks: [
          { event_id: 'nba-401800202', row: 'R3', side: 'New Orleans Pelicans +12.5', reason: 'OKC missing Holmgren, Williams, Wallace, Sorber OUT.' }
        ],
        components: []
      });
    });
    const verifyCritic = makeMockAgent('critic', 'Verification Critic', (_p, _sys, idx) => {
      if (idx === 0) return JSON.stringify({ pass: false, feedback: 'Veto Lobos -8.5 (line is -7.5, ungrounded 35+ PPG).' });
      return JSON.stringify({ pass: true, feedback: 'Pelicans +12.5 verified against OKC injuries and -12.5/+12.5 spread.' });
    });

    await runDeepAnalysisVerification({
      task: 'Build a 2-leg parlay with New Mexico and Pelicans',
      rawInput: SLATE_TEXT,
      effectiveDynamicPrompt: 'Synthesize picks.',
      effectiveCompiledReports: 'Quant proposed Lobos -8.5 + Pelicans +12.5.',
      effectiveHistoricalContext: '',
      managerAgent: manager,
      analysts: [verifyCritic],
      dedicatedCriticAgent: verifyCritic,
      context: new SwarmContext(),
      toolRegistry: makeStubRegistry()
    });

    expect((verifyCritic as any).systemInstruction).toContain(expected);
    expect(capturedRetryPrompt).toContain(expected);
  });

  it('(2) rejects Lobos -8.5 when snapshot is bare 7.5 with ml_away -290 (line is -7.5) and strips it while keeping Pelicans +12.5', () => {
    const headers = parseGameHeaders(SNAPSHOT_ONLY_SLATE_TEXT);
    const toolEvidence = [
      `EVENT ncaaf-401800101\nMKT: ${NM_MARKET_SUMMARY}`,
      `EVENT nba-401800202\nMKT: ${OKC_MARKET_SUMMARY}\nINJ: ${OKC_INJURY_SUMMARY}`
    ].join('\n\n');
    const marketRecords = [
      {
        tool: 'get_market_movement',
        eventId: 'ncaaf-401800101',
        summary: NM_MARKET_SUMMARY,
        data: { spread: 7.5, ml_away: -290, ml_home: 240 },
        markets_covered: ['spread', 'ml']
      },
      {
        tool: 'get_market_movement',
        eventId: 'nba-401800202',
        summary: OKC_MARKET_SUMMARY,
        data: { spread_home: -12.5, spread_away: 12.5, ml_home: -650, ml_away: 460 },
        markets_covered: ['spread', 'ml']
      }
    ];

    const proposal = {
      summary: 'Backing Lobos -8.5 and Pelicans +12.5.',
      picks: [
        { event_id: 'ncaaf-401800101', side: 'Lobos -8.5', reason: 'New Mexico covers easily.' },
        { event_id: 'nba-401800202', side: 'Pelicans +12.5', reason: 'OKC missing Holmgren, Williams, Wallace, Sorber OUT.' }
      ]
    };

    const audit = auditMarketCoverageAndRowBinding(
      proposal,
      toolEvidence,
      SNAPSHOT_ONLY_SLATE_TEXT,
      headers,
      marketRecords
    );
    expect(audit.pass).toBe(false);
    expect(audit.flags).toContain('spread_value_mismatch');
    expect(audit.feedback).toMatch(/-8\.5/);
    expect(audit.feedback).toMatch(/-7\.5/);
    expect(audit.vetoedLegs?.length).toBeGreaterThan(0);

    const sanitized = sanitizeRowMismatchedPicks(structuredClone(proposal), SNAPSHOT_ONLY_SLATE_TEXT, headers, {
      toolEvidenceText: toolEvidence,
      toolRecords: marketRecords
    });
    expect(sanitized.picks).toHaveLength(1);
    expect(sanitized.picks[0].side).toContain('Pelicans +12.5');
    expect(JSON.stringify(sanitized)).not.toContain('-8.5');
  });

  it('(3) rejects "New Mexico averaging 35+ PPG" when no form tool result exists and strips the claim and affected leg', () => {
    const headers = parseGameHeaders(SLATE_TEXT);
    const toolEvidence = [
      `EVENT ncaaf-401800101\nMKT: ${NM_MARKET_SUMMARY}`,
      `EVENT nba-401800202\nMKT: ${OKC_MARKET_SUMMARY}\nINJ: ${OKC_INJURY_SUMMARY}`
    ].join('\n\n');

    const proposal = {
      summary: 'New Mexico averaging 35+ PPG makes Lobos -7.5 attractive alongside Pelicans +12.5.',
      picks: [
        { event_id: 'ncaaf-401800101', row: 'R1', side: 'New Mexico Lobos -7.5', reason: 'New Mexico averaging 35+ PPG on offense.' },
        { event_id: 'nba-401800202', row: 'R3', side: 'New Orleans Pelicans +12.5', reason: 'OKC missing Holmgren, Williams, Wallace, Sorber OUT.' }
      ]
    };

    const groundingAudit = auditClaimGrounding(proposal, toolEvidence, SLATE_TEXT, { headers });
    expect(groundingAudit.pass).toBe(false);
    expect(groundingAudit.feedback).toMatch(/35\+?\s*PPG/i);
    expect(groundingAudit.vetoedLegs?.length).toBeGreaterThan(0);
    expect(groundingAudit.vetoedClaims?.some(c => /35\+?\s*PPG/i.test(c))).toBe(true);

    const sanitized = sanitizeUngroundedClaims(structuredClone(proposal), toolEvidence, SLATE_TEXT, {
      headers,
      vetoedLegs: groundingAudit.vetoedLegs,
      vetoedClaims: groundingAudit.vetoedClaims,
      stripVetoedLegRecommendations: true
    });
    expect(sanitized.picks).toHaveLength(1);
    expect(sanitized.picks[0].side).toContain('Pelicans +12.5');
    expect(JSON.stringify(sanitized)).not.toMatch(/35\+\s*PPG/i);
  });

  it('(4) Stage 2 Risk Critic re-prompts when Critic says "No picks to evaluate" despite Quant proposing legs (Market says no parlay)', async () => {
    const context = new SwarmContext();
    const registry = makeStubRegistry();
    const headers = parseGameHeaders(SLATE_TEXT);

    const quantAgent = makeMockAgent('quant', 'Quant Specialist', () =>
      JSON.stringify({
        summary: 'Proposing New Mexico Lobos -8.5 (averaging 35+ PPG) + Pelicans +12.5 (OKC injuries).',
        insights: ['New Mexico averaging 35+ PPG', 'OKC missing Holmgren, Williams, Wallace, Sorber OUT'],
        picks: [
          {
            event_id: 'ncaaf-401800101',
            side: 'Lobos -8.5',
            reason: 'New Mexico averaging 35+ PPG.'
          },
          {
            event_id: 'nba-401800202',
            row: 'R3',
            side: 'New Orleans Pelicans +12.5',
            reason: 'OKC missing Chet Holmgren, Jalen Williams, Cason Wallace, Thomas Sorber OUT.'
          }
        ]
      })
    );

    const marketAgent = makeMockAgent('market', 'Market Specialist', () =>
      JSON.stringify({
        summary: 'No parlay recommended from market movement alone.',
        insights: ['New Mexico spread is -7.5 (ml_away -290); OKC is -12.5 home favorite.'],
        picks: []
      })
    );

    let criticCalls = 0;
    let criticRepromptSawLegs = false;
    const riskCritic = makeMockAgent('critic', 'Risk Critic', (prompt) => {
      criticCalls++;
      if (!prompt.includes('CORRECTION — CRITIC AUDIT REQUIRED')) {
        // Return invalid "No picks to evaluate." until explicitly re-prompted
        return JSON.stringify({
          pass: true,
          verdict: 'No picks to evaluate.',
          flags: []
        });
      }
      criticRepromptSawLegs = prompt.includes('Pelicans +12.5') && prompt.includes('CORRECTION — CRITIC AUDIT REQUIRED');
      return JSON.stringify({
        pass: true,
        verdict: 'Audited Pelicans +12.5: grounded by OKC injuries (Holmgren, Williams, Wallace, Sorber OUT) and matching -12.5/+12.5 spread.',
        flags: []
      });
    });

    const managerAgent = makeMockAgent('manager', 'Swarm Orchestrator', () => JSON.stringify({ summary: 'Manager', picks: [] }));
    const taskStr = 'Give me a 2-leg parlay combining a college football spread and an NBA injury angle.';

    const clusterRes = await runClusterPipeline({
      task: taskStr,
      data: SLATE_TEXT,
      analysts: [quantAgent, marketAgent, riskCritic],
      managerAgent,
      chunks: [SLATE_TEXT],
      profile: { totalSize: SLATE_TEXT.length, complexity: 'low' },
      rawInput: SLATE_TEXT,
      historicalContext: '',
      targetAppId: 'test-app',
      context,
      toolRegistry: registry,
      params: { task: taskStr, data: SLATE_TEXT },
      optimizationEnabled: false,
      coordinationEnabled: false,
      bypassCache: true
    });

    const quantReport = clusterRes.allAnalystReports[0]?.[0];
    expect(quantReport).toBeDefined();
    expect(quantReport.picks).toHaveLength(1);
    expect(quantReport.picks[0].side).toContain('Pelicans +12.5');
    expect(JSON.stringify(quantReport)).not.toContain('-8.5');
    expect(JSON.stringify(quantReport)).not.toMatch(/35\+\s*PPG/i);

    const criticReport = clusterRes.allAnalystReports[2]?.[0];
    expect(criticReport).toBeDefined();
    expect(criticCalls).toBeGreaterThanOrEqual(2);
    expect(criticRepromptSawLegs).toBe(true);
    expect(criticReport.pass).toBe(true);
    expect(isNoPicksToEvaluateText(criticReport.verdict || criticReport.summary)).toBe(false);
    expect(criticReport.criticAudit?.criticSkippedAudit).toBe(false);
    expect(criticReport.criticAudit?.proposedLegCount).toBe(1);

    // Confirm slate headers covered both college football and NBA games
    expect(headers).toHaveLength(2);
  });

  it('(5) full verification loop rejects Lobos -8.5 and 35+ PPG, re-prompts "No picks to evaluate", and lets grounded Pelicans +12.5 pass', async () => {
    const context = new SwarmContext();
    const registry = makeStubRegistry();

    const manager = makeMockAgent('manager', 'Swarm Orchestrator', (_prompt, _sys, idx) => {
      if (idx === 0) {
        return JSON.stringify({
          ui_title: '2-Leg Parlay',
          summary: 'Recommended Lobos -8.5 (New Mexico averaging 35+ PPG) + Pelicans +12.5 with OKC missing Holmgren, Williams, Wallace, Sorber OUT.',
          picks: [
            {
              event_id: 'ncaaf-401800101',
              side: 'Lobos -8.5',
              reason: 'New Mexico averaging 35+ PPG.'
            },
            {
              event_id: 'nba-401800202',
              row: 'R3',
              side: 'New Orleans Pelicans +12.5',
              reason: 'OKC missing Chet Holmgren, Jalen Williams, Cason Wallace, Thomas Sorber OUT; Pelicans +12.5 matches OKC -12.5.'
            }
          ],
          components: []
        });
      }
      // Attempt 2: drops vetoed Lobos -8.5 and 35+ PPG, keeps grounded Pelicans +12.5
      return JSON.stringify({
        ui_title: 'Grounded NBA Single',
        summary: 'Bottom-line call: New Orleans Pelicans +12.5 (R3) is backed by OKC injuries (Holmgren, Williams, Wallace, Sorber OUT) matching OKC home spread -12.5.',
        picks: [
          {
            event_id: 'nba-401800202',
            row: 'R3',
            side: 'New Orleans Pelicans +12.5',
            reason: 'OKC missing Holmgren, Williams, Wallace, Sorber OUT; line matches OKC -12.5.'
          }
        ],
        components: []
      });
    });

    let criticCallCount = 0;
    const verifyCritic = makeMockAgent('critic', 'Verification Critic', (prompt) => {
      criticCallCount++;
      if (criticCallCount === 1) {
        // Initially outputs invalid "No picks to evaluate" despite 2 picks being proposed
        return JSON.stringify({ pass: true, feedback: 'No picks to evaluate.' });
      }
      if (criticCallCount === 2) {
        // Re-prompted on Attempt 1: now audits both legs
        expect(prompt).toContain('CORRECTION — CRITIC AUDIT REQUIRED');
        expect(prompt).toContain('Lobos -8.5');
        expect(prompt).toContain('Pelicans +12.5');
        return JSON.stringify({
          pass: false,
          feedback: 'Reject Lobos -8.5 (line is -7.5, not -8.5, and "35+ PPG" has no form tool result). Pelicans +12.5 is grounded.'
        });
      }
      // Attempt 2: audits revised proposal with only Pelicans +12.5
      return JSON.stringify({
        pass: true,
        feedback: 'Pelicans +12.5 verified: OKC Holmgren, Williams, Wallace, Sorber OUT confirmed and spread matches OKC -12.5.'
      });
    });

    const { finalAnalysis, lifecycleResult } = await runDeepAnalysisVerification({
      task: 'Build a parlay with New Mexico spread and Pelicans injury angle.',
      rawInput: SLATE_TEXT,
      effectiveDynamicPrompt: 'Synthesize grounded picks.',
      effectiveCompiledReports: 'Quant proposed Lobos -8.5 + Pelicans +12.5; Market said no parlay.',
      effectiveHistoricalContext: '',
      managerAgent: manager,
      analysts: [verifyCritic],
      dedicatedCriticAgent: verifyCritic,
      context,
      toolRegistry: registry,
      toolEvidenceItems: [
        { tool: 'get_market_movement', eventId: 'ncaaf-401800101', summary: NM_MARKET_SUMMARY },
        { tool: 'get_market_movement', eventId: 'nba-401800202', summary: OKC_MARKET_SUMMARY },
        { tool: 'get_injury_and_roster_delta', eventId: 'nba-401800202', summary: OKC_INJURY_SUMMARY }
      ],
      marketToolRecords: [
        { tool: 'get_market_movement', eventId: 'ncaaf-401800101', summary: NM_MARKET_SUMMARY, data: { spread: 7.5, ml_away: -290, ml_home: 240 }, markets_covered: ['spread', 'ml'] },
        { tool: 'get_market_movement', eventId: 'nba-401800202', summary: OKC_MARKET_SUMMARY, data: { spread_home: -12.5, spread_away: 12.5, ml_home: -650, ml_away: 460 }, markets_covered: ['spread', 'ml'] }
      ],
      hadProposedPicks: true
    });

    expect(lifecycleResult.success).toBe(true);
    expect(lifecycleResult.attempts).toBe(2);
    expect(criticCallCount).toBe(3);
    expect(finalAnalysis.picks).toHaveLength(1);
    expect(finalAnalysis.picks[0].side).toContain('Pelicans +12.5');
    const serialized = JSON.stringify(finalAnalysis);
    expect(serialized).not.toContain('Lobos -8.5');
    expect(serialized).not.toContain('-8.5');
    expect(serialized).not.toMatch(/35\+\s*PPG/i);
    expect(serialized).not.toMatch(/no picks to evaluate/i);
  });

  it('(6) converts result to a PASS (not a recommendation) when Critic refuses to evaluate proposed picks even after re-prompt', async () => {
    const context = new SwarmContext();
    const registry = makeStubRegistry();

    const manager = makeMockAgent('manager', 'Swarm Orchestrator', () =>
      JSON.stringify({
        ui_title: 'Recommended Single',
        summary: 'Backing Pelicans +12.5 with OKC missing Holmgren, Williams, Wallace, Sorber OUT.',
        picks: [
          {
            event_id: 'nba-401800202',
            row: 'R3',
            side: 'New Orleans Pelicans +12.5',
            reason: 'OKC missing Holmgren, Williams, Wallace, Sorber OUT.'
          }
        ],
        components: []
      })
    );

    // Critic stubbornly outputs "No picks to evaluate" on every call (including re-prompts)
    const stubbornCritic = makeMockAgent('critic', 'Verification Critic', () =>
      JSON.stringify({ pass: true, feedback: 'No picks to evaluate.' })
    );

    const { finalAnalysis, lifecycleResult } = await runDeepAnalysisVerification({
      task: 'Recommend Pelicans +12.5',
      rawInput: SLATE_TEXT,
      effectiveDynamicPrompt: 'Synthesize picks.',
      effectiveCompiledReports: 'Quant proposed Pelicans +12.5.',
      effectiveHistoricalContext: '',
      managerAgent: manager,
      analysts: [stubbornCritic],
      dedicatedCriticAgent: stubbornCritic,
      context,
      toolRegistry: registry,
      hadProposedPicks: true
    });

    expect(lifecycleResult.success).toBe(false);
    expect(lifecycleResult.criticAuditFailed).toBe(true);
    expect(finalAnalysis.picks).toEqual([]);
    expect(finalAnalysis.pass).toBe(true);
    expect(finalAnalysis.status).toBe('no_play');
    expect(JSON.stringify(finalAnalysis)).not.toMatch(/no picks to evaluate/i);
  });

  it('(7) non-deep-analysis Manager synthesis also forces a PASS when Stage 2 Critic did not audit proposed picks', async () => {
    const context = new SwarmContext();
    const manager = makeMockAgent('manager', 'Swarm Orchestrator', () =>
      JSON.stringify({
        ui_title: '2-Leg Parlay',
        summary: 'Pelicans +12.5 recommended.',
        picks: [
          { event_id: 'nba-401800202', row: 'R3', side: 'New Orleans Pelicans +12.5', reason: 'OKC injuries.' }
        ],
        components: []
      })
    );

    const result = await executeManagerSynthesis(
      manager,
      `Game Slate:\n${SLATE_TEXT}`,
      context,
      undefined,
      true,
      undefined,
      ['nba-401800202'],
      {
        rawBoard: SLATE_TEXT,
        criticAuditFailed: true,
        hadProposedPicks: true,
        auditNote: 'Stage 2 Risk Critic did not evaluate proposed picks.'
      }
    );

    expect(result.picks).toEqual([]);
    expect(result.pass).toBe(true);
    expect(result.status).toBe('no_play');

    // Also verify enforceCriticAuditOnFinalAnalysis strips a single unaudited leg while preserving an audited leg
    const partial = enforceCriticAuditOnFinalAnalysis(
      {
        summary: 'No picks to evaluate. Pelicans +12.5 is grounded.',
        picks: [
          { event_id: 'ncaaf-401800101', side: 'Lobos -7.5' },
          { event_id: 'nba-401800202', row: 'R3', side: 'Pelicans +12.5' }
        ]
      },
      {
        criticAuditFailed: false,
        hadProposedPicks: true,
        unauditedLegs: [{ eventId: 'ncaaf-401800101', teamLabel: 'New Mexico Lobos', teamAliases: ['lobos', 'new mexico'], reason: 'Not audited by Critic' }]
      }
    );
    expect(partial.picks).toHaveLength(1);
    expect(partial.picks[0].side).toBe('Pelicans +12.5');
    expect(partial.summary).not.toMatch(/no picks to evaluate/i);
  });
});
