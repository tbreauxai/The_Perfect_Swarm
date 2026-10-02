import { useState, useRef } from 'react';
import type { SwarmTimelineEvent } from '../components/SwarmEventTimeline';
import type { AppSettings } from '../components/SettingsModal';
import { formatActionableError } from '../swarm/types';

export function useSwarmExecution() {
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<SwarmTimelineEvent[]>([]);
  const [finalAnalysis, setFinalAnalysis] = useState<any>(null);
  const [progressiveStage, setProgressiveStage] = useState<{
    stage: string;
    digests?: Record<string, any>;
    metrics?: any;
  } | null>(null);
  const [error, setError] = useState('');
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>({});

  const abortControllerRef = useRef<AbortController | null>(null);
  const eventBufferRef = useRef<SwarmTimelineEvent[]>([]);
  const rafIdRef = useRef<number | null>(null);

  const flushEventBuffer = () => {
    if (eventBufferRef.current.length > 0) {
      const buffered = [...eventBufferRef.current];
      eventBufferRef.current = [];
      setEvents(prev => [...prev, ...buffered]);
    }
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  };

  const cancelSwarm = () => {
    flushEventBuffer();
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  const toggleEvent = (id: string) => {
    setExpandedEvents(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const runSwarm = async (task: string, data: string, settings: AppSettings) => {
    if (!task) {
      setError('Please provide a task.');
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setLoading(true);
    setError('');
    eventBufferRef.current = [];
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    setEvents([]);
    setFinalAnalysis(null);
    setProgressiveStage(null);

    let safeData = data;
    if (safeData.length > 500000) {
      safeData = safeData.substring(0, 500000) + "\n...[TRUNCATED TO 500KB FOR NETWORK/MEMORY SAFETY]...";
    }

    try {
      const response = await fetch('/api/swarm/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, data: safeData, settings }),
        signal: controller.signal
      });

      if (!response.ok) {
        let errorMsg = 'Failed to execute swarm.';
        const errorText = await response.text();
        try {
          const errorData = JSON.parse(errorText);
          errorMsg = errorData.error || errorMsg;
        } catch {
          errorMsg = `Server Error (${response.status}): ${errorText.substring(0, 100)}...`;
        }
        throw new Error(errorMsg);
      }

      if (!response.body) {
        throw new Error('No response stream returned by server.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const block of lines) {
          if (!block.trim() || block.startsWith(':')) continue;

          let eventType = 'message';
          let dataStr = '';

          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) {
              eventType = line.replace('event:', '').trim();
            } else if (line.startsWith('data:')) {
              dataStr = line.replace('data:', '').trim();
            }
          }

          if (!dataStr) continue;

          try {
            const parsedData = JSON.parse(dataStr);
            if (eventType === 'swarm_event') {
              const truncatedEvent = parsedData && typeof parsedData === 'object' && typeof parsedData.prompt === 'string'
                ? { ...parsedData, prompt: parsedData.prompt.slice(0, 800) }
                : parsedData;
              eventBufferRef.current.push(truncatedEvent);
              if (rafIdRef.current === null) {
                rafIdRef.current = requestAnimationFrame(() => {
                  flushEventBuffer();
                });
              }
            } else if (eventType === 'swarm_stage') {
              flushEventBuffer();
              setProgressiveStage(parsedData);
            } else if (eventType === 'swarm_complete') {
              flushEventBuffer();
              setProgressiveStage(null);
              if (parsedData.finalAnalysis) {
                setFinalAnalysis(parsedData.finalAnalysis);
              }
              if (parsedData.events && Array.isArray(parsedData.events)) {
                const truncatedEvents = parsedData.events.map((e: any) =>
                  e && typeof e === 'object' && typeof e.prompt === 'string'
                    ? { ...e, prompt: e.prompt.slice(0, 800) }
                    : e
                );
                setEvents(truncatedEvents);
              }
            } else if (eventType === 'swarm_error') {
              flushEventBuffer();
              setError(formatActionableError(parsedData.error || 'Swarm execution error'));
            }
          } catch (err) {
            console.warn('Error parsing SSE block:', err, block);
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setError('Analysis cancelled by user.');
      } else {
        setError(formatActionableError(err.message || 'An unexpected error occurred during execution.'));
      }
    } finally {
      flushEventBuffer();
      setLoading(false);
      abortControllerRef.current = null;
    }
  };

  return {
    loading,
    events,
    finalAnalysis,
    progressiveStage,
    error,
    expandedEvents,
    toggleEvent,
    runSwarm,
    cancelSwarm
  };
}
