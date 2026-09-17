# Ultragoal Brief: Dynamic Cluster Auto-Discovery & Rebalancing

## Objective
Introduce dynamic cluster auto-discovery, capability-based cluster lead election, and workload-aware pod rebalancing:
1. **Dynamic Cluster Auto-Discovery**: Automatically group specialist agents into affinity-based cluster pods dynamically according to task domain requirements and data chunk profiles rather than static regex matching.
2. **Capability-Driven Cluster Lead Election**: Elect cluster leads dynamically per pod based on RL capability scores (UCB1) and capacity headroom, promoting the most reliable and available node to aggregate and summarize cluster reports.
3. **Engine Topology Integration & Telemetry**: Wire dynamic topology discovery and cluster lead nodes into `HierarchicalMessageBus` and `src/swarm/engine.ts`, emitting topology rebalancing metrics in swarm events.
4. **Verification**: Verify auto-discovery, lead election, and rebalancing across unit tests, distribution builds, and all E2E verification suites.

## Architecture Boundaries & Constraints
1. **Zero Model Blacklists**: Never add or check any model ban lists. Any user-configured model is strictly valid.
2. **Strict User Model Preservation**: Never alter, override, or default model strings configured by the user in settings.
3. **Zero-Crash Worker Guarding**: All worker analyst outputs must flow through `guardAnalystResponse`.
4. **Fallback & Backward Compatibility**: If dynamic clustering produces empty or single-node clusters, degrade gracefully to default pod topologies without throwing errors.
5. **Non-Breaking Compatibility**: Maintain 100% backward compatibility across all test suites (`test:portable`, `test:simulation`, `test:dist`, `test:cli`, `test:server`) and Vitest test suites.

## Micro-Goal Breakdown
1. `goal-1-cluster-topology-manager-and-lead-election`: Implement `ClusterTopologyManager`, dynamic domain grouping, and capability/capacity-based cluster lead election in `src/swarm/communication.ts` with comprehensive unit tests.
2. `goal-2-engine-topology-integration-and-rebalancing`: Wire dynamic topology discovery into `src/swarm/engine.ts` (Step 4), registering elected cluster leads in `HierarchicalMessageBus` and routing upward digests through leads.
3. `goal-3-verification-and-bundle-build`: Rebuild distribution bundles, add integration tests in `engine-routing.test.ts`, and verify 100% pass rate across all Vitest and E2E suites.
