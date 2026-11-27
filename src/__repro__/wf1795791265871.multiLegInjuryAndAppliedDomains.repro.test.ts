import { describe, it, expect, vi } from 'vitest';
import { auditCriticPremiseContradictions } from '../swarm/tools/claimGrounding.ts';
import { parseGameHeaders } from '../swarm/context/gameHeaders.ts';
import { SwarmContext } from '../swarm/context.ts';
import { ToolRegistry } from '../swarm/tools/index.ts';
import { MemoryCortex } from '../swarm/memory.ts';
import { QdrantStorageAdapter } from '../swarm/memory/storage/qdrantStorage.ts';
import { resolveMemoryGrounding } from '../swarm/engine/memoryGrounding.ts';

const SLATE_5871 = [
  'event_id=nhl-car-1 | sport=icehockey_nhl | New York Rangers @ Carolina Hurricanes | commence=2026-11-26T00:00:00Z | options: R1 Carolina Hurricanes -1.5 (+135), R2 New York Rangers +1.5 (-160)',
  'event_id=nhl-dal-2 | sport=icehockey_nhl | Winnipeg Jets @ Dallas Stars | commence=2026-11-26T01:00:00Z | options: R3 Dallas Stars -1.5 (+140), R4 Winnipeg Jets +1.5 (-165)',
  'event_id=nhl-fla-3 | sport=icehockey_nhl | Buffalo Sabres @ Florida Panthers | commence=2026-11-26T00:30:00Z | options: R5 Florida Panthers ML (-155), R6 Buffalo Sabres ML (+130)'
].join('\n');

const EVIDENCE_5871 = [
  'EVENT nhl-car-1',
  '[MARKET MOVEMENT: nhl-car-1] Steam: TOWARD home Carolina Hurricanes -1.5 (+145 -> +135, +1.8pp implied) | AGAINST away New York Rangers +1.5',
  '[INJURY & ROSTER DELTA: nhl-car-1] Summary: Carolina Hurricanes (1 OUT, 0 Q) vs New York Rangers (1 OUT, 0 Q) | Health Balance: symmetric',
  'EVENT nhl-dal-2',
  '[MARKET MOVEMENT: nhl-dal-2] Steam: TOWARD home Dallas Stars -1.5 (+150 -> +140, +1.7pp implied) | AGAINST away Winnipeg Jets +1.5',
  '[INJURY & ROSTER DELTA: nhl-dal-2] Summary: Dallas Stars (0 OUT, 1 Q) vs Winnipeg Jets (0 OUT, 1 Q) | Health Balance: symmetric',
  'EVENT nhl-fla-3',
  '[MARKET MOVEMENT: nhl-fla-3] Steam: neutral',
  '[INJURY & ROSTER DELTA: nhl-fla-3] Summary: Florida Panthers (0 OUT, 0 Q) vs Buffalo Sabres (3 OUT, 1 Q) | Health Balance: home_advantage (Florida Panthers, +3.0 impact edge)'
].join('\n');

const HEADERS_5871 = parseGameHeaders(SLATE_5871);

