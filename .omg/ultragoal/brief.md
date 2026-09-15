# Objective
Perform a full audit of the codebase for errors, regressions, broken assertions, build/packaging issues, and runtime hazards across both backend/swarm core and frontend UI.

## Context and Scope
- **Core Engine & Architecture**: Swarm orchestration, model routing (Gemini, Groq, OpenRouter, Mistral, GitHub), Qdrant memory/caching, hierarchical agents, and load balancing.
- **Packaging & Exports**: Multi-target dual ESM/CJS distribution (`@perfect-swarm/core`), CLI binary, and tsx/vite configs.
- **Test Suites**: Portable swarm test suite, multi-app simulation, dist import test, CLI test, and SSE server test.
- **Frontend & Server**: React 19 UI, Vite 6, Tailwind CSS v4, Express server, SSE streaming, and provider model fetching.

## Boundaries & Constraints
- Systematic verification-first approach: inspect tests, builds, static typing, and core module logic.
- Document all identified bugs, edge cases, and architectural discrepancies before or alongside remediation.
- Maintain Conductor track alignment and SDD principles.
