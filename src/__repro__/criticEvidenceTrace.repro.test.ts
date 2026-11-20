import { describe, it, expect, vi } from 'vitest';
import type { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { CRITIC_VERDICT_SYSTEM_INSTRUCTION } from '../swarm/engine/constants.ts';
import { createAnalystExecutor } from '../swarm/engine/analystExecution.ts';
import { runDeepAnalysisVerification } from '../swarm/engine/verificationPipeline.ts';
import {
  CRITIC_EVIDENCE_RULE,
  isFalseHallucinationCritique,
  mergeScopedToolEvidence,
  resolveDiscussedGameIds
} from '../swarm/tools/criticEvidence.ts';
import { parseGameHeaders } from '../swarm/context/gameHeaders.ts';
import type { ToolEvidenceItem } from '../swarm/engine/seatToolLoop.ts';
import type { ToolCallTraceEntry } from '../swarm/tools/pullBeforePass.ts';

const SLATE_TEXT = [
  'event_id=nhl-401892751 | sport=icehockey_nhl | Colorado Avalanche @ Vegas Golden Knights | commence=2026-11-20T03:00:00Z | options: R1 Vegas Golden Knights ML (-145), R2 Colorado Avalanche ML (+125)',
  'event_id=nhl-401892743 | sport=icehockey_nhl | Ottawa Senators @ Tampa Bay Lightning | commence=2026-11-20T00:00:00Z | options: R3 Tampa Bay Lightning ML (-150), R4 Ottawa Senators ML (+130)',
  'event_id=nba-401910555 | sport=basketball_nba | Portland Trail Blazers @ Milwaukee Bucks | commence=2026-11-20T01:00:00Z | options: R5 Milwaukee Bucks -10.5 (-110), R6 Portland Trail Blazers +10.5 (-110)',
  'event_id=nba-401999999 | sport=basketball_nba | Orlando Magic @ Miami Heat | commence=2026-11-20T00:30:00Z | options: R7 Miami Heat ML (-135), R8 Orlando Magic ML (+115)'
].join('\n');

const COL_INJURY_SUMMARY =
  '[INJURY & ROSTER DELTA: nhl-401892751] Colorado Avalanche: Cale Makar (OUT), Nathan MacKinnon (OUT), Josh Manson (OUT). Vegas Golden Knights: None listed.';

const OTT_INJURY_SUMMARY =
  '[INJURY & ROSTER DELTA: nhl-401892743] Ottawa Senators: Andre Burakovsky (OUT), Warren Foegele (OUT), William Eklund (OUT), David Perron (OUT). Tampa Bay Lightning: None listed.';

const POR_INJURY_SUMMARY =
  '[INJURY & ROSTER DELTA: nba-401910555] Portland Trail Blazers: Ja Morant (OUT), Shaedon Sharpe (OUT), Robert Williams (OUT), Vit Krejci (OUT), Chris Youngblood (OUT). Milwaukee Bucks: None listed.';

const UNMENTIONED_INJURY_SUMMARY =
  '[INJURY & ROSTER DELTA: nba-401999999] Orlando Magic: Paolo Banchero (OUT). Miami Heat: None listed.';

const COL_MARKET_SUMMARY =
  '[MARKET MOVEMENT: nhl-401892751] Vegas Golden Knights vs Colorado Avalanche | ml_home: -145 | ml_away: +125 | spread: -1.5';

const OTT_MARKET_SUMMARY =
  '[MARKET MOVEMENT: nhl-401892743] Tampa Bay Lightning vs Ottawa Senators | ml_home: -150 | ml_away: +130 | spread: -1.5';

const POR_MARKET_SUMMARY =
  '[MARKET MOVEMENT: nba-401910555] Milwaukee Bucks vs Portland Trail Blazers | spread: +10.5 (Milwaukee Bucks -10.5 favored, Portland Trail Blazers +10.5 underdog) | ml_home: -480 | ml_away: +360';

function makeMockAgent(
  id: string,
  role: string,
  provider: string,
  handler: (prompt: string, config?: any) => Promise<string> | string
): Agent {
  let sysInstr = '';
  const mock: any = {
    id,
    name: role,
    role,
    provider,
    modelName: `${provider}-mock`,
    systemInstruction: '',
    setSystemInstruction: vi.fn((s: string) => {
      sysInstr = s;
      mock.systemInstruction = s;
    }),
    getSystemInstruction: () => sysInstr,
    run: vi.fn(async (prompt: string, _ctx?: any, config?: any) => handler(prompt, config))
  };
  return mock as Agent;
}

describe('Critic must see tool results that already ran', () => {
  it('embeds CRITIC_EVIDENCE_RULE verbatim into Critic system instructions', () => {
    expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).toContain(CRITIC_EVIDENCE_RULE);
    expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).toContain(
      'Use every successful tool result from this run for the games under review.'
    );
    expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).toContain(
      'Do not mark a claim hallucinated when the matching tool result is already present.'
    );
  });

  it('merges earlier successful run tool results with Critic pulls, trims secondary text first under tight Groq cap, and dismisses false hallucination veto for Colorado & Ottawa injuries', async () => {
    const prePassedItems: ToolEvidenceItem[] = [
      { tool: 'get_injury_and_roster_delta', eventId: 'nhl-401892751', summary: COL_INJURY_SUMMARY },
      { tool: 'get_injury_and_roster_delta', eventId: 'nhl-401892743', summary: OTT_INJURY_SUMMARY },
      { tool: 'get_injury_and_roster_delta', eventId: 'nba-401910555', summary: POR_INJURY_SUMMARY },
      { tool: 'get_injury_and_roster_delta', eventId: 'nba-401999999', summary: UNMENTIONED_INJURY_SUMMARY }
    ];

    const preTrace: ToolCallTraceEntry[] = prePassedItems.map(item => ({
      tool: item.tool,
      eventId: item.eventId,
      status: 'data',
      summary: item.summary
    }));

    // Registry ONLY exposes get_market_movement during Verification Critic pulls, simulating
    // earlier seats having already pulled get_injury_and_roster_delta.
    const marketPullSpy = vi.fn(async (params: any) => {
      const gId = params.game_id;
      if (gId === 'nhl-401892751') {
        return { success: true, summary: COL_MARKET_SUMMARY, data: { ml_home: -145, ml_away: 125 } };
      }
      if (gId === 'nhl-401892743') {
        return { success: true, summary: OTT_MARKET_SUMMARY, data: { ml_home: -150, ml_away: 130 } };
      }
      if (gId === 'nba-401910555') {
        return { success: true, summary: POR_MARKET_SUMMARY, data: { spread: 10.5, ml_home: -480, ml_away: 360 } };
      }
      return { success: false, error: 'unexpected unmentioned game pull' };
    });

    const registry = new ToolRegistry([
      {
        name: 'get_market_movement',
        description: 'Get market movement',
        parameters: { game_id: { type: 'string', description: 'Game ID', required: true } },
        execute: marketPullSpy
      }
    ]);

    const proposal = {
      summary:
        '3-leg parlay fading depleted rosters: Vegas ML with Colorado missing MacKinnon, Makar, and Manson OUT; Tampa Bay ML with Ottawa missing 4 forwards OUT (Burakovsky, Foegele, Eklund, Perron); and Milwaukee -10.5 with Portland missing Morant, Sharpe, Williams, Krejci, and Youngblood OUT.',
      picks: [
        {
          row: 'R1',
          event_id: 'nhl-401892751',
          pick: 'Vegas Golden Knights ML -145',
          reason: 'Colorado is missing Cale Makar (OUT), Nathan MacKinnon (OUT), and Josh Manson (OUT).'
        },
        {
          row: 'R3',
          event_id: 'nhl-401892743',
          pick: 'Tampa Bay Lightning ML -150',
          reason: 'Ottawa has 4 forwards OUT (Burakovsky, Foegele, Eklund, Perron).'
        },
        {
          row: 'R5',
          event_id: 'nba-401910555',
          pick: 'Milwaukee Bucks -10.5 (-110)',
          reason: 'Portland is missing Morant, Sharpe, Williams, Krejci, and Youngblood (all OUT).'
        }
      ]
    };

    let capturedVerifyPrompt = '';
    const proposer = makeMockAgent('proposer', 'Synthesis Compiler', 'groq', () => JSON.stringify(proposal));
    const critic = makeMockAgent('critic', 'Verification Critic', 'groq', (prompt) => {
      capturedVerifyPrompt = prompt;
      // Simulate the exact erroneous Critic response from the bug report
      return JSON.stringify({
        pass: false,
        feedback: 'Colorado (MacKinnon, Makar, Manson) and Ottawa (4 forwards) are not in the provided tool evidence. Hallucinated.'
      });
    });

    const context = new SwarmContext();
    const lifecycle = new AnalysisLifecycle(proposer, critic, 2, { toolRegistry: registry });

    // Large bulky analystReports & historicalBaselines to pressure Groq's 5600-char prompt budget
    const bulkySecondary = 'Secondary commentary filler '.repeat(180);
    const result = await lifecycle.executeAndVerify(
      {
        fullBoard: SLATE_TEXT,
        rawBoard: SLATE_TEXT,
        toolEvidenceItems: prePassedItems,
        toolCallTrace: preTrace,
        analystReports: [{ agent: 'A1', summary: bulkySecondary }],
        historicalBaselines: bulkySecondary
      },
      context,
      'Build a 3-leg parlay.',
      'Verify the proposal against tool evidence.'
    );

    // 1. Critic prompt stayed within Groq cap (5600) while keeping ALL discussed games' earlier injury results + Critic market pulls intact
    expect(capturedVerifyPrompt.length).toBeLessThanOrEqual(5600);
    expect(capturedVerifyPrompt).toContain('nhl-401892751');
    expect(capturedVerifyPrompt).toContain('MacKinnon');
    expect(capturedVerifyPrompt).toContain('Makar');
    expect(capturedVerifyPrompt).toContain('Manson');
    expect(capturedVerifyPrompt).toContain('nhl-401892743');
    expect(capturedVerifyPrompt).toContain('Burakovsky');
    expect(capturedVerifyPrompt).toContain('Foegele');
    expect(capturedVerifyPrompt).toContain('Eklund');
    expect(capturedVerifyPrompt).toContain('nba-401910555');
    expect(capturedVerifyPrompt).toContain('Morant');
    expect(capturedVerifyPrompt).toContain('ml_home');
    // Unmentioned slate game must stay excluded from Critic scope
    expect(capturedVerifyPrompt).not.toContain('nba-401999999');
    expect(capturedVerifyPrompt).not.toContain('Banchero');

    // 2. False hallucination veto was dismissed cleanly on Attempt 1
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.finalProposal.picks).toHaveLength(3);
  });

  it('scopes discussed games via team city/nickname/players in summary without pulling unmentioned slate games', () => {
    const headers = parseGameHeaders(SLATE_TEXT);
    const proposal = {
      summary: 'Colorado missing MacKinnon/Makar and Ottawa missing Burakovsky/Foegele/Eklund.',
      picks: [{ row: 'R1', event_id: 'nhl-401892751', pick: 'Vegas Golden Knights ML -145' }]
    };

    const discussed = resolveDiscussedGameIds(
      proposal,
      headers,
      `${COL_INJURY_SUMMARY}\n\n${OTT_INJURY_SUMMARY}\n\n${UNMENTIONED_INJURY_SUMMARY}`
    );

    expect(discussed).toContain('nhl-401892751');
    expect(discussed).toContain('nhl-401892743');
    expect(discussed).not.toContain('nba-401999999');

    const { mergedEvidenceText } = mergeScopedToolEvidence({
      prePassedItems: [
        { tool: 'get_injury_and_roster_delta', eventId: 'nhl-401892751', summary: COL_INJURY_SUMMARY },
        { tool: 'get_injury_and_roster_delta', eventId: 'nhl-401892743', summary: OTT_INJURY_SUMMARY },
        { tool: 'get_injury_and_roster_delta', eventId: 'nba-401999999', summary: UNMENTIONED_INJURY_SUMMARY }
      ],
      pulledItems: [
        { tool: 'get_market_movement', eventId: 'nhl-401892751', summary: COL_MARKET_SUMMARY }
      ],
      selectedGameIds: discussed,
      slateSource: SLATE_TEXT
    });

    expect(mergedEvidenceText).toContain('MacKinnon');
    expect(mergedEvidenceText).toContain('Burakovsky');
    expect(mergedEvidenceText).toContain('ml_home');
    expect(mergedEvidenceText).not.toContain('nba-401999999');
  });

  it('still rejects genuinely hallucinated claims and missing tool calls (fail-closed)', async () => {
    const headers = parseGameHeaders(SLATE_TEXT);
    const traceWithOnlyColorado: ToolCallTraceEntry[] = [
      { tool: 'get_injury_and_roster_delta', eventId: 'nhl-401892751', status: 'data', summary: COL_INJURY_SUMMARY }
    ];

    // Case 1: Fabricated player not in tool evidence -> MUST NOT dismiss
    expect(
      isFalseHallucinationCritique(
        'Colorado (FakePlayer OUT) is not in the provided tool evidence. Hallucinated.',
        {},
        COL_INJURY_SUMMARY,
        { headers, toolCallTrace: traceWithOnlyColorado, slateText: SLATE_TEXT }
      )
    ).toBe(false);

    // Case 2: No successful injury tool call for Ottawa -> MUST NOT dismiss
    expect(
      isFalseHallucinationCritique(
        'Colorado (MacKinnon, Makar, Manson) and Ottawa (4 forwards) are not in the provided tool evidence. Hallucinated.',
        {},
        COL_INJURY_SUMMARY,
        { headers, toolCallTrace: traceWithOnlyColorado, slateText: SLATE_TEXT }
      )
    ).toBe(false);

    // Case 3: Genuine fatal-injury veto (not a hallucination claim) -> MUST NOT dismiss
    expect(
      isFalseHallucinationCritique(
        'Fatal injury: MacKinnon is OUT for Colorado, so Colorado ML must be removed.',
        {},
        `${COL_INJURY_SUMMARY}\n${OTT_INJURY_SUMMARY}`,
        {
          headers,
          toolCallTrace: [
            ...traceWithOnlyColorado,
            { tool: 'get_injury_and_roster_delta', eventId: 'nhl-401892743', status: 'data', summary: OTT_INJURY_SUMMARY }
          ],
          slateText: SLATE_TEXT
        }
      )
    ).toBe(false);

    // Case 4: Lifecycle keeps rejection when claim truly lacks trace evidence
    const proposer = makeMockAgent('proposer', 'Synthesis Compiler', 'gemini', () =>
      JSON.stringify({
        summary: 'Colorado missing FakePlayer OUT.',
        picks: [{ row: 'R1', event_id: 'nhl-401892751', pick: 'Vegas Golden Knights ML -145', reason: 'FakePlayer OUT.' }]
      })
    );
    const critic = makeMockAgent('critic', 'Verification Critic', 'gemini', () =>
      JSON.stringify({
        pass: false,
        feedback: 'Colorado (FakePlayer OUT) is not in the provided tool evidence. Hallucinated.'
      })
    );
    const lifecycle = new AnalysisLifecycle(proposer, critic, 1);
    const res = await lifecycle.executeAndVerify(
      {
        fullBoard: SLATE_TEXT,
        toolEvidenceItems: [{ tool: 'get_injury_and_roster_delta', eventId: 'nhl-401892751', summary: COL_INJURY_SUMMARY }],
        toolCallTrace: traceWithOnlyColorado
      },
      new SwarmContext(),
      'Analyze Colorado @ Vegas.',
      'Verify the proposal.'
    );
    expect(res.success).toBe(false);
    expect(res.criticFeedback).toContain('FakePlayer');
  });

  it('preserves clean pass behavior when all legs are skipped / pass is recommended', async () => {
    const proposer = makeMockAgent('proposer', 'Synthesis Compiler', 'gemini', () =>
      JSON.stringify({
        ui_title: 'Pass — No Qualified Edge',
        summary: 'After pulling injury and market tools for Colorado @ Vegas, there is no actionable edge. Pass.',
        picks: []
      })
    );
    const critic = makeMockAgent('critic', 'Verification Critic', 'gemini', () =>
      JSON.stringify({
        pass: true,
        feedback: 'Clean pass verified after tool pulls.'
      })
    );
    const lifecycle = new AnalysisLifecycle(proposer, critic, 1);
    const res = await lifecycle.executeAndVerify(
      {
        fullBoard: SLATE_TEXT,
        toolEvidenceItems: [
          { tool: 'get_injury_and_roster_delta', eventId: 'nhl-401892751', summary: COL_INJURY_SUMMARY },
          { tool: 'get_market_movement', eventId: 'nhl-401892751', summary: COL_MARKET_SUMMARY }
        ],
        toolCallTrace: [
          { tool: 'get_injury_and_roster_delta', eventId: 'nhl-401892751', status: 'data', summary: COL_INJURY_SUMMARY },
          { tool: 'get_market_movement', eventId: 'nhl-401892751', status: 'data', summary: COL_MARKET_SUMMARY }
        ]
      },
      new SwarmContext(),
      'Find best bet or pass.',
      'Verify.'
    );
    expect(res.success).toBe(true);
    expect(res.finalProposal.picks).toEqual([]);
  });

  it('gives Stage 2 Risk Critic visibility into earlier seats tool results and dismisses false hallucination vetoes', async () => {
    const seenPrompts: string[] = [];
    const criticAgent = makeMockAgent('critic', 'Risk Critic', 'groq', (prompt) => {
      seenPrompts.push(prompt);
      if (seenPrompts.length === 1) {
        // Round 1: Critic emits no tool calls so seatToolLoop prefetches & runs Round 2 with merged prior evidence
        return 'Reviewing picks...';
      }
      return JSON.stringify({
        pass: false,
        verdict: 'Colorado (MacKinnon, Makar, Manson) and Ottawa (4 forwards) are not in the provided tool evidence. Hallucinated.',
        flags: ['hallucinated_injuries']
      });
    });

    const registry = new ToolRegistry([
      {
        name: 'get_market_movement',
        description: 'Get market movement',
        parameters: { game_id: { type: 'string', description: 'Game ID', required: true } },
        execute: async (params: any) => ({
          success: true,
          summary: params.game_id === 'nhl-401892751' ? COL_MARKET_SUMMARY : OTT_MARKET_SUMMARY,
          data: params.game_id === 'nhl-401892751' ? { ml_home: -145, ml_away: 125 } : { ml_home: -150, ml_away: 130 }
        })
      }
    ]);

    const executor = createAnalystExecutor({
      task: 'Build a parlay factoring Colorado and Ottawa injuries.',
      chunks: [SLATE_TEXT],
      profile: { domain: 'Sports' },
      historicalContext: '',
      targetAppId: 'test',
      context: new SwarmContext(),
      toolRegistry: registry,
      analystClusterMap: new Map(),
      bypassCache: true
    });

    const proposerReport = {
      seat: 'A1',
      role: 'Quant Analyst',
      summary: 'Backing Vegas ML (R1) with Colorado missing MacKinnon/Makar/Manson OUT and Tampa Bay ML (R3) with Ottawa missing 4 forwards OUT.',
      picks: [
        { row: 'R1', event_id: 'nhl-401892751', pick: 'Vegas Golden Knights ML -145', reason: 'Makar, MacKinnon, Manson OUT for Colorado.' },
        { row: 'R3', event_id: 'nhl-401892743', pick: 'Tampa Bay Lightning ML -150', reason: 'Ottawa missing Burakovsky, Foegele, Eklund, Perron OUT.' }
      ],
      toolEvidenceItems: [
        { tool: 'get_injury_and_roster_delta', eventId: 'nhl-401892751', summary: COL_INJURY_SUMMARY },
        { tool: 'get_injury_and_roster_delta', eventId: 'nhl-401892743', summary: OTT_INJURY_SUMMARY }
      ],
      toolCallTrace: [
        { tool: 'get_injury_and_roster_delta', eventId: 'nhl-401892751', status: 'data', summary: COL_INJURY_SUMMARY },
        { tool: 'get_injury_and_roster_delta', eventId: 'nhl-401892743', status: 'data', summary: OTT_INJURY_SUMMARY }
      ]
    };

    const criticReport = await executor(criticAgent, SLATE_TEXT, 0, {
      summaryText: proposerReport.summary,
      targetGameIds: ['nhl-401892751', 'nhl-401892743'],
      proposerReports: [proposerReport]
    });

    // Round 2 Critic prompt must include earlier seats' injury results merged with Critic's own market pulls
    const round2Prompt = seenPrompts[seenPrompts.length - 1];
    expect(round2Prompt).toContain('MacKinnon');
    expect(round2Prompt).toContain('Burakovsky');
    expect(round2Prompt).toContain('ml_home');

    // Stage 2 Critic dismissed the false hallucination veto
    expect((criticReport as any).pass).toBe(true);
    expect((criticReport as any).flags).toEqual([]);
  });

  it('verifies a full runDeepAnalysisVerification parlay citing Colorado & Ottawa injuries without false hallucination veto', async () => {
    const registry = new ToolRegistry([
      {
        name: 'get_market_movement',
        description: 'Get market odds',
        parameters: { game_id: { type: 'string', description: 'Game ID', required: true } },
        execute: async (params: any) => {
          if (params.game_id === 'nhl-401892751') return { success: true, summary: COL_MARKET_SUMMARY, data: { ml_home: -145, ml_away: 125 } };
          if (params.game_id === 'nhl-401892743') return { success: true, summary: OTT_MARKET_SUMMARY, data: { ml_home: -150, ml_away: 130 } };
          return { success: true, summary: POR_MARKET_SUMMARY, data: { spread: 10.5, ml_home: -480, ml_away: 360 } };
        }
      }
    ]);

    const synthesizer = makeMockAgent('synth', 'Synthesis Compiler', 'gemini', () =>
      JSON.stringify({
        ui_title: '2-Leg NHL Parlay',
        summary: 'Backing Vegas ML (R1) with Colorado missing MacKinnon, Makar, and Manson OUT, paired with Tampa Bay ML (R3) with Ottawa missing 4 forwards OUT (Burakovsky, Foegele, Eklund, Perron).',
        picks: [
          { row: 'R1', event_id: 'nhl-401892751', pick: 'Vegas Golden Knights ML -145', reason: 'Colorado missing MacKinnon, Makar, and Manson (OUT).' },
          { row: 'R3', event_id: 'nhl-401892743', pick: 'Tampa Bay Lightning ML -150', reason: 'Ottawa missing 4 forwards OUT (Burakovsky, Foegele, Eklund, Perron).' }
        ]
      })
    );

    let verifyCriticPrompt = '';
    const verifyCritic = makeMockAgent('verify-critic', 'Verification Critic', 'groq', (prompt) => {
      verifyCriticPrompt = prompt;
      return JSON.stringify({
        pass: false,
        feedback: 'Colorado (MacKinnon, Makar, Manson) and Ottawa (4 forwards) are not in the provided tool evidence. Hallucinated.'
      });
    });

    const priorEvidenceItems: ToolEvidenceItem[] = [
      { tool: 'get_injury_and_roster_delta', eventId: 'nhl-401892751', summary: COL_INJURY_SUMMARY },
      { tool: 'get_injury_and_roster_delta', eventId: 'nhl-401892743', summary: OTT_INJURY_SUMMARY }
    ];
    const priorTrace: ToolCallTraceEntry[] = priorEvidenceItems.map(i => ({
      tool: i.tool,
      eventId: i.eventId,
      status: 'data',
      summary: i.summary
    }));

    const result = await runDeepAnalysisVerification({
      task: 'Build a 2-leg NHL parlay citing Colorado and Ottawa injuries.',
      rawInput: SLATE_TEXT,
      effectiveDynamicPrompt: 'Compile 2-leg NHL parlay.',
      effectiveCompiledReports: 'A1 picked Vegas ML (R1) and Tampa Bay ML (R3).',
      effectiveHistoricalContext: '',
      managerAgent: synthesizer,
      analysts: [],
      dedicatedCriticAgent: verifyCritic,
      context: new SwarmContext(),
      toolRegistry: registry,
      toolEvidenceItems: priorEvidenceItems,
      toolCallTrace: priorTrace,
      coveredEventIds: ['nhl-401892751', 'nhl-401892743'],
      settings: { maxRetries: 2 } as any
    });

    expect((verifyCritic as any).systemInstruction).toContain(CRITIC_EVIDENCE_RULE);
    expect(verifyCriticPrompt.length).toBeLessThanOrEqual(5600);
    expect(verifyCriticPrompt).toContain('MacKinnon');
    expect(verifyCriticPrompt).toContain('Makar');
    expect(verifyCriticPrompt).toContain('Burakovsky');
    expect(verifyCriticPrompt).toContain('ml_home');
    expect(result.lifecycleResult.success).toBe(true);
    expect(result.lifecycleResult.attempts).toBe(1);
    expect(result.lifecycleResult.finalProposal?.picks?.length).toBe(2);
  });
});
