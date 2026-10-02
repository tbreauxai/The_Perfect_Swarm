import { globalFeedbackEngine, analystLedger } from '../feedback.ts';
import { globalSpecialistProfiler } from '../loadBalancer.ts';
import { QdrantLearningStore } from '../learning-persistence.ts';

/**
 * Restores the swarm's durable learning state (outcome records, analyst ledger,
 * specialist accuracy profiles, policy genealogy) from Qdrant into the in-memory
 * singletons. Safe to call on every boot: restores are idempotent merges.
 *
 * If Qdrant is unconfigured or unreachable, this logs a warning and the system
 * keeps its in-memory-only behavior. Never rejects.
 */
export async function restoreLearningState(store?: QdrantLearningStore): Promise<{
    restored: boolean;
    outcomes: number;
    ledgerEntries: number;
    profiles: number;
}> {
    const empty = { restored: false, outcomes: 0, ledgerEntries: 0, profiles: 0 };
    try {
        const s = store || new QdrantLearningStore();
        const ready = await s.whenReady();
        if (!ready) {
            console.warn('[SwarmServer] Learning persistence disabled (no Qdrant) — learning state is in-memory only and will not survive redeploys.');
            return empty;
        }
        const repo = globalFeedbackEngine.getKnowledgeRepository();
        repo.setLearningStore(s);
        analystLedger.setLearningStore(s);
        globalSpecialistProfiler.setLearningStore(s);

        const [outcomes, ledgerEntries, profiles] = await Promise.all([
            repo.restoreFromLearningStore(),
            analystLedger.restoreFromLearningStore(),
            globalSpecialistProfiler.restoreFromLearningStore()
        ]);
        console.log(`[SwarmServer] Learning state restored from durable store: ${outcomes} outcome records, ${ledgerEntries} ledger entries, ${profiles} specialist profiles.`);
        return { restored: true, outcomes, ledgerEntries, profiles };
    } catch (err: any) {
        console.warn('[SwarmServer] Learning-state restore failed (continuing in-memory):', err?.message || err);
        return empty;
    }
}
