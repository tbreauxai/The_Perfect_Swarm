/**
 * HTTP Timeout and Rate-Limit (429) Parsing Utilities.
 * Provides unified extraction of retry-after values from headers, error objects, and error messages.
 */

/**
 * Parses a standard HTTP `retry-after` header value (seconds or HTTP-date string) into milliseconds.
 * Returns null if the header is empty or cannot be parsed.
 */
export function parseRetryAfterHeader(headerVal: string | null | undefined): number | null {
    if (!headerVal) return null;
    const trimmed = String(headerVal).trim();
    if (trimmed.length === 0) return null;

    // Check if numeric seconds (e.g. "5" or "5.5")
    const asSeconds = Number(trimmed);
    if (!isNaN(asSeconds) && asSeconds > 0) {
        return Math.round(asSeconds * 1000);
    }

    // Check if HTTP-date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT")
    const parsedDate = Date.parse(trimmed);
    if (!isNaN(parsedDate)) {
        const diffMs = parsedDate - Date.now();
        if (diffMs > 0) {
            return diffMs;
        }
    }

    return null;
}

/**
 * Robustly extracts the backoff duration in milliseconds from an error, response, or header value.
 * Supports:
 *   1. Explicit `retryAfterMs` or `retryAfter` numeric error properties
 *   2. Standard HTTP response headers (`headers.get('retry-after')` or `headers['retry-after']`)
 *   3. Free-text regex patterns in error messages ('try again in 2s', 'wait 15 seconds', 'retry-after: 5')
 * Clamps result between `minCooldownMs` and `maxCooldownMs`.
 */
export function parseRetryAfterMs(
    errorOrHeader: any,
    defaultCooldownMs: number = 15000,
    minCooldownMs: number = 1000,
    maxCooldownMs: number = 60000
): number {
    if (!errorOrHeader) return defaultCooldownMs;

    // Direct string header value
    if (typeof errorOrHeader === 'string') {
        const parsed = parseRetryAfterHeader(errorOrHeader);
        if (parsed !== null) {
            return Math.max(minCooldownMs, Math.min(maxCooldownMs, parsed));
        }
    }

    // 1. Explicit properties on error object
    if (typeof errorOrHeader.retryAfterMs === 'number' && errorOrHeader.retryAfterMs > 0) {
        return Math.max(minCooldownMs, Math.min(maxCooldownMs, Math.round(errorOrHeader.retryAfterMs)));
    }
    if (typeof errorOrHeader.retryAfter === 'number' && errorOrHeader.retryAfter > 0) {
        return Math.max(minCooldownMs, Math.min(maxCooldownMs, Math.round(errorOrHeader.retryAfter * 1000)));
    }

    // 2. HTTP response headers on error
    const headerVal = errorOrHeader.headers?.get
        ? errorOrHeader.headers.get('retry-after')
        : errorOrHeader.headers?.['retry-after'];

    if (headerVal) {
        const parsed = parseRetryAfterHeader(headerVal);
        if (parsed !== null) {
            return Math.max(minCooldownMs, Math.min(maxCooldownMs, parsed));
        }
    }

    // 3. String regex matching from error message
    const errMsg = String(errorOrHeader?.message || errorOrHeader || '');
    const match = errMsg.match(/(?:retry-after|retry after|try again in|wait|retry_after)\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*(ms|m|min|minutes|s|sec|seconds)?/i);
    if (match) {
        const val = parseFloat(match[1]);
        const unit = (match[2] || 's').toLowerCase();
        let ms = val * 1000;
        if (unit === 'ms') ms = val;
        else if (unit === 'm' || unit === 'min' || unit === 'minutes') ms = val * 60 * 1000;
        if (!isNaN(ms) && ms > 0) {
            return Math.max(minCooldownMs, Math.min(maxCooldownMs, Math.round(ms)));
        }
    }

    return defaultCooldownMs;
}
