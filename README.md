# The Perfect Swarm (`@perfect-swarm/core`)

> Modular, portable, zero-overhead AI Swarm with continuous Qdrant learning cortex and guaranteed free-tier LLM calibration.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)

---

## 🌟 Overview

**The Perfect Swarm** is an autonomous multi-agent intelligence runtime designed to be embedded into any TypeScript or JavaScript application. It orchestrates specialized analyst agents under a manager node to perform deep, structured analysis on complex tasks, synthesize generative UI components, and continuously learn from AI feedback (RLAIF).

### Key Features

- 🆓 **100% Free-Tier Calibrated**: Engineered for zero-cost operation across free LLM endpoints (Gemini 2.5 Flash, Groq LLaMA 3.3 70B, OpenRouter free models with automatic `:free` suffix resolution, Mistral Small, and GitHub Models).
- 🧠 **Continuous Qdrant & In-Memory Learning Cortex**: Semantic vector memory with dense (768d) + sparse (BM25 token frequency) hybrid Reciprocal Rank Fusion (RRF), configurable `denseWeight` and `sparseWeight`, verified payload indexing (`verified: bool`), automated memory consolidation triggers (`qualityRating < 0.40`), and cross-app shared learning baselines (`includeShared`).
- ⚡ **Zero-Qdrant In-Memory Persistence**: Unconditional MemoryCortex binding with fallback store sharing per collection, semantic deduplication, and few-shot exemplar distillation working 100% offline without external infrastructure.
- 🔄 **Cross-Provider Critic & RLAIF Feedback Loop**: Automated verification loops dynamically select alternative provider analysts as critics to eliminate LLM self-affirmation bias, scores agent outputs, and captures verified feedback across multi-session executions.
- 🏎️ **Fast-Path & Zero-Drift LRU Caching**: Instant sub-millisecond classification and caching for trivial or recurring payloads, saving 100% of LLM tokens and auto-persisting validated heuristics.
- 🛠️ **Zero-Dependency Free Tool & Function Calling**: Deterministic tool execution engine (`calculator`, `stats_summary`, `regex_match`, `json_extract`, `data_filter`, `string_similarity`, `date_math`) without any external libraries.
- 🎯 **Critic Context Awareness & Historical Baseline Enforcement**: Automatic injection of past verified lessons and SLA baselines directly into the Critic prompt to prevent regression and drift.
- 📁 **Transparent Local File Persistence (`persistPath`)**: Point `MemoryCortex` to a local file path (`.json` or `.jsonl`) for zero-configuration, auto-persisting vector memory across restarts.
- 💾 **Portable Memory Snapshots & Cross-App Hydration**: One-line `exportMemories`, `importMemories`, `saveToFile`, and `loadFromFile` supporting JSON/JSONL format, target app ID remapping, vector preservation, and semantic deduplication.
- 🛡️ **Resilient Zero-Drift AI JSON Repair & Schema Guard**: Zero-crash parsing engine (`repairJson`, `parseJsonSafe`, domain schema guards) immune to markdown fences, reasoning `<think>` tags, unquoted keys, Python literals, trailing commas, comments, and truncated outputs.
- 📦 **Dual ESM & CommonJS Bundles**: Seamless imports across modern ESM (`import`) and legacy CommonJS (`require`), complete with TypeScript declaration (`.d.ts`) files.
- 💻 **CLI Utility**: `npx perfect-swarm doctor`, `init <appName>`, and `run "<task>"` for instant scaffolding and headless execution.
- 📡 **Zero-Dependency Streaming Server**: Built-in HTTP and Server-Sent Events (SSE) server for streaming live swarm reasoning events directly to frontends.

---

## 🚀 Quick Start

### Installation

```bash
npm install @perfect-swarm/core
```

Or install from the local tarball:

```bash
npm install ./perfect-swarm-core-1.0.0.tgz
```

---

## 💻 CLI Usage

The package exposes the `perfect-swarm` command-line executable:

```bash
# Verify environment keys and local dependencies
npx perfect-swarm doctor

# Scaffold a new autonomous swarm worker in your app
npx perfect-swarm init ./my-analysis-app

# Execute a headless swarm task directly from your terminal
npx perfect-swarm run "Analyze transaction volume anomalies" --mock

# Export memory snapshots from MemoryCortex to JSON or JSONL
npx perfect-swarm export-memory --app my-app --out snapshot.jsonl --min-rating 0.85

# Import and hydrate memory snapshots into another target application
npx perfect-swarm import-memory snapshot.jsonl --target-app downstream-app
```

---

## 📖 Programmatic API

### 1. Headless Swarm Execution

