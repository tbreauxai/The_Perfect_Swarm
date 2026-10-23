/**
 * Zero-dependency Server-Sent Events (SSE) Stream & Block Parser.
 * Handles chunk fragmentation, keep-alive comments, multi-line blocks, and JSON payloads.
 */

export interface ParsedSseBlock<T = any> {
    event: string;
    data: T;
    rawBlock: string;
}

/**
 * Parses a single raw SSE block into its event type and JSON data.
 * Returns null if the block is empty, a comment, or contains unparseable data.
 */
export function parseSseBlock<T = any>(block: string): ParsedSseBlock<T> | null {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith(':')) {
        return null;
    }

    let event = 'message';
    let dataStr = '';

    for (const line of block.split('\n')) {
        const cleanLine = line.replace(/\r$/, '');
        if (cleanLine.startsWith(':')) {
            continue;
        }
        if (cleanLine.startsWith('event:')) {
            event = cleanLine.slice(6).trim();
        } else if (cleanLine.startsWith('data:')) {
            dataStr = cleanLine.slice(5).trim();
        }
    }

    if (!dataStr) {
        return null;
    }

    try {
        const data = JSON.parse(dataStr);
        return { event, data, rawBlock: block };
    } catch {
        return null;
    }
}

/**
 * Async generator that consumes a ReadableStream of Uint8Array chunks,
 * maintains an internal buffer across chunk boundaries, and yields parsed SSE blocks.
 */
export async function* parseSseStream<T = any>(
    stream: ReadableStream<Uint8Array>,
    onChunk?: () => void
): AsyncIterable<ParsedSseBlock<T>> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            onChunk?.();
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop() || '';

            for (const block of parts) {
                const parsed = parseSseBlock<T>(block);
                if (parsed) {
                    yield parsed;
                }
            }
        }

        if (buffer.trim()) {
            const parsed = parseSseBlock<T>(buffer);
            if (parsed) {
                yield parsed;
            }
        }
    } finally {
        reader.releaseLock();
    }
}
