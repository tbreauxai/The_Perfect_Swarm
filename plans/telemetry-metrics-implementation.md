# Telemetry Metrics Implementation Plan

## Overview

Add a live telemetry metrics endpoint at `GET /api/swarm/metrics` for the AI Swarm Optimizer dashboard.

## Requirements

1. **Request Latency Tracking**: Middleware/hook tracking latency (avg, p95, p99) across sliding window of last 500 requests
2. **Request Counts**: Total, successes, failures
3. **LLM Token Tracker**: Capture prompt/completion tokens from model responses, accumulate totalTokensBurned and estimatedCostUsd
4. **Expose GET /api/swarm/metrics** returning JSON schema:

```json
{
  "totalRequests": <int>,
  "successCount": <int>,
  "failureCount": <int>,
  "totalTokensBurned": <int>,
  "promptTokens": <int>,
  "completionTokens": <int>,
  "estimatedCostUsd": <float>,
  "overallLatency": {
    "mean": <float>,
    "p95": <float>,
    "p99": <float>
  },
  "cacheHitRatio": <float>,
  "errorRate": <float>
}
```

5. **Public Access**: Route must be publicly reachable/exempt from strict auth

## Architecture

### 1. New Telemetry Module (`src/swarm/telemetry.ts`)

Create a new `TelemetryMetricsCollector` class with:

- Sliding window (500 requests) for latency percentiles
- Request counters (total, success, failure)
- LLM token tracking (prompt, completion, total, cost estimation)
- Cache hit ratio tracking
- `getSnapshot()` method returning required schema

### 2. Provider Adapter Integration

Modify provider adapters to capture token usage:

- **Gemini**: Extract from `response.usageMetadata`
- **Groq/OpenRouter/Mistral/GitHub**: Extract from `response.usage` (OpenAI-compatible)
- Fallback: Estimate tokens from text length (1 token ≈ 4 chars)

### 3. Server Integration (`src/swarm/server.ts`)

- Add telemetry middleware to track all request latencies
- Expose `GET /api/swarm/metrics` endpoint (already exists but returns different format)
- Ensure endpoint is publicly accessible (no auth middleware)

### 4. Cache Metrics Integration

- Sync cache metrics from existing `globalPayloadCache`, `globalSemanticCache`, `globalTieredCache`
- Aggregate hit/miss counts for cacheHitRatio

## Implementation Steps

### Step 1: Create Telemetry Module

- [ ] Create `src/swarm/telemetry.ts` with `TelemetryMetricsCollector`
- [ ] Implement sliding window latency tracking (500 samples)
- [ ] Implement token tracking with cost estimation
- [ ] Implement cache hit ratio tracking
- [ ] Export `globalTelemetryCollector` singleton
- [ ] Export middleware factory `createTelemetryMiddleware`
- [ ] Export helper functions for token extraction

### Step 2: Update Provider Adapters

- [ ] Update `src/swarm/providers/gemini.ts` to capture token usage
- [ ] Update `src/swarm/providers/groq.ts` to capture token usage
- [ ] Update `src/swarm/providers/openrouter.ts` to capture token usage
- [ ] Update `src/swarm/providers/mistral.ts` to capture token usage
- [ ] Update `src/swarm/providers/github.ts` to capture token usage
- [ ] Update `src/swarm/providers/simulated.ts` (if exists)

### Step 3: Update Server

- [ ] Import telemetry module in `src/swarm/server.ts`
- [ ] Apply telemetry middleware to all routes (or at least swarm routes)
- [ ] Update `GET /api/swarm/metrics` to return new schema from `globalTelemetryCollector.getSnapshot()`
- [ ] Ensure endpoint is before any auth middleware

### Step 4: Integrate Cache Metrics

- [ ] Add periodic sync or hook to update cache metrics in telemetry collector
- [ ] Aggregate hits/misses from all cache layers

### Step 5: Build and Verify

- [ ] Run TypeScript compilation check
- [ ] Test endpoint returns correct schema
- [ ] Verify latency tracking works
- [ ] Verify token tracking works
- [ ] Verify cache hit ratio works

## Cost Estimation Rates (per 1K tokens)

| Provider   | Prompt    | Completion |
| ---------- | --------- | ---------- |
| gemini     | $0.000075 | $0.0003    |
| groq       | $0.00     | $0.00      |
| openrouter | $0.0001   | $0.0003    |
| mistral    | $0.00025  | $0.00025   |
| github     | $0.00     | $0.00      |
| simulated  | $0.00     | $0.00      |
| default    | $0.00015  | $0.0006    |

## Files to Modify

1. `src/swarm/telemetry.ts` (NEW)
2. `src/swarm/providers/gemini.ts`
3. `src/swarm/providers/groq.ts`
4. `src/swarm/providers/openrouter.ts`
5. `src/swarm/providers/mistral.ts`
6. `src/swarm/providers/github.ts`
7. `src/swarm/server.ts`

## Testing

- Start server and hit `/api/swarm/metrics` - should return JSON with all fields
- Make requests to `/api/swarm/stream` and `/api/swarm/analyze` - verify metrics update
- Check that p95/p99 calculate correctly after multiple requests
- Verify token counts increment on LLM calls