```typescript
import { executeSwarmWorkflow } from '@perfect-swarm/core';

const result = await executeSwarmWorkflow({
  task: 'Perform root cause analysis of memory spikes',
  data: 'node-1: 98% RAM, node-2: 42% RAM, gc_pause: 620ms',
  settings: {
    appId: 'monitoring-app',
    agents: [
      { id: 'mgr', role: 'Manager Node', provider: 'openrouter', model: 'deepseek/deepseek-r1:free', apiKey: process.env.OPENROUTER_API_KEY },
      { id: 'a1', role: 'Infrastructure Analyst', provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey: process.env.GROQ_API_KEY }
    ]
  },
  onEvent: (event) => {
    console.log(`[${event.agentRole}] ${event.action} (${event.durationMs || 0}ms)`);
  }
});

console.log(result.finalAnalysis);
```

### 2. Zero-Dependency HTTP & SSE Streaming Server

```typescript
import { createSwarmServer } from '@perfect-swarm/core/server';

const server = createSwarmServer({
  port: 3000,
  cors: true,
  defaultSettings: {
    appId: 'production-service'
  }
});

server.listen(3000, () => {
  console.log('Swarm SSE Server running on http://localhost:3000');
});
```

#### Endpoints:
- `GET /api/health` - Server health ping.
- `POST /api/swarm/stream` - SSE streaming endpoint (`event: swarm_event`, `event: swarm_complete`).
- `POST /api/swarm/analyze` - Standard synchronous JSON response.

### 3. Continuous Memory Cortex & Vector Retrieval

```typescript
import { MemoryCortex } from '@perfect-swarm/core/memory';

const cortex = new MemoryCortex({
  url: process.env.QDRANT_URL, // Defaults to in-memory fallback if omitted
  defaultAppId: 'ecommerce-fraud'
});

// Store verified high-quality knowledge
await cortex.store('Credit card chargeback rate doubled on merchant ID 4409', {
  domain: 'security',
  agentRole: 'Fraud Analyst',
  qualityRating: 0.98,
  verified: true
});

// Hybrid vector search (dense + sparse BM25 RRF)
const memories = await cortex.retrieve('chargeback spikes', {
  appId: 'ecommerce-fraud',
  limit: 5
});
```

### 4. Zero-Dependency Free Tool & Function Calling

```typescript
import { 
  ToolRegistry, 
  calculatorTool, 
  statsSummaryTool, 
  regexMatchTool, 
  jsonExtractTool,
  dataFilterTool,
  stringSimilarityTool,
  dateMathTool
} from '@perfect-swarm/core/tools';

const registry = new ToolRegistry([
  calculatorTool,
  statsSummaryTool,
  dataFilterTool,
  stringSimilarityTool,
  dateMathTool
]);

// Execute deterministic filtering and sorting on datasets:
const filtered = await registry.execute('data_filter', {
  items: [{ id: 1, latency: 120 }, { id: 2, latency: 450 }],
  field: 'latency',
  operator: '>',
  value: 100,
  sortBy: 'latency',
  sortOrder: 'desc'
});

// Compute string similarity across metrics (Jaccard and Levenshtein):
const sim = await registry.execute('string_similarity', {
  stringA: 'redis cache timeout',
  stringB: 'redis connection timeout',
  metric: 'all'
});

// Perform date and duration math:
const diff = await registry.execute('date_math', {
  startDate: '2026-09-13T12:00:00Z',
  endDate: '2026-09-13T10:00:00Z',
  unit: 'hours'
});
```

### 5. Transparent File Persistence & Portable Memory Snapshots

```typescript
import { MemoryCortex } from '@perfect-swarm/core/memory';

// 1. Transparent local auto-persistence across restarts:
const cortex = new MemoryCortex({
  defaultAppId: 'my-app',
  persistPath: './data/cortex-memory.json',
  autoSave: true // automatically saves on store, rate, consolidate, and import
});
await cortex.initialize(); // auto-loads existing snapshots on disk

// 2. Direct snapshot export and import:
await cortex.saveToFile('./backups/snapshot.jsonl');
await cortex.loadFromFile('./backups/snapshot.jsonl', { deduplicate: true });

// 3. In-memory programmatic transfer between apps:
const jsonlData = await cortex.exportJsonl({ minRating: 0.8 });
const targetCortex = new MemoryCortex({ defaultAppId: 'downstream-app' });
await targetCortex.importMemories(jsonlData, { targetAppId: 'downstream-app', deduplicate: true });
```

### 6. Resilient Zero-Drift AI JSON Repair & Schema Guards

```typescript
import { repairJson, parseJsonSafe, guardAnalystResponse } from '@perfect-swarm/core/parser';

// Cleanly repairs thinking tags, markdown fences, unquoted keys, Python literals, trailing commas, and truncations:
const malformedLLMOutput = `
<think>Analyzing...</think>
\`\`\`json
{
  summary: 'Analysis completed',
  insights: [ 'Healthy metrics', 'No drift', ],
  active: True,
  payload: None,
}
\`\`\`
`;

