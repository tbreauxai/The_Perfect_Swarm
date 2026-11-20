import { describe, it, expect, beforeEach } from 'vitest';
import { executeSwarmWorkflow } from './index.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import { seatBudget } from '../context/promptBudget.ts';

describe('Lean Context & Prompt Bounds Contract (PS2)', () => {
  const recordedPrompts: { role: string; prompt: string }[] = [];
  let proposerCalls = 0;

  beforeEach(() => {
    recordedPrompts.length = 0;
    proposerCalls = 0;

    ProviderRegistry.register({
      providerName: 'mock-groq-seat',
      async call(options: any) {
        recordedPrompts.push({
          role: options.role || 'analyst',
          prompt: options.prompt
        });
        return JSON.stringify({
          insights: ['Key matchup advantage on away side'],
          anomalies: [],
          summary: 'Analysis completed with solid edge'
        });
      }
    } as any);

    ProviderRegistry.register({
      providerName: 'mock-groq-manager',
      async call(options: any) {
        proposerCalls++;
        recordedPrompts.push({
          role: 'Manager Node',
          prompt: options.prompt
        });
        return JSON.stringify({
          ui_title: 'Lean Slate Parlay',
          summary: 'Synthesized parlay legs',
          components: []
        });
      }
    } as any);
  });

  const tenGameSlate = Array.from({ length: 10 }, (_, i) => {
    const id = `game-${String(i + 1).padStart(3, '0')}`;
    const rStart = i * 4 + 1;
    return `event_id=${id} | sport=nba | AwayTeam${i + 1} @ HomeTeam${i + 1} | commence=2026-11-15T00:00:00Z | options: R${rStart} AwayTeam${i + 1} +3.5 (-110), R${rStart + 1} HomeTeam${i + 1} -3.5 (-110)`;
  }).join('\n');

  it('seat prompts are <= 5600 chars and proposer is <= budget on a 10-game slate with no raw board leaks', async () => {
    const result = await executeSwarmWorkflow({
      task: 'Analyze today\'s slate and build the best parlay',
      data: tenGameSlate,
      callerAppId: 'duelodds',
      forceFullSwarm: true,
      bypassCache: true,
      enableDeepAnalysis: false,
      settings: {
        appId: 'duelodds',
        agents: [
          { id: 'manager', role: 'Manager Node', provider: 'mock-groq-manager', model: 'mock-m', apiKey: 'k' },
          { id: 'quant', role: 'Quant Specialist', provider: 'mock-groq-seat', model: 'mock-m', apiKey: 'k' },
          { id: 'market', role: 'Market Specialist', provider: 'mock-groq-seat', model: 'mock-m', apiKey: 'k' },
          { id: 'risk', role: 'Risk Analyst', provider: 'mock-groq-seat', model: 'mock-m', apiKey: 'k' }
        ]
      }
    });

    expect(result.finalAnalysis).toBeDefined();
    expect(proposerCalls).toBe(1);

    // Assert seat prompts are <= 5600 chars (Groq budget)
    const analystPrompts = recordedPrompts.filter(p => p.role !== 'Manager Node');
    expect(analystPrompts.length).toBeGreaterThanOrEqual(3);
    for (const ap of analystPrompts) {
      expect(ap.prompt.length).toBeLessThanOrEqual(5600);
      expect(ap.prompt).not.toContain('id|game|market');
      expect(ap.prompt).not.toContain('RAW ACTIONABLE BETS');
      if (!/risk|critic/i.test(ap.role)) {
        expect(ap.prompt).toContain('Game Slate:');
      }
    }

    // Assert proposer prompt is <= budget
    const managerPrompts = recordedPrompts.filter(p => p.role === 'Manager Node');
    expect(managerPrompts.length).toBe(1);
    const mgrBudget = seatBudget('mock-groq-manager');
    expect(managerPrompts[0].prompt.length).toBeLessThanOrEqual(mgrBudget.maxPromptChars);
    expect(managerPrompts[0].prompt).not.toContain('id|game|market');
    expect(managerPrompts[0].prompt).not.toContain('RAW ACTIONABLE BETS');
    expect(managerPrompts[0].prompt).toContain('Game Slate:');
  });

  it('short-circuits when all seats produce placeholder or data-request reports without calling proposer', async () => {
    ProviderRegistry.register({
      providerName: 'mock-groq-seat',
      async call() {
        return JSON.stringify({
          insights: ['data gathering in progress, requesting more context'],
          anomalies: [],
          summary: 'need more data to complete analysis'
        });
      }
    } as any);

    const result = await executeSwarmWorkflow({
      task: 'Analyze today\'s slate and build the best parlay',
      data: tenGameSlate,
      callerAppId: 'duelodds',
      forceFullSwarm: true,
      bypassCache: true,
      settings: {
        appId: 'duelodds',
        agents: [
          { id: 'manager', role: 'Manager Node', provider: 'mock-groq-manager', model: 'mock-m', apiKey: 'k' },
          { id: 'quant', role: 'Quant Specialist', provider: 'mock-groq-seat', model: 'mock-m', apiKey: 'k' }
        ]
      }
    });

    // Proposer was never called
    expect(proposerCalls).toBe(0);
    expect(result.finalAnalysis).toMatchObject({
      ui_title: 'Insufficient data',
      picks: [],
      reason: 'all seats requested data without actionable insights'
    });
  });
});
