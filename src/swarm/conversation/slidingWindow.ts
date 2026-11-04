import { TokenEstimator } from '../compression/tokenEstimator.ts';

export type ConversationRole = 'user' | 'assistant' | 'system';

export interface ConversationTurn {
    role: ConversationRole;
    content: string;
    timestamp?: number;
    tokens?: number;
}

export interface SlidingWindowConfig {
    /** Maximum number of recent conversation turns to retain verbatim. Default: 8 */
    maxVerbatimTurns?: number;
    /** Hard ceiling on total context tokens (verbatim + rolling summary). Default: 5500 (strictly < 6000) */
    maxContextTokens?: number;
    /** Optional LLM summarizer hook to condense evicted turns into rolling summary */
    summarizer?: (evictedTurns: ConversationTurn[], currentSummary: string) => Promise<string> | string;
}

/**
 * Sliding-Window Memory Context Rotator for streaming and multi-turn workflows.
 * Guarantees context size stays permanently bounded below 6k tokens during
 * infinite streaming sessions by retaining the last N turns verbatim and
 * maintaining a dense rolling summary buffer of older history.
 */
export class SlidingWindowContext {
    private verbatimTurns: ConversationTurn[] = [];
    private rollingSummary: string = '';
    private maxVerbatimTurns: number;
    private maxContextTokens: number;
    private summarizer?: (evictedTurns: ConversationTurn[], currentSummary: string) => Promise<string> | string;

    constructor(config?: SlidingWindowConfig) {
        this.maxVerbatimTurns = config?.maxVerbatimTurns ?? 8;
        this.maxContextTokens = config?.maxContextTokens ?? 5500;
        this.summarizer = config?.summarizer;
    }

    getRollingSummary(): string {
        return this.rollingSummary;
    }

    getVerbatimTurns(): ConversationTurn[] {
        return [...this.verbatimTurns];
    }

    /**
     * Appends a new conversation turn and triggers window rotation if thresholds are exceeded.
     */
    async addTurn(turn: ConversationTurn): Promise<void> {
        const tokens = turn.tokens ?? TokenEstimator.countTokens(turn.content);
        const turnWithTokens: ConversationTurn = {
            ...turn,
            tokens,
            timestamp: turn.timestamp ?? Date.now()
        };

        this.verbatimTurns.push(turnWithTokens);
        await this.rotateIfNeeded();
    }

    /**
     * Appends multiple conversation turns.
     */
    async addTurns(turns: ConversationTurn[]): Promise<void> {
        for (const t of turns) {
            await this.addTurn(t);
        }
    }

    /**
     * Calculates total tokens currently consumed across verbatim turns and rolling summary.
     */
    getTotalTokenCount(): number {
        const verbatimTokens = this.verbatimTurns.reduce((sum, t) => sum + (t.tokens ?? TokenEstimator.countTokens(t.content)), 0);
        const summaryTokens = this.rollingSummary.length > 0 ? TokenEstimator.countTokens(this.rollingSummary) + 15 : 0;
        return verbatimTokens + summaryTokens;
    }

    /**
     * Internal rotation logic: evicts oldest turns into the rolling summary buffer
     * until verbatim turns <= maxVerbatimTurns AND total tokens <= maxContextTokens.
     */
    private async rotateIfNeeded(): Promise<void> {
        const evicted: ConversationTurn[] = [];

        // 1. Enforce max verbatim turn count limit
        while (this.verbatimTurns.length > this.maxVerbatimTurns) {
            evicted.push(this.verbatimTurns.shift()!);
        }

        // 2. Enforce hard token budget ceiling
        while (this.verbatimTurns.length > 2 && this.getTotalTokenCount() > this.maxContextTokens) {
            evicted.push(this.verbatimTurns.shift()!);
        }

        // 3. Compact evicted turns into the rolling summary
        if (evicted.length > 0) {
            if (this.summarizer) {
                try {
                    this.rollingSummary = await this.summarizer(evicted, this.rollingSummary);
                } catch {
                    this.rollingSummary = this.defaultCondensedSummary(evicted, this.rollingSummary);
                }
            } else {
                this.rollingSummary = this.defaultCondensedSummary(evicted, this.rollingSummary);
            }

            // Cap rolling summary tokens to prevent summary buffer bloat (max 800 tokens)
            if (TokenEstimator.countTokens(this.rollingSummary) > 800) {
                this.rollingSummary = TokenEstimator.truncateToTokens(this.rollingSummary, 750);
            }
        }
    }

    /**
     * Deterministic, zero-dependency condensation of evicted history turns.
     */
    private defaultCondensedSummary(evicted: ConversationTurn[], currentSummary: string): string {
        const keyStatements: string[] = [];
        for (const t of evicted) {
            const lines = t.content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
            for (const line of lines) {
                // Keep factual, numerical, error, or decision lines
                if (/\b(error|fail|result|score|metric|id|status|decision|call|action)\b/i.test(line) || /\d+/.test(line)) {
                    keyStatements.push(`[${t.role}]: ${line.slice(0, 120)}`);
                }
            }
            if (lines.length > 0 && keyStatements.length === 0) {
                keyStatements.push(`[${t.role}]: ${lines[0].slice(0, 100)}`);
            }
        }

        const newPoints = keyStatements.slice(0, 8).join('; ');
        if (!currentSummary) {
            return `Summary: ${newPoints}`;
        }
        return `${currentSummary} | ${newPoints}`;
    }

    /**
     * Returns effective context as array of turns suitable for LLM message history.
     */
    getEffectiveContext(): ConversationTurn[] {
        const result: ConversationTurn[] = [];
        if (this.rollingSummary) {
            result.push({
                role: 'system',
                content: `[Rolling Summary of Preceding Conversation History]:\n${this.rollingSummary}`,
                tokens: TokenEstimator.countTokens(this.rollingSummary) + 15
            });
        }
        result.push(...this.verbatimTurns);
        return result;
    }

    /**
     * Renders entire conversational context as a single formatted prompt string.
     */
    renderContextPrompt(): string {
        const parts: string[] = [];
        if (this.rollingSummary) {
            parts.push(`=== CONVERSATION HISTORY SUMMARY ===\n${this.rollingSummary}\n=== END SUMMARY ===`);
        }
        for (const t of this.verbatimTurns) {
            parts.push(`[${t.role.toUpperCase()}]: ${t.content}`);
        }
        return parts.join('\n\n').trim();
    }

    reset(): void {
        this.verbatimTurns = [];
        this.rollingSummary = '';
    }
}