const parsed = parseJsonSafe(malformedLLMOutput);
console.log(parsed.active); // true
console.log(parsed.payload); // null
```

### 7. Unified Multi-App Swarm Client SDK

```typescript
import { createSwarmClient } from '@perfect-swarm/core/client';

// Embedded execution mode:
const embeddedClient = createSwarmClient({
  mode: 'embedded',
  appId: 'analytics-worker'
});

// Direct analysis execution:
const result = await embeddedClient.analyze({
  task: 'Audit system resource allocation',
  data: 'metrics=load:0.4'
});
console.log(result.finalAnalysis);

// Live async iterator streaming:
for await (const chunk of embeddedClient.stream({ task: 'Continuous monitor' })) {
  if (chunk.type === 'event') console.log(`[${chunk.event?.agentRole}] ${chunk.event?.action}`);
  if (chunk.type === 'complete') console.log('Finished:', chunk.finalAnalysis);
}

// Remote HTTP/SSE server mode:
const remoteClient = createSwarmClient({
  mode: 'remote',
  endpoint: 'http://localhost:3000'
});
```

### 8. Pre-Calibrated RRF Presets & Continuous Learning Hooks

```typescript
import { MemoryCortex, RRF_PRESETS } from '@perfect-swarm/core/memory';
import { SwarmEngine } from '@perfect-swarm/core/engine';

const cortex = new MemoryCortex({ defaultAppId: 'trading-app' });

// Query with pre-calibrated RRF profiles:
// RRF_PRESETS.semantic (dense: 0.85, sparse: 0.15)
// RRF_PRESETS.lexical  (dense: 0.15, sparse: 0.85)
// RRF_PRESETS.balanced (dense: 0.50, sparse: 0.50)
// RRF_PRESETS.hybrid   (dense: 0.70, sparse: 0.30)
const results = await cortex.retrieve('order execution latency', {
  rrfProfile: RRF_PRESETS.semantic
});

// Hook into real-time continuous learning captures:
const engine = new SwarmEngine({
  cortex,
  onMemoryLearned: (event) => {
    console.log(`[Learned Memory] App: ${event.appId}, Verified: ${event.metadata.verified}, Task: ${event.metadata.task}`);
  }
});
```

---

## 🐳 Docker Deployment

Run the headless Swarm streaming server and a persistent Qdrant cluster with Docker Compose:

```bash
# Configure API keys
cp .env.example .env

# Launch services
docker compose up -d
```

---

## 🧪 Testing

The repository contains a full battery of automated tests:

```bash
# Run all test suites
npm test

# Run specific suites
npm run test:portable     # 26 portability, extended tools, critic baselines, & file persistence tests
npm run test:simulation   # 7-phase multi-app stress test
npm run test:dist         # ESM and CommonJS bundle checks
npm run test:cli          # CLI utility tests
npm run test:server       # HTTP & SSE streaming tests
```

---

## 📄 Subpath Exports

| Export Path | Description |
| --- | --- |
| `@perfect-swarm/core` | Complete swarm library exports |
| `@perfect-swarm/core/client` | Unified multi-app Swarm Client SDK for embedded execution & remote SSE streaming |
| `@perfect-swarm/core/engine` | Core orchestration engine and workflow executor |
| `@perfect-swarm/core/server` | Zero-dependency HTTP & SSE streaming server |
| `@perfect-swarm/core/tools` | Zero-dependency free tool registry & deterministic analysis tools |
| `@perfect-swarm/core/parser` | Resilient zero-drift AI JSON repair and schema guards |
| `@perfect-swarm/core/memory` | Qdrant & in-memory hybrid RRF vector cortex |
| `@perfect-swarm/core/router` | Complexity classifier and model router |
| `@perfect-swarm/core/lifecycle` | RLAIF evaluation & verification loops |
| `@perfect-swarm/core/cache` | Semantic similarity engine & deterministic payload LRU cache |
| `@perfect-swarm/core/loadBalancer` | Adaptive EMA latency, capacity slots, and 429 cooldown load balancer |
| `@perfect-swarm/core/profiler` | Token chunking and data profiling utilities |
| `@perfect-swarm/core/communication` | Hierarchical message bus, cluster topology manager, and digest compression |
| `@perfect-swarm/core/vectorIndex` | O(log n) VP-Tree and HNSW sub-linear metric vector indexing |
| `@perfect-swarm/core/speculative` | Speculative parallel execution, dependency DAGs, and conflict resolution |
| `@perfect-swarm/core/experiment` | Continuous learning loops, automated A/B testing, and statistical promotion |

---

## 📜 License

MIT © [tbreauxai](https://github.com/tbreauxai)
