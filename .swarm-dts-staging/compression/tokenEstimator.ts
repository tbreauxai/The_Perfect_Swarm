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
        const current = this.estimatePayloadTokens(text);
        if (current <= maxTokens) return text;

        const ratio = maxTokens / current;
        const targetChars = Math.floor(text.length * ratio * 0.95);
        const sliced = text.slice(0, targetChars);
        const lastSpace = Math.max(sliced.lastIndexOf(' '), sliced.lastIndexOf('\n'));
        return (lastSpace > 0 ? sliced.slice(0, lastSpace) : sliced) + '...';
    }
    /**
     * Estimates token count directly from character count (default: chars / 4).
     */
    static estimateFromChars(chars: number, divisor: number = 4): number {
        return Math.ceil(Math.max(0, chars) / divisor);
    }

    /**
     * Estimates token count for arbitrary text (alias for countTokens).
     */
    static estimateFromText(text: string): number {
        return this.countTokens(text);
    }

    /**
     * Syntax-aware token estimator for structured payloads (JSON, objects, telemetry logs, natural text).
     * Distinguishes punctuation/keys (len / 2.2), uppercase/identifiers (len / 2.8),
     * and natural language (len / 4.0), applying a 1.12x safety buffer for JSON data.
     */
    static estimatePayloadTokens(input: string | object | unknown): number {
        if (input === null || input === undefined) return 0;
        if (typeof input === 'number') {
            return Math.max(1, Math.ceil(String(input).length / 2.8));
        }

        let isJson = false;
        let text = '';

        if (typeof input === 'object') {
            isJson = true;
            try {
                text = JSON.stringify(input);
            } catch {
                text = String(input);
            }
        } else if (typeof input === 'string') {
            text = input;
            const trimmed = text.trim();
            if (
                (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
                (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
                trimmed.includes('{"') ||
                trimmed.includes('":')
            ) {
                isJson = true;
            }
        } else {
            text = String(input);
        }

        if (!text || text.trim().length === 0) return 0;
        if (text.length <= 4) return 1;

        // Fast regex matching: chunks of alphanumeric or symbols
        const matches = text.match(/[A-Za-z0-9_]+|[^\s\w]+/g) || [];
        let count = 0;

        for (const seg of matches) {
            const len = seg.length;
            if (len <= 3) {
                count += 1;
            } else if (/[{}[\](),.:;"'`<>=+*#@!$%^&|\\/?]/.test(seg)) {
                // Punctuation and symbols (JSON syntax, operators, brackets)
                count += Math.max(1, Math.ceil(len / 2.2));
            } else if (/^[A-Z0-9_-]+$/.test(seg) || /[a-z]+[A-Z]/.test(seg)) {
                // Uppercase, hex IDs, numbers, camelCase/snake_case identifiers
                count += Math.max(1, Math.ceil(len / 2.8));
            } else {
                // Standard natural language words
                count += Math.max(1, Math.ceil(len / 4.0));
            }
        }

        if (isJson) {
            count = Math.ceil(count * 1.12);
        }

        return Math.max(1, count);
    }
}
