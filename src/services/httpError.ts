export type HttpErrorKind =
    | 'app-auth'
    | 'blocked'
    | 'forbidden'
    | 'too-large'
    | 'rate-limit'
    | 'server'
    | 'client'
    | 'unknown';

export interface ParsedHttpError {
    status: number;
    kind: HttpErrorKind;
    message: string;
}

export class HttpError extends Error {
    readonly status: number;
    readonly kind: HttpErrorKind;

    constructor(parsed: ParsedHttpError) {
        super(parsed.message);
        this.name = 'HttpError';
        this.status = parsed.status;
        this.kind = parsed.kind;
    }
}

function isHtmlContent(body: string, contentType: string | null): boolean {
    if (contentType && contentType.toLowerCase().includes('text/html')) {
        return true;
    }
    const trimmed = body.trim();
    if (/^<!DOCTYPE/i.test(trimmed) || /^<html/i.test(trimmed)) {
        return true;
    }
    if (/<[a-z][\s\S]*>/i.test(trimmed) && trimmed.includes('</')) {
        return true;
    }
    return false;
}

/**
 * Safely parses an HTTP response error without leaking raw HTML bodies.
 * Reads the body once with a timeout, extracts JSON .error if present,
 * and maps HTTP status codes to actionable categories.
 */
export async function parseHttpError(
    res: Response,
    timeoutMs: number = 3000
): Promise<ParsedHttpError> {
    const status = res.status;
    let rawBody = '';

    try {
        let timer: any;
        const timeoutPromise = new Promise<string>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        });

        // Read response body once with timeout
        rawBody = await Promise.race([
            res.text(),
            timeoutPromise
        ]);
        clearTimeout(timer);
    } catch {
        rawBody = '';
    }

    const contentType = res.headers && typeof res.headers.get === 'function'
        ? res.headers.get('content-type')
        : null;

    const hasHtml = isHtmlContent(rawBody, contentType);

    let jsonError: string | null = null;
    if (rawBody && !hasHtml) {
        try {
            const data = JSON.parse(rawBody);
            if (data && typeof data === 'object') {
                if (typeof data.error === 'string' && data.error.trim()) {
                    jsonError = data.error.trim();
                } else if (data.error && typeof data.error === 'object' && typeof data.error.message === 'string') {
                    jsonError = data.error.message.trim();
                } else if (typeof data.message === 'string' && data.message.trim()) {
                    jsonError = data.message.trim();
                }
            }
        } catch {
            // Not valid JSON
        }
    }

    // 1. App-auth 401
    if (status === 401) {
        const message = (jsonError && jsonError !== 'Unauthorized')
            ? jsonError
            : 'App token required or invalid — configure token in Settings';
        return {
            status,
            kind: 'app-auth',
            message
        };
    }

    // 2. Blocked 403 (firewall or HTML payload)
    if (status === 403) {
        if (hasHtml || !jsonError) {
            return {
                status,
                kind: 'blocked',
                message: 'Request blocked by firewall — remove semicolon or SQL-like text (e.g. "; drop table") and retry'
            };
        }
        return {
            status,
            kind: 'forbidden',
            message: jsonError
        };
    }

    // 3. Payload too large 413
    if (status === 413) {
        return {
            status,
            kind: 'too-large',
            message: jsonError || 'Payload too large — reduce input size and retry'
        };
    }

    // 4. Rate limit 429
    if (status === 429) {
        return {
            status,
            kind: 'rate-limit',
            message: jsonError || 'Rate limit exceeded — please wait and retry'
        };
    }

    // 5. Server errors 5xx
    if (status >= 500 && status < 600) {
        return {
            status,
            kind: 'server',
            message: jsonError || `Server error (HTTP ${status})`
        };
    }

    // 6. Generic or other client errors
    const defaultMessage = jsonError || `HTTP ${status}`;
    const kind: HttpErrorKind = (status >= 400 && status < 500) ? 'client' : 'unknown';

    return {
        status,
        kind,
        message: defaultMessage
    };
}
