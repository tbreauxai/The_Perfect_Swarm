import type { SwarmTool } from './types.ts';
import { resolveTrustedRetrievalScope } from '../engine/historyScope.ts';
import { getSupabaseReadOnlyConfig, readGameContextFromStore } from '../morning/gameContext.ts';
import { fetchOnDemandReadOnlySupabaseContext } from '../morning/supabase.ts';

export const getGameContextTool: SwarmTool = {
    name: 'get_game_context',
    description:
        'Resolves an event ID to its canonical game ID and retrieves structured game context, including odds, form, injuries, venue, and weather.',
    parameters: {
        event_id: {
            type: 'string',
            description: 'Game or Odds API event ID',
            required: true
        },
        sport: {
            type: 'string',
            description: 'Sport key, such as basketball_nba',
            required: true
        },
        date: {
            type: 'string',
            description: 'Game date in YYYY-MM-DD format',
            required: true
        }
    },
    execute: async (args: Record<string, unknown>, context?: {
        fetchFn?: typeof fetch;
        env?: Record<string, string | undefined>;
    }) => {
        if (
            typeof args?.event_id !== 'string' ||
            !args.event_id.trim() ||
            typeof args.sport !== 'string' ||
            !args.sport.trim() ||
            typeof args.date !== 'string' ||
            !args.date.trim()
        ) {
            return {
                success: false,
                error: 'invalid_game_context_scope',
                message: 'event_id, sport, and date are required to retrieve game context.',
                summary: 'Error: event_id, sport, and date are required.'
            };
        }

        const scopeResult = resolveTrustedRetrievalScope({
            callerAppId: 'perfect-swarm',
            body: {
                eventIds: [args.event_id.trim()],
                sport: args.sport.trim(),
                date: args.date.trim()
            }
        });
        if (!scopeResult.ok) {
            return {
                success: false,
                error: 'invalid_game_context_scope',
                message: scopeResult.error,
                summary: `Error retrieving game context: ${scopeResult.error}`
            };
        }

        const env = context?.env || (typeof process !== 'undefined' ? process.env : {});
        const result = await readGameContextFromStore(
            getSupabaseReadOnlyConfig(env),
            scopeResult.scope,
            context?.fetchFn || globalThis.fetch
        );
        if (result.status !== 'ok') {
            return {
                success: false,
                error: result.status === 'outage' ? result.error : result.status,
                message: result.detail,
                summary: `Error retrieving game context: ${result.detail}`
            };
        }

        const canonicalEventIds = result.results.map((row) => row.event_id);
        const readOnlyConfig = getSupabaseReadOnlyConfig(env);
        const historicalContext = await fetchOnDemandReadOnlySupabaseContext(
            readOnlyConfig,
            {
                eventIds: canonicalEventIds,
                gameDate: args.date.trim(),
                sport: args.sport.trim(),
                asOf: scopeResult.scope.asOf,
                limit: 6
            },
            context?.fetchFn || globalThis.fetch
        );
        const historicalBlock = historicalContext.formattedBlock ||
            (historicalContext.error
                ? `Judgment/line history unavailable: ${historicalContext.detail || historicalContext.error}`
                : 'No prior judgments or line snapshots are available.');
        const summary = [
            `[GAME CONTEXT: ${canonicalEventIds.join(', ') || args.event_id}]`,
            result.formattedBlock || 'No ready structured game context is available for this event.',
            historicalBlock
        ].join('\n');

        return {
            success: true,
            requested_event_id: args.event_id.trim(),
            canonical_event_ids: canonicalEventIds,
            status: result.results.map((row) => row.status),
            contexts: result.results,
            judgments: historicalContext.judgments,
            line_snapshots: historicalContext.lineSnapshots,
            historical_context_error: historicalContext.error,
            summary
        };
    }
};
