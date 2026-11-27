import { describe, expect, it, vi, afterEach } from 'vitest';
import { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import { MANAGER_SYSTEM_INSTRUCTION } from '../swarm/engine/constants.ts';
import { partitionTaskAndContract, sanitizePickOutputContractPlaceholders } from '../swarm/engine/analystExecution.ts';
import { compileSynthesisPrompt } from '../swarm/engine/synthesisPipeline.ts';
import { runDeepAnalysisVerification } from '../swarm/engine/verificationPipeline.ts';
import { parseGameHeaders } from '../swarm/context/gameHeaders.ts';
import { extractVetoedLegTargets } from '../swarm/tools/claimGrounding.ts';
import { auditProposerRowLock, extractRowOptions, formatAllowedProposerRowsDirective } from '../swarm/tools/marketRowBinding.ts';
import { GroqAdapter, resolveGroqGptOss120bReasoningEffort } from '../swarm/providers/groq.ts';

const SLATE_TEXT = [
  'event_id=nba-4019901 | sport=nba | Miami Heat @ Boston Celtics | options: R95 Boston Celtics -5.5 (-110) | R96 Miami Heat +5.5 (-110)',
  'event_id=nba-4019902 | sport=nba | Phoenix Suns @ Denver Nuggets | options: R90 Denver Nuggets ML (-125) | R91 Phoenix Suns ML (+105)',
  'event_id=nhl-4018999 | sport=nhl | Minnesota Wild @ Dallas Stars | options: R94 Dallas Stars ML (-130) | R93 Minnesota Wild ML (+110)',
  'event_id=nba-4019903 | sport=nba | Chicago Bulls @ Milwaukee Bucks | options: R18 Milwaukee Bucks -4.5 (-110) | R7 Chicago Bulls +4.5 (-110)',
  'event_id=ncaaf-4018505 | sport=ncaaf | Baylor Bears @ TCU Horned Frogs | options: R5 TCU Horned Frogs -7.5 (-110)',
  'event_id=mlb-4017701 | sport=mlb | Baltimore Orioles @ New York Yankees | options: R58 New York Yankees ML (-140)',
].join('\n');

const EVIDENCE_TEXT = [
  'EVENT nba-4019901 (Miami Heat @ Boston Celtics)',
  'Boston Celtics (nba-4019901) spread -5.5 | ml_home: -220, ml_away: 185 | L5 4-1, avgPts: 118.4, avgPtsAgainst: 109.2',
  'Steam: TOWARD Boston Celtics -5.5',
  'Health Balance: balanced',
  '',
  'EVENT nba-4019902 (Phoenix Suns @ Denver Nuggets)',
  'Denver Nuggets (nba-4019902) ml_home: -125, ml_away: 105 | L5 4-1, avgPts: 116.0, avgPtsAgainst: 110.5',
  'Phoenix Suns (nba-4019902) L5 1-4',
  'Steam: TOWARD Denver Nuggets ML',
  'Health Balance: balanced',
].join('\n');

const SIX_PROPOSER_PICKS = [
  { row: 'R95', event_id: 'nba-4019901', side: 'Boston Celtics -5.5', market: 'spread', line: -5.5, odds: -110, confidence: 0.78, reason: 'Boston Celtics L5 4-1 with steam toward -5.5.', reasonSource: 'matchup_fundamentals' },
  { row: 'R90', event_id: 'nba-4019902', side: 'Denver Nuggets ML', market: 'moneyline', odds: -125, confidence: 0.74, reason: 'Denver Nuggets L5 4-1 vs Suns 1-4.', reasonSource: 'market_movement' },
  { row: 'R94', event_id: 'nhl-4018999', side: 'Dallas Stars ML', market: 'moneyline', odds: -130, confidence: 0.72, reason: 'Dallas Stars ML price edge.', reasonSource: 'R94' },
  { row: 'R18', event_id: 'nba-4019903', side: 'Milwaukee Bucks -4.5', market: 'spread', line: -4.5, odds: -110, confidence: 0.71, reason: 'Bucks spread edge.', reasonSource: 'R18' },
  { row: 'R5', event_id: 'ncaaf-4018505', side: 'TCU Horned Frogs -7.5', market: 'spread', line: -7.5, odds: -110, confidence: 0.70, reason: 'TCU spread edge.', reasonSource: 'R5' },
  { row: 'R58', event_id: 'mlb-4017701', side: 'New York Yankees ML', market: 'moneyline', odds: -140, confidence: 0.69, reason: 'Yankees ML edge.', reasonSource: 'R58' },
];

describe('wf-1795804428974 Manager / Verifier fixes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('replaces literal "row": "R7" (and "R#") with "row": "<row_id>" in prompt contracts and MANAGER_SYSTEM_INSTRUCTION', () => {
    expect(MANAGER_SYSTEM_INSTRUCTION).toContain('"row": "<row_id>"');
    expect(MANAGER_SYSTEM_INSTRUCTION).not.toMatch(/"row"\s*:\s*"R(?:#|7)"/);

    const externalTask = `Find best bets tonight.\nPICK OUTPUT CONTRACT:\nEach pick is exactly { "row": "R7", "side": "...", "confidence": 0.75, "reasonSource": "..." }.`;
    const partitioned = partitionTaskAndContract(externalTask);
    expect(partitioned.contractBlock).toContain('"row": "<row_id>"');
    expect(partitioned.contractBlock).not.toMatch(/"row"\s*:\s*"R7"/i);

    const sanitizedDirect = sanitizePickOutputContractPlaceholders(externalTask);
    expect(sanitizedDirect).toContain('"row": "<row_id>"');
    expect(sanitizedDirect).not.toMatch(/"row"\s*:\s*"R7"/i);
  });

  it('injects explicit ALLOWED_PROPOSER_ROWS list with team/side labels directly into Manager prompt', () => {
    const manager = new Agent('GodView Compiler', 'openai/gpt-oss-120b', 'groq', 'mock-key', undefined, [], undefined, 'manager');
    const quant = new Agent('Quant Proposer', 'nvidia-model', 'nvidia', 'mock-key', undefined, [], undefined, 'a1');
    const market = new Agent('Market Proposer', 'or-model', 'openrouter', 'mock-key', undefined, [], undefined, 'a2');
    const ctx = new SwarmContext();

    const directive = formatAllowedProposerRowsDirective({
      specialistPicks: SIX_PROPOSER_PICKS,
      boardSource: SLATE_TEXT,
    });
    expect(directive).toContain('ALLOWED_PROPOSER_ROWS: [R95, R90, R94, R18, R5, R58]');
    expect(directive).toContain('R95 (Boston Celtics -5.5)');
    expect(directive).toContain('R90 (Denver Nuggets ML)');

    const compiled = compileSynthesisPrompt({
      task: 'PICK OUTPUT CONTRACT:\nEach pick is { "row": "R7", "side": "..." }',
      rawInput: SLATE_TEXT,
      analysts: [quant, market],
      managerAgent: manager,
      allAnalystReports: [
        [{ seat: 'a1', summary: 'Quant proposes R95, R90, R94.', picks: SIX_PROPOSER_PICKS.slice(0, 3) }],
        [{ seat: 'a2', summary: 'Market proposes R18, R5, R58.', picks: SIX_PROPOSER_PICKS.slice(3) }],
      ],
      clusterDigests: {},
      historicalContext: '',
      context: ctx,
      params: { originApp: 'duelodds' } as any,
      bypassCache: true,
    });

    expect(compiled.effectiveDynamicPrompt).toContain('ALLOWED_PROPOSER_ROWS: [R95, R90, R94, R18, R5, R58]');
    expect(compiled.effectiveDynamicPrompt).toContain('R95 (Boston Celtics -5.5)');
    expect(compiled.effectiveDynamicPrompt).toContain('"row": "<row_id>"');
    expect(compiled.effectiveDynamicPrompt).not.toMatch(/"row"\s*:\s*"R7"/i);
  });

  it('PROPOSER ROW LOCK feedback includes exact allowed rows, is not classified as Risk Critic veto, and does not trigger a criticApproved: false pass when unvetoed rows exist', async () => {
    const audit = auditProposerRowLock(
      { picks: [{ row: 'R7', event_id: 'nba-4019903', side: 'Chicago Bulls +4.5', reasonSource: 'matchup_fundamentals' }] },
      { specialistPicks: SIX_PROPOSER_PICKS, boardSource: SLATE_TEXT }
    );
    expect(audit.pass).toBe(false);
    expect(audit.feedback).toBe(
      'Correction (PROPOSER ROW LOCK): Pick R7 is not in ALLOWED_PROPOSER_ROWS ([R95, R90, R94, R18, R5, R58]). Do NOT pass or set criticApproved=false when valid unvetoed rows exist; re-select your picks strictly from ALLOWED_PROPOSER_ROWS.'
    );

    // Must never poison allowed rows as vetoed legs
    const headers = parseGameHeaders(SLATE_TEXT);
    const rowMap = extractRowOptions([SLATE_TEXT], headers);
    const extracted = extractVetoedLegTargets([audit.feedback!], headers, rowMap);
    expect(extracted).toEqual([]);

    // Scenario 1: Attempt 1 emits R7 -> Correction (PROPOSER ROW LOCK) retry -> Attempt 2 picks [R95, R90] -> clean criticApproved: true pass
    const manager1 = new Agent('GodView Compiler', 'manager', 'simulated', 'mock-key');
    const critic1 = new Agent('Verification Critic', 'verifier', 'simulated', 'mock-key');
    const promptsSeen: string[] = [];

    vi.spyOn(critic1, 'run').mockResolvedValue(JSON.stringify({ pass: true, feedback: 'Looks fine.' }));
    vi.spyOn(manager1, 'run')
      .mockImplementationOnce(async (prompt: string) => {
        promptsSeen.push(prompt);
        return JSON.stringify({
          summary: 'Backing Chicago Bulls +4.5 (R7).',
          picks: [{ row: 'R7', event_id: 'nba-4019903', side: 'Chicago Bulls +4.5', market: 'spread', line: 4.5, confidence: 0.72, reason: 'Bulls home dog.', reasonSource: 'matchup_fundamentals' }],
          scorecards: [],
          components: [],
          wageringPass: false,
          criticApproved: true,
        });
      })
      .mockImplementationOnce(async (prompt: string) => {
        promptsSeen.push(prompt);
        return JSON.stringify({
          summary: 'Backing Boston Celtics -5.5 (R95) and Denver Nuggets ML (R90).',
          picks: SIX_PROPOSER_PICKS.slice(0, 2),
          scorecards: [{ seat: 'Risk Critic', verdict: 'approve', notes: 'Approved' }],
          components: [],
          wageringPass: false,
          criticApproved: true,
        });
      });

    const twoLegRes = await runDeepAnalysisVerification({
      task: 'Construct optimal picks from ALLOWED_PROPOSER_ROWS.',
      rawInput: SLATE_TEXT,
      effectiveDynamicPrompt: `Game Slate:\n${SLATE_TEXT}`,
      effectiveCompiledReports: '[Quant Proposer] R95 | [Market Proposer] R90',
      effectiveHistoricalContext: '',
      managerAgent: manager1,
      analysts: [],
      dedicatedCriticAgent: critic1,
      context: new SwarmContext(),
      coveredEventIds: ['nba-4019901', 'nba-4019902'],
      toolResults: EVIDENCE_TEXT,
      specialistPicks: SIX_PROPOSER_PICKS.slice(0, 2),
      hadProposedPicks: true,
      criticVerdictApproved: true,
    });

    expect(promptsSeen[0]).toContain('ALLOWED_PROPOSER_ROWS: [R95, R90] — R95 (Boston Celtics -5.5); R90 (Denver Nuggets ML)');
    expect(promptsSeen[1]).toContain(
      'Correction (PROPOSER ROW LOCK): Pick R7 is not in ALLOWED_PROPOSER_ROWS ([R95, R90]). Do NOT pass or set criticApproved=false when valid unvetoed rows exist; re-select your picks strictly from ALLOWED_PROPOSER_ROWS.'
    );
    expect(promptsSeen[1]).not.toContain('[VETOED LEGS & CLAIMS');
    expect(twoLegRes.lifecycleResult.accumulatedVetoes).toBeUndefined();
    expect(twoLegRes.lifecycleResult.vetoedLegs).toBeUndefined();
    expect(twoLegRes.finalAnalysis.verified).toBe(true);
    expect(twoLegRes.finalAnalysis.criticApproved).toBe(true);
    expect(twoLegRes.finalAnalysis.wageringPass).toBe(false);
    expect(twoLegRes.finalAnalysis.picks.map((p: any) => p.row)).toEqual(['R95', 'R90']);

    // Scenario 2: Attempt 1 emits R7 and Attempt 2 panic-passes { picks: [], wageringPass: true, criticApproved: false }
    // Verifier MUST NOT accept a criticApproved: false pass when valid unvetoed proposer rows exist and Critic approved the pool.
    const manager2 = new Agent('GodView Compiler', 'manager', 'simulated', 'mock-key');
    const critic2 = new Agent('Verification Critic', 'verifier', 'simulated', 'mock-key');
    vi.spyOn(critic2, 'run').mockResolvedValue(JSON.stringify({ pass: true, feedback: 'Valid.' }));
    vi.spyOn(manager2, 'run')
      .mockResolvedValueOnce(
        JSON.stringify({
          summary: 'Backing R7.',
          picks: [{ row: 'R7', event_id: 'nba-4019903', side: 'Chicago Bulls +4.5', market: 'spread', line: 4.5, confidence: 0.72, reason: 'Bulls home dog.', reasonSource: 'matchup_fundamentals' }],
          scorecards: [],
          components: [],
          wageringPass: false,
          criticApproved: true,
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          summary: 'Bottom-line call: pass; no playable wagers.',
          picks: [],
          scorecards: [{ seat: 'Risk Critic', verdict: 'veto', notes: 'Vetoed.' }],
          components: [],
          wageringPass: true,
          criticApproved: false,
        })
      );

    const panicGuardRes = await runDeepAnalysisVerification({
      task: 'Construct optimal picks from ALLOWED_PROPOSER_ROWS.',
      rawInput: SLATE_TEXT,
      effectiveDynamicPrompt: `Game Slate:\n${SLATE_TEXT}`,
      effectiveCompiledReports: '[Quant Proposer] R95 | [Market Proposer] R90',
      effectiveHistoricalContext: '',
      managerAgent: manager2,
      analysts: [],
      dedicatedCriticAgent: critic2,
      context: new SwarmContext(),
      coveredEventIds: ['nba-4019901', 'nba-4019902'],
      toolResults: EVIDENCE_TEXT,
      specialistPicks: SIX_PROPOSER_PICKS.slice(0, 2),
      hadProposedPicks: true,
      criticVerdictApproved: true,
    });

    expect(panicGuardRes.finalAnalysis.criticApproved).toBe(true);
    expect(panicGuardRes.finalAnalysis.wageringPass).toBe(false);
    expect(panicGuardRes.finalAnalysis.picks.map((p: any) => p.row)).toEqual(['R95', 'R90']);
  });

  it('caps Groq openai/gpt-oss-120b reasoning_effort to "low" on the manager seat when unset or "high"', async () => {
    expect(resolveGroqGptOss120bReasoningEffort({ role: 'GodView Compiler', agentId: 'manager', config: {} })).toBe('low');
    expect(resolveGroqGptOss120bReasoningEffort({ role: 'GodView Compiler', agentId: 'manager', config: { reasoning_effort: 'high' } })).toBe('low');
    expect(resolveGroqGptOss120bReasoningEffort({ role: 'GodView Compiler', agentId: 'manager', config: { reasoning: { effort: 'high' } } })).toBe('low');
    expect(resolveGroqGptOss120bReasoningEffort({ role: 'GodView Compiler', agentId: 'manager', config: { reasoning_effort: 'medium' } })).toBe('medium');
    // Non-manager seats can keep explicit 'high'
    expect(resolveGroqGptOss120bReasoningEffort({ role: 'Quant Proposer', agentId: 'a1', config: { reasoning_effort: 'high' } })).toBe('high');

    const capturedBodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: any) => {
      capturedBodies.push(JSON.parse(String(init?.body || '{}')));
      return {
        ok: true,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ summary: 'ok', picks: [], scorecards: [], components: [], wageringPass: true, criticApproved: true }) } }],
          usage: { total_tokens: 100 },
        }),
      } as any;
    }));

    const adapter = new GroqAdapter();
    await adapter.call({
      modelName: 'openai/gpt-oss-120b',
      prompt: 'Compile board.',
      apiKey: 'test-key',
      role: 'GodView Compiler',
      agentId: 'manager',
      config: { groqMode: 'chat', reasoning_effort: 'high', responseMimeType: 'application/json' },
    });
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].reasoning_effort).toBe('low');

    // Also verify Agent.run forwards agentId='manager' and caps unset/'high' to 'low'
    const managerAgent = new Agent('GodView Compiler', 'openai/gpt-oss-120b', 'groq', 'test-key', undefined, [], undefined, 'manager');
    await managerAgent.run('Compile board', new SwarmContext(), {
      groqMode: 'chat',
      reasoning: { effort: 'high' },
      responseMimeType: 'application/json',
      disableFallback: true,
      bypassCache: true,
    });
    expect(capturedBodies).toHaveLength(2);
    expect(capturedBodies[1].reasoning_effort).toBe('low');
  });
});
