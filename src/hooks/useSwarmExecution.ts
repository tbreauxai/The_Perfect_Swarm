import { useState, useRef } from 'react';
import type { SwarmTimelineEvent } from '../components/SwarmEventTimeline';
import type { AppSettings } from '../components/SettingsModal';
import { authHeaders } from '../services/appAuthHeaders';
import { parseHttpError } from '../services/httpError';
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
  const isRunningRef = useRef<boolean>(false);
  const activeRunIdRef = useRef<number>(0);

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
    isRunningRef.current = false;
    setLoading(false);
  };

  const toggleEvent = (id: string) => {
    setExpandedEvents(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const runSwarm = async (task: string, data: string, settings: AppSettings) => {
    // 1. In-flight guard: check and set boolean before ANY await
    if (isRunningRef.current) {
      return;
    }

    if (!task) {
      setError('Please provide a task.');
      return;
    }

    isRunningRef.current = true;
    const currentRunId = ++activeRunIdRef.current;

    // 2. AbortController setup: abort existing controller before creating new
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
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

    let abortReason: 'connect-timeout' | 'idle-timeout' | 'user' | null = null;
    let connectTimer: any = null;
    let idleTimer: any = null;

    const clearTimers = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    // Connect timer: ~30s to response headers
    connectTimer = setTimeout(() => {
      abortReason = 'connect-timeout';
      controller.abort();
    }, 30000);

    try {
      const response = await fetch('/api/swarm/stream', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ task, data, settings }),
        signal: controller.signal
      });

      // Headers arrived, clear connect timer
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }

      // 3. Non-OK branch: parseHttpError, throw its message (no raw HTML)
      if (!response.ok) {
        const parsed = await parseHttpError(response);
        throw new Error(parsed.message);
      }

      if (!response.body) {
        throw new Error('No response stream returned by server.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // 4. Stream reader loop: idle timeout reset on every chunk (generous 45s)
      const resetIdleTimeout = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          abortReason = 'idle-timeout';
          controller.abort();
        }, 45000);
      };

      resetIdleTimeout();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        resetIdleTimeout();

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
            } else if (eventType === 'swarm_partial') {
              // Explicitly ignore or consume swarm_partial events
              flushEventBuffer();
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
      // 5. Abort/catch handling: show timeout message distinct from user cancel
      if (err.name === 'AbortError' || controller.signal.aborted) {
        if (abortReason === 'connect-timeout') {
          setError('Connection timed out waiting for server response (30s).');
        } else if (abortReason === 'idle-timeout') {
          setError('Stream timed out waiting for swarm response (idle timeout).');
        } else {
          setError('Analysis cancelled by user.');
        }
      } else {
        setError(formatActionableError(err.message || 'An unexpected error occurred during execution.'));
      }
    } finally {
      clearTimers();
      flushEventBuffer();
      // 6. Reset loading/refs only if this run id is still current
      if (activeRunIdRef.current === currentRunId) {
        isRunningRef.current = false;
        setLoading(false);
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
      }
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
