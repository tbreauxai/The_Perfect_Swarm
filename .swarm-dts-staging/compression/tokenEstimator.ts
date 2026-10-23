/**
 * Heuristic Token Estimator for LLM context windows.
 * Models BPE/WordPiece tokenization boundaries with adjustments for code, JSON, and punctuation.
 */
export class TokenEstimator {
    /**
     * Estimates token count for arbitrary text with zero external dependencies.
     */
    static countTokens(text: string): number {
        if (!text || text.trim().length === 0) return 0;

        // Fast path for very short strings
        if (text.length <= 4) return 1;

        // Split into chunks of whitespace-separated units
        const words = text.trim().split(/\s+/);
        let tokenCount = 0;

        for (const word of words) {
            if (!word) continue;

            const len = word.length;
            if (len <= 3) {
                tokenCount += 1;
            } else if (/[{}[\](),.:;"'`<>=+*#@!$%^&|\\/?]/.test(word)) {
                // Symbols and code tokens typically fragment into multiple BPE pieces
                tokenCount += Math.max(1, Math.ceil(len / 2.8));
            } else if (/^[A-Z0-9_-]+$/.test(word)) {
                // Acronyms, hex IDs, uppercase identifiers
                tokenCount += Math.max(1, Math.ceil(len / 3.0));
            } else {
                // Standard natural language word
                tokenCount += Math.max(1, Math.ceil(len / 4.0));
            }
        }

        return Math.max(1, tokenCount);
    }

    /**
     * Truncates text to fit within a strict token budget.
     */
    static truncateToTokens(text: string, maxTokens: number): string {
        if (!text || maxTokens <= 0) return '';
        const current = this.countTokens(text);
        if (current <= maxTokens) return text;

        const ratio = maxTokens / current;
        const targetChars = Math.floor(text.length * ratio * 0.95);
        const sliced = text.slice(0, targetChars);
        const lastSpace = sliced.lastIndexOf(' ');
        return (lastSpace > 0 ? sliced.slice(0, lastSpace) : sliced) + '...';
    }
}
