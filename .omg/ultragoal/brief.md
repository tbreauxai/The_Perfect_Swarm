# Ultragoal Brief: Hierarchical Agent Specialization with Dynamic Routing

## Objective
Implement hierarchical agent specialization with dynamic routing based on task complexity and domain expertise across multi-tier specialist trees to optimize resource allocation, prevent cognitive overload, and enable autonomous delegation and escalation.

## Background & Problem Statement
In multi-agent systems, flat coordination architectures become inefficient as team size and task complexity scale:
1. Manager nodes suffer from cognitive bottlenecks when directly coordinating dozens of heterogeneous specialist agents.
2. Flat task routing maps chunks without considering hierarchical capability tiers (e.g. generalist leads vs deep sub-specialists vs deterministic leaf operators).
3. Complex multi-domain tasks (e.g. security breach analysis requiring memory forensics, network analysis, and legal compliance) require structured hierarchical delegation where domain leads direct sub-specialists and synthesize localized findings before reporting upwards.
4. Trivial tasks waste high-tier reasoning capacity if not routed directly to low-complexity leaf specialists or tools.

## Architecture Boundaries
1. **Hierarchical Specialization Engine (`src/swarm/hierarchy.ts`)**:
   - `HierarchicalSpecialistTree`: Directed multi-tier agent tree:
     - Tier 0: Root Coordinator / Manager Node.
     - Tier 1: Domain Cluster Leads / Lead Architects.
     - Tier 2: Specialized Deep Analysts.
     - Tier 3: Leaf Micro-Agents / Deterministic Tool Operators.
   - `HierarchicalRouter`:
     - Multi-factor dynamic routing score:
       `Score = (DomainExpertise * 0.40) + (ComplexityFitness * 0.30) + (HistoricalSuccessRL * 0.20) + (CapacityHeadroom * 0.10)`
     - Dynamic task decomposition by complexity (`trivial`, `moderate`, `complex`, `critical`) and domain taxonomy.
     - Delegation and escalation protocol (downward subtask delegation, upward anomaly escalation, lateral cross-cluster consultation).
2. **Swarm Engine Integration (`src/swarm/engine.ts` & `src/swarm/types.ts`)**:
   - Add `SwarmHierarchySettings` to `SwarmEngineSettings`.
   - Dynamically build and evaluate hierarchical agent tree based on configured agents and discovered topology.
   - Dispatch tasks hierarchically through cluster leads to deep specialists.
   - Emit telemetry events: `Hierarchical Routing Plan`, `Specialist Delegation`, `Specialist Escalation`.
   - Record hierarchical execution metrics (treeDepth, tiersEngaged, delegatedCount, escalationCount) in `SwarmWorkflowResult`.
3. **Distribution & Backward Compatibility**:
   - Zero external runtime dependencies (pure TypeScript algorithmic hierarchy).
   - Subpath export `@perfect-swarm/core/hierarchy`.
   - Dual ESM/CJS distribution bundles with TypeScript declarations.
   - 100% passing Vitest suites and all 5 E2E test scripts.
