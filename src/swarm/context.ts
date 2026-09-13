import type { SwarmEvent } from './types.ts';

export type SwarmEventListener = (event: SwarmEvent) => void;

/**
 * Observable execution context tracking events, timestamps, and model interactions across the swarm.
 */
export class SwarmContext {
    events: SwarmEvent[] = [];
    private listeners: SwarmEventListener[] = [];

    addEvent(event: Omit<SwarmEvent, 'id' | 'timestamp'>): SwarmEvent {
        const fullEvent: SwarmEvent = {
            ...event,
            id: Math.random().toString(36).substring(2, 9),
            timestamp: new Date().toISOString()
        };
        this.events.push(fullEvent);
        this.notify(fullEvent);
        return fullEvent;
    }

    onEvent(listener: SwarmEventListener): () => void {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter(l => l !== listener);
        };
    }

    subscribe(listener: SwarmEventListener): () => void {
        return this.onEvent(listener);
    }

    private notify(event: SwarmEvent) {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (err) {
                console.error('[SwarmContext] Listener error:', err);
            }
        }
    }

    clear() {
        this.events = [];
    }
}
