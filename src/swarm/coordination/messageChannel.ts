import type { InteragentMessage } from './types.ts';

/**
 * Circular ring-buffer message bus for ultra-low latency, high-bandwidth interagent communication.
 */
export class HighBandwidthMessageChannel {
    private capacity: number;
    private ringBuffer: Array<InteragentMessage | null>;
    private head: number = 0;
    private tail: number = 0;
    private size: number = 0;
    private subscribers: Map<string, Array<(msg: InteragentMessage) => void>> = new Map();

    public constructor(capacity: number = 1024) {
        this.capacity = capacity;
        this.ringBuffer = new Array(capacity).fill(null);
    }

    public publish(messageInput: {
        senderId: string;
        targetId?: string;
        topic: string;
        payload: any;
    }): InteragentMessage {
        const msg: InteragentMessage = {
            id: `msg-${Date.now()}-${crypto.randomUUID().substring(0, 8)}`,
            senderId: messageInput.senderId,
            targetId: messageInput.targetId || 'broadcast',
            topic: messageInput.topic,
            payload: messageInput.payload,
            timestamp: Date.now()
        };

        this.ringBuffer[this.tail] = msg;
        this.tail = (this.tail + 1) % this.capacity;

        if (this.size < this.capacity) {
            this.size++;
        } else {
            this.head = (this.head + 1) % this.capacity; // Overwrite oldest
        }

        this.dispatch(msg);
        return msg;
    }

    public subscribe(topic: string, listener: (msg: InteragentMessage) => void): () => void {
        if (!this.subscribers.has(topic)) {
            this.subscribers.set(topic, []);
        }
        this.subscribers.get(topic)!.push(listener);

        return () => {
            const list = this.subscribers.get(topic) || [];
            this.subscribers.set(topic, list.filter(l => l !== listener));
        };
    }

    private dispatch(msg: InteragentMessage): void {
        // Topic listeners
        const topicListeners = this.subscribers.get(msg.topic) || [];
        for (const listener of topicListeners) {
            try { listener(msg); } catch (err) { console.warn('[MessageChannel] Listener error:', err); }
        }

        // Wildcard / broadcast listeners
        const wildcard = this.subscribers.get('*') || [];
        for (const listener of wildcard) {
            try { listener(msg); } catch (err) { console.warn('[MessageChannel] Listener error:', err); }
        }
    }

    public getRecentMessages(count: number = 20): InteragentMessage[] {
        const msgs: InteragentMessage[] = [];
        const n = Math.min(this.size, count);
        for (let i = 0; i < n; i++) {
            const idx = (this.tail - 1 - i + this.capacity) % this.capacity;
            const msg = this.ringBuffer[idx];
            if (msg) msgs.push(msg);
        }
        return msgs;
    }

    public clear(): void {
        this.ringBuffer.fill(null);
        this.head = 0;
        this.tail = 0;
        this.size = 0;
        this.subscribers.clear();
    }
}
