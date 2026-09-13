# Ultragoal Brief: Modular AI Swarm Foundation & Continuous Learning Perfection

## Mission Statement
This codebase serves as the foundation for a modular, portable AI swarm (`@perfect-swarm/core`) that can be uprooted and embedded into multiple downstream applications as a deep, accurate, and self-improving analysis engine. It strictly operates on free AI APIs (Gemini, Groq, OpenRouter `:free`, Mistral, GitHub Models) and free local deterministic tools, backed by an autonomous Qdrant learning cortex and zero-dependency in-memory vector fallback.

## Core Architectural Dimensions & Audit Scope
1. **File Structure & Decoupling**:
   - Zero leaks: `src/swarm/` must remain completely decoupled from React, Vite, Express, and UI DOM dependencies.
   - Dual distribution: ESM (`.js`), CommonJS (`.cjs`), and TypeScript declarations (`.d.ts`) exported in `dist/swarm/`.
   - Subpath exports: Clean modular imports (`@perfect-swarm/core`, `./tools`, `./memory`, `./engine`, `./router`, `./server`, etc.).

2. **AI Structure & Free Tool Execution**:
   - Guaranteed free-tier routing with OpenRouter `:free` auto-resolution and adaptive 429 cooldowns.
   - Zero-dependency tool and function calling framework (`src/swarm/tools/`) allowing agents to run deterministic free analysis tools (stats, regex, JSON queries, calculators).
   - Resilient AI JSON repair (`src/swarm/parser.ts`) ensuring zero runtime crashes from malformed, markdown-fenced, or truncated free LLM outputs.
   - Cross-provider Critic selection preventing self-affirmation bias.

3. **Qdrant Utilization & Continuous Learning**:
   - Hybrid dense (768d Cosine) + sparse (BM25 token frequency) vectors fused via configurable RRF weights.
   - Ephemeral in-memory vector fallback with shared collection stores for offline or zero-infrastructure operation.
   - Automated consolidation triggers (`qualityRating < 0.40` threshold pruning).
   - Portable Memory Snapshots (`exportMemories` / `importMemories`) allowing learned baselines and exemplars to be serialized, versioned, and transplanted across applications.

## Constraints
- Zero commercial API keys required; 100% functional on free tier and offline local fallback.
- Strictly pure TypeScript / Node.js standard library in `src/swarm/`.
- Strict typecheck (`tsc --noEmit`) with zero errors.
