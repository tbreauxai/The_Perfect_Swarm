# Ultragoal Brief: Hierarchical Communication Layers

## Objective
Introduce hierarchical communication layers to reduce message overhead, eliminate O(N^2) broadcast explosion, and minimize inter-agent latency among swarm agents:
1. **Hierarchical Topology & Scoped Routing**: Establish structured multi-tier topology (Root Manager -> Cluster Leads / Aggregators -> Leaf Specialist Workers) with scoped routing (`local`, `cluster`, `upward`, `targeted`).
2. **In-Flight Message Deduplication & Semantic Compression**: Deduplicate redundant messages, filter irrelevant downward broadcasts, and distill cluster outputs into compact `ClusterDigest` summaries.
3. **Engine Integration & Latency Reduction**: Integrate hierarchical digests into workflow Step 4 (specialist execution) and Step 5/6 (critic and manager synthesis), drastically decreasing prompt token overhead and serialization latency.

## Architecture Boundaries & Constraints
1. **Zero Model Blacklists**: Never add or check any model ban lists. Any user-configured model is strictly valid.
2. **Strict User Model Preservation**: Never alter, override, or default model strings configured by the user in settings.
3. **Zero-Crash Worker Guarding**: All worker analyst outputs must flow through `guardAnalystResponse`.
4. **Fallback & Graceful Degradation**: If no cluster hierarchy is defined, the system must seamlessly treat all specialists as a flat cluster without errors.
5. **Non-Breaking Compatibility**: Maintain 100% backward compatibility across all 5 test suites (`test:portable`, `test:simulation`, `test:dist`, `test:cli`, `test:server`) and Vitest test suites.

## Micro-Goal Breakdown
1. `goal-1-hierarchical-communication-bus`: Implement `HierarchicalMessageBus`, `ClusterNode`, `CommunicationLayer`, and scoped message routing in `src/swarm/communication.ts`.
2. `goal-2-semantic-message-compression-and-dedup`: Implement in-flight message deduplication, cluster digest aggregation, and downward directive filtering.
3. `goal-3-engine-hierarchical-layer-integration-and-verification`: Integrate hierarchical communication into `src/swarm/engine.ts`, emit telemetry events, update UI timeline, and verify 100% across all test suites.
