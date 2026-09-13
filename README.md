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
- 🛠️ **Zero-Dependency Free Tool & Function Calling**: Deterministic tool execution engine (`calculator`, `stats_summary`, `regex_match`, `json_extract`, plus custom tools) without any external libraries.
- 💾 **Portable Memory Snapshots & Cross-App Hydration**: One-line `exportMemories` and `importMemories` supporting JSON/JSONL format, target app ID remapping, vector preservation, and semantic deduplication.
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
import { ToolRegistry, calculatorTool, statsSummaryTool, regexMatchTool, jsonExtractTool } from '@perfect-swarm/core/tools';

const registry = new ToolRegistry();
registry.register(calculatorTool);
registry.register(statsSummaryTool);

// Execute tool directly
const stats = await registry.execute('stats_summary', { values: [10, 25, 45, 90, 110] });
console.log(stats.result); // { count: 5, sum: 280, mean: 56, median: 45, min: 10, max: 110, ... }

// SwarmEngine automatically parses and executes tool calls emitted by LLM agents:
// ```tool_call
// {"tool": "calculator", "parameters": {"expression": "((150 * 4) / 2) + 25"}}
// ```
```

### 5. Portable Memory Snapshots & Cross-App Hydration

```typescript
import { MemoryCortex } from '@perfect-swarm/core/memory';

const sourceCortex = new MemoryCortex({ defaultAppId: 'app-source' });

// Export verified baselines and high-quality exemplars (JSON or JSONL)
const snapshot = await sourceCortex.exportMemories({ minRating: 0.8 });
const jsonlData = await sourceCortex.exportJsonl({ minRating: 0.8 });

// Transplant and hydrate into another app with automatic appId remapping & deduplication
const targetCortex = new MemoryCortex({ defaultAppId: 'app-target' });
await targetCortex.importMemories(jsonlData, {
  targetAppId: 'app-target',
  deduplicate: true
});
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
npm run test:portable     # 24 portability, tool execution, snapshot, & JSON repair tests
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
| `@perfect-swarm/core/engine` | Core orchestration engine and workflow executor |
| `@perfect-swarm/core/server` | Zero-dependency HTTP & SSE streaming server |
| `@perfect-swarm/core/tools` | Zero-dependency free tool registry & deterministic analysis tools |
| `@perfect-swarm/core/parser` | Resilient zero-drift AI JSON repair and schema guards |
| `@perfect-swarm/core/memory` | Qdrant & in-memory hybrid RRF vector cortex |
| `@perfect-swarm/core/router` | Complexity classifier and model router |
| `@perfect-swarm/core/lifecycle` | RLAIF evaluation & verification loops |
| `@perfect-swarm/core/cache` | Deterministic payload LRU cache |
| `@perfect-swarm/core/hierarchy` | Hierarchical gatekeeping & scoped event broadcasting |
| `@perfect-swarm/core/loadBalancer` | Adaptive EMA latency and 429 cooldown load balancer |
| `@perfect-swarm/core/profiler` | Token chunking and data profiling utilities |

---

## 📜 License

MIT © [tbreauxai](https://github.com/tbreauxai)
