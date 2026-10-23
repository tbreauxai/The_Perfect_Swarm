import { describe, it, expect } from 'vitest';
import { parseSseBlock, parseSseStream } from './sseParser.ts';

describe('SSE Stream and Block Parser', () => {
    it('parses valid SSE block with event and JSON data', () => {
        const block = 'event: swarm_stage\ndata: {"stage": "decomposition", "progress": 0.5}\n';
        const parsed = parseSseBlock(block);
        expect(parsed).not.toBeNull();
        expect(parsed?.event).toBe('swarm_stage');
        expect(parsed?.data).toEqual({ stage: 'decomposition', progress: 0.5 });
    });

    it('defaults to event "message" when no event line is specified', () => {
        const block = 'data: {"result": "ok"}';
        const parsed = parseSseBlock(block);
        expect(parsed).not.toBeNull();
        expect(parsed?.event).toBe('message');
        expect(parsed?.data).toEqual({ result: 'ok' });
    });

    it('ignores comments and empty lines', () => {
        expect(parseSseBlock(': ping')).toBeNull();
        expect(parseSseBlock('   \n\n  ')).toBeNull();
        expect(parseSseBlock(': keep-alive\n\n')).toBeNull();
    });

    it('ignores malformed non-JSON data gracefully', () => {
        expect(parseSseBlock('data: not json text')).toBeNull();
    });

    it('streams and parses chunks across fragmented boundaries', async () => {
        const encoder = new TextEncoder();
        const chunks = [
            'event: swarm_event\nda',
            'ta: {"step": 1}\n\n',
            ': comment ping\n\nevent: swarm_complete\ndata: {"status": "done"}\n\n'
        ];

        const readable = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of chunks) {
                    controller.enqueue(encoder.encode(chunk));
                }
                controller.close();
            }
        });

        let chunkCount = 0;
        const events: any[] = [];
        for await (const block of parseSseStream(readable, () => { chunkCount++; })) {
            events.push(block);
        }

        expect(chunkCount).toBe(3);
        expect(events).toHaveLength(2);
        expect(events[0].event).toBe('swarm_event');
        expect(events[0].data).toEqual({ step: 1 });
        expect(events[1].event).toBe('swarm_complete');
        expect(events[1].data).toEqual({ status: 'done' });
    });
});
