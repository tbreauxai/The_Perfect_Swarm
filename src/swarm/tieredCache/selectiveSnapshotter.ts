import type {
    BaseStateSnapshot,
    StateDeltaSnapshot,
    CompressedPayload
} from './types.ts';

/**
 * Selective snapshotter that tracks only delta mutations rather than duplicating full state trees.
 */
export class SelectiveSnapshotter {
    /**
     * Generates a deterministic hash for state verification.
     */
    static hashState(obj: any): string {
        const str = JSON.stringify(obj, Object.keys(obj || {}).sort());
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16).padStart(8, '0');
    }

    /**
     * Creates a full baseline snapshot.
     */
    static createBaseSnapshot(id: string, state: Record<string, any>): BaseStateSnapshot {
        const cloned = JSON.parse(JSON.stringify(state));
        return {
            id,
            timestamp: Date.now(),
            state: cloned,
            hash: this.hashState(cloned)
        };
    }

    /**
     * Creates a delta snapshot representing changes between previous state and current state.
     */
    static createDeltaSnapshot(
        base: BaseStateSnapshot,
        previousState: Record<string, any>,
        currentState: Record<string, any>,
        deltaIndex: number
    ): StateDeltaSnapshot {
        const added: Record<string, any> = {};
        const updated: Record<string, { from: any; to: any }> = {};
        const removed: string[] = [];

        const prevKeys = new Set(Object.keys(previousState));
        const currKeys = new Set(Object.keys(currentState));

        // Detect Added and Updated
        for (const k of currKeys) {
            if (!prevKeys.has(k)) {
                added[k] = JSON.parse(JSON.stringify(currentState[k]));
            } else {
                const prevVal = JSON.stringify(previousState[k]);
                const currVal = JSON.stringify(currentState[k]);
                if (prevVal !== currVal) {
                    updated[k] = {
                        from: JSON.parse(prevVal),
                        to: JSON.parse(currVal)
                    };
                }
            }
        }

        // Detect Removed
        for (const k of prevKeys) {
            if (!currKeys.has(k)) {
                removed.push(k);
            }
        }

        return {
            deltaId: `${base.id}-delta-${deltaIndex}`,
            baseId: base.id,
            deltaIndex,
            timestamp: Date.now(),
            added,
            updated,
            removed
        };
    }

    /**
     * Hydrates and reconstructs state from a base snapshot and an ordered sequence of deltas.
     */
    static hydrateState(base: BaseStateSnapshot, deltas: StateDeltaSnapshot[]): Record<string, any> {
        const state = JSON.parse(JSON.stringify(base.state));
        // Sort deltas sequentially
        const sorted = [...deltas].sort((a, b) => a.deltaIndex - b.deltaIndex);

        for (const delta of sorted) {
            if (delta.baseId !== base.id) continue;

            // Apply additions
            for (const [k, val] of Object.entries(delta.added)) {
                state[k] = JSON.parse(JSON.stringify(val));
            }

            // Apply updates
            for (const [k, mutation] of Object.entries(delta.updated)) {
                state[k] = JSON.parse(JSON.stringify(mutation.to));
            }

            // Apply removals
            for (const k of delta.removed) {
                delete state[k];
            }
        }

        return state;
    }

    /**
     * Compresses state strings or payloads using token dictionary deduplication.
     */
    static compressPayload(payload: string): CompressedPayload {
        const originalByteSize = payload.length;
        const tokens = payload.split(/(\s+|[{},:[\]"'])/).filter(t => t.length > 0);

        const dictMap = new Map<string, number>();
        const dictionary: string[] = [];
        const encodedTokens: number[] = [];

        for (const token of tokens) {
            let id = dictMap.get(token);
            if (id === undefined) {
                id = dictionary.length;
                dictMap.set(token, id);
                dictionary.push(token);
            }
            encodedTokens.push(id);
        }

        const dictBytes = dictionary.reduce((acc, str) => acc + str.length, 0);
        const encodedBytes = encodedTokens.length * 2; // Int16 representation
        const compressedByteSize = dictBytes + encodedBytes;
        const reductionPercent = originalByteSize > 0
            ? Math.max(0, Math.round(((originalByteSize - compressedByteSize) / originalByteSize) * 100))
            : 0;

        return {
            dictionary,
            encodedTokens,
            originalByteSize,
            compressedByteSize,
            reductionPercent
        };
    }

    /**
     * Decompresses dictionary-encoded payloads back to original string.
     */
    static decompressPayload(compressed: CompressedPayload): string {
        return compressed.encodedTokens.map(id => compressed.dictionary[id] || '').join('');
    }
}
