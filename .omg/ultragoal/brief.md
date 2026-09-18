# Ultragoal Brief: Hierarchical Coordination, Hypothesis Validation, Versioned Knowledge Graph & Adaptive Learning Rates

## Objective
Introduce an advanced hierarchical coordination, hypothesis validation, and shared knowledge fabric for `@perfect-swarm/core`:
1. **Adaptive Learning Rates per Agent**: Compute per-agent learning rates ($\alpha_i$) using reward variance and success consistency to accelerate policy convergence.
2. **High-Bandwidth Interagent Communication**: Low-latency, delta-compressed message ring channels for instantaneous peer knowledge sharing.
3. **Hierarchical Task Decomposition**: High-level strategic planners decompose macro-goals into staged dependency DAGs for lower-level execution.
4. **Hierarchical Hypothesis Validation Layer**: Specialist agents formulate verifiable hypotheses; lead agents validate, refute, or prune them to eliminate redundant search.
5. **Shared Versioned Knowledge Graph**: Graph-based entity-relationship store (nodes, relations, confidence, evidence) with Lamport vector versioning and delta propagation.
6. **Reinforcement Learning Reward Shaping**: Curiosity-driven shaped reward balancing novel strategy exploration against proven tactic exploitation.

## Architecture Boundaries
- **Modules**:
  - `src/swarm/knowledgeGraph.ts`: Versioned knowledge graph with nodes, edges, delta changelogs, and subgraph search.
  - `src/swarm/coordination.ts`: Adaptive learning rate manager, high-bandwidth message channel, hierarchical task decomposer, hypothesis validation layer, and shaped reward optimizer.
- **Engine Integration**: Step 1-7 in `src/swarm/engine.ts` hooks into task decomposition, hypothesis validation, and knowledge graph graph updates.
- **Zero Runtime Dependencies**: Strict TypeScript conforming to Node.js built-ins.

## Verification Criteria
- Unit tests in `src/swarm/knowledgeGraph.test.ts` and `src/swarm/coordination.test.ts` validating graph queries, versioning, hypothesis validation, and learning rate adaptation.
- Integration tests in `src/swarm/coordination-engine.test.ts` validating end-to-end engine execution with hypothesis pruning and knowledge graph updates.
- Dual bundle builds (`build:client`, `build:swarm`), 100% pass across all Vitest and 5 E2E test suites, and clean linting.