describe('wf-1795791265871: Per-pick symmetric_injury_misread isolation & HybridCortex multi domain inclusion', () => {
  it('1a. Does NOT trigger symmetric_injury_misread on legs 1-2 (form + steam, symmetric health) when leg 3 claims asymmetric health advantage in multi-leg analysis', () => {
    const seatReport = {
      seat: 'a1',
      summary:
        '3-leg parlay combining Carolina Hurricanes -1.5 (form + steam), Dallas Stars -1.5 (form + steam), and Florida Panthers ML (asymmetric health advantage). Health balances are symmetric for Carolina Hurricanes and Dallas Stars.',
      analysis:
        'For the 3-leg parlay, Carolina Hurricanes -1.5 and Dallas Stars -1.5 back form + steam; Florida Panthers ML holds an asymmetric health advantage with 0 OUT vs 3 OUT. Health balances are symmetric for Carolina Hurricanes and Dallas Stars.',
      picks: [
        {
          row: 'R1',
          event_id: 'nhl-car-1',
          side: 'Carolina Hurricanes -1.5',
          reason: 'Strong L5=4-1 form + favorable market steam toward Carolina.',
          reasons: ['Home scoring margin edge', 'Favorable steam toward Hurricanes -1.5']
        },
        {
          row: 'R3',
          event_id: 'nhl-dal-2',
          side: 'Dallas Stars -1.5',
          reason: 'L5=4-1 form + favorable steam toward Dallas.',
          reasons: ['Form edge', 'Steam backing Stars -1.5']
        },
        {
          row: 'R5',
          event_id: 'nhl-fla-3',
          side: 'Florida Panthers ML',
          reason: 'Asymmetric health advantage (0 OUT vs Buffalo 3 OUT) and home ice edge.'
        }
      ]
    };

    const audit = auditCriticPremiseContradictions(
      {
        picks: seatReport.picks,
        analysis: seatReport.analysis,
        summary: seatReport.summary,
        seatReports: [seatReport]
      },
      EVIDENCE_5871,
      SLATE_5871,
      { headers: HEADERS_5871, allowParlay: true }
    );

    expect(audit.flags).not.toContain('symmetric_injury_misread');
    expect(audit.pass).toBe(true);
    expect(audit.vetoedLegs ?? []).toEqual([]);
  });

  it('1b. Ignores unpunctuated cross-leg clauses and negated/explicitly symmetric statements while still catching true-positive misreads on symmetric legs', () => {
    const cleanRunOnReport = {
      seat: 'a2',
      analysis:
        'Carolina Hurricanes -1.5 relies on form + steam and Florida Panthers ML holds an asymmetric health advantage. Health balances are symmetric for R1 and R3; Carolina Hurricanes has no asymmetric health edge.',
      picks: [
        {
          row: 'R1',
          event_id: 'nhl-car-1',
          side: 'Carolina Hurricanes -1.5',
          reason: 'Form + steam; no health advantage claimed.'
        },
        {
          row: 'R3',
          event_id: 'nhl-dal-2',
          side: 'Dallas Stars -1.5',
          reason: 'Form + steam; Health balances are balanced.'
        },
        {
          row: 'R5',
          event_id: 'nhl-fla-3',
          side: 'Florida Panthers ML',
          reason: 'Asymmetric health advantage against depleted Buffalo.'
        }
      ]
    };

    const cleanAudit = auditCriticPremiseContradictions(
      { picks: cleanRunOnReport.picks, analysis: cleanRunOnReport.analysis, seatReports: [cleanRunOnReport] },
      EVIDENCE_5871,
      SLATE_5871,
      { headers: HEADERS_5871, allowParlay: true }
    );
    expect(cleanAudit.flags).not.toContain('symmetric_injury_misread');
    expect(cleanAudit.pass).toBe(true);

    // True positive: R1 itself falsely claims a health advantage in its own reason
    const badPickReport = {
      picks: [
        {
          row: 'R1',
          event_id: 'nhl-car-1',
          side: 'Carolina Hurricanes -1.5',
          reason: 'Form + asymmetric health advantage over Rangers.'
        },
        {
          row: 'R3',
          event_id: 'nhl-dal-2',
          side: 'Dallas Stars -1.5',
          reason: 'Form + favorable steam.'
        }
      ]
    };

    const badAudit = auditCriticPremiseContradictions(
      badPickReport,
      EVIDENCE_5871,
      SLATE_5871,
      { headers: HEADERS_5871, allowParlay: true }
    );
    expect(badAudit.pass).toBe(false);
    expect(badAudit.flags).toContain('symmetric_injury_misread');
    expect((badAudit.vetoedLegs || []).map(v => v.rowId)).toEqual(['R1']);
  });

  it('2a. HybridCortex resolveMemoryGrounding appends "multi" to appliedDomains and retrieves "multi" parlay lessons from Qdrant when allowParlay is true, domains.length > 1, or domain === "multi-sport"', async () => {
    const capturedFilters: any[] = [];
    const fakeQdrantClient: any = {
      getCollection: vi.fn(async () => ({ points_count: 12 })),
      getCollections: vi.fn(async () => ({ collections: [{ name: 'pwa_swarm_dev_cortex_v4' }] })),
      query: vi.fn(async (_collection: string, args: any) => {
        capturedFilters.push(args?.filter ?? args?.prefetch?.[0]?.filter);
        return {
          points: [
            {
              id: 'multi-lesson-1',
              score: 0.91,
              payload: {
                lessonId: 'multi-lesson-1',
                originApp: 'duelodds',
                appId: 'duelodds',
                domain: 'multi',
                eventId: 'nhl-car-1',
                memoryType: 'fact',
                qualityRating: 0.9,
                verified: true,
                content: 'Multi-leg parlay rule: require favorable steam or true health edge on every leg.'
              }
            }
          ]
        };
      })
    };

    const okAiClient: any = {
      models: {
        embedContent: vi.fn(async () => ({
          embeddings: [{ values: new Array(768).fill(0.2) }]
        }))
      }
    };

    const makeCortex = () => {
      const cortex = new MemoryCortex({
        isolatedStore: true,
        url: 'http://fake-qdrant:6333',
        collectionName: 'pwa_swarm_dev_cortex_v4',
        defaultAppId: 'duelodds',
        aiClient: okAiClient,
        embeddingModel: 'gemini-embedding-2'
      });
      (cortex as any).qdrantStorage = new QdrantStorageAdapter({
        collectionName: 'pwa_swarm_dev_cortex_v4',
        client: fakeQdrantClient
      });
      return cortex;
    };

    // Case A: Single-sport domain ('nhl') with allowParlay: true -> appliedDomains includes 'nhl' and 'multi', recordsFound > 0
    const ctxParlay = new SwarmContext();
    const resParlay = await resolveMemoryGrounding({
      task: 'Build 3-leg NHL parlay',
      data: SLATE_5871,
      domain: 'nhl',
      allowParlay: true,
      eventIds: ['nhl-car-1', 'nhl-dal-2'],
      targetAppId: 'duelodds',
      bypassCache: true,
      qdrantUrl: 'http://fake-qdrant:6333',
      memoryCortex: makeCortex(),
      toolRegistry: new ToolRegistry([]),
      context: ctxParlay,
      includeShared: false
    });
    const evtParlay = ctxParlay.events.find(e => e.action === 'Cortex Retrieval Complete');
    expect(evtParlay?.output?.appliedDomains).toEqual(['nhl', 'multi']);
    expect(evtParlay?.output?.recordsFound).toBe(1);
    expect(resParlay.historicalContext).toContain('Multi-leg parlay rule');
    expect(JSON.stringify(capturedFilters[0])).toContain('"multi"');

    // Case B: domains.length > 1 -> appliedDomains includes all sports + 'multi'
    const ctxMultiArr = new SwarmContext();
    await resolveMemoryGrounding({
      task: 'Evaluate NBA + NHL slate',
      data: 'event_id=nba-1\nevent_id=nhl-1',
      domains: ['nba', 'nhl'],
      targetAppId: 'duelodds',
      bypassCache: true,
      qdrantUrl: 'http://fake-qdrant:6333',
      memoryCortex: makeCortex(),
      toolRegistry: new ToolRegistry([]),
      context: ctxMultiArr,
      includeShared: false
    });
    const evtMultiArr = ctxMultiArr.events.find(e => e.action === 'Cortex Retrieval Complete');
    expect(evtMultiArr?.output?.appliedDomains).toEqual(['nba', 'nhl', 'multi']);
    expect(evtMultiArr?.output?.recordsFound).toBe(1);

    // Case C: domain === 'multi-sport' -> appliedDomains includes 'multi-sport' and 'multi'
    const ctxMultiSport = new SwarmContext();
    await resolveMemoryGrounding({
      task: 'Evaluate multi-sport slate',
      data: 'slate',
      domain: 'multi-sport',
      targetAppId: 'duelodds',
      bypassCache: true,
      qdrantUrl: 'http://fake-qdrant:6333',
      memoryCortex: makeCortex(),
      toolRegistry: new ToolRegistry([]),
      context: ctxMultiSport,
      includeShared: false
    });
    const evtMultiSport = ctxMultiSport.events.find(e => e.action === 'Cortex Retrieval Complete');
    expect(evtMultiSport?.output?.appliedDomains).toEqual(['multi-sport', 'multi']);
    expect(evtMultiSport?.output?.recordsFound).toBe(1);

    // Case D: Single-sport non-parlay -> does NOT append 'multi'
    const ctxSingle = new SwarmContext();
    await resolveMemoryGrounding({
      task: 'Evaluate single NHL game',
      data: 'event_id=nhl-car-1',
      domain: 'nhl',
      allowParlay: false,
      targetAppId: 'duelodds',
      bypassCache: true,
      qdrantUrl: 'http://fake-qdrant:6333',
      memoryCortex: makeCortex(),
      toolRegistry: new ToolRegistry([]),
      context: ctxSingle,
      includeShared: false
    });
    const evtSingle = ctxSingle.events.find(e => e.action === 'Cortex Retrieval Complete');
    expect(evtSingle?.output?.appliedDomains).toEqual(['nhl']);
  });
});
