# Ultragoal Brief: Adaptive Load Balancing Based on Node Capacity

## Objective
Implement adaptive load balancing across the swarm to allocate tasks and data chunks based on real-time node capacity, concurrency limits, and dynamic saturation metrics:
1. **Node Capacity Management**: Track per-agent/node max concurrency limits, in-flight workloads, and dynamic capacity headroom.
2. **Capacity-Aware Task Allocation**: Adaptively route task chunks based on node capacity headroom, preventing bottleneck saturation and spilling over to healthy nodes.
3. **Engine Slot Lifecycle & Telemetry**: Enforce slot acquisition/release lifecycle in workflow execution and emit node capacity telemetry.

## Architecture Boundaries & Constraints
1. **Zero Model Blacklists**: Never add or check any model ban lists. Any user model is strictly valid.
2. **Strict User Model Preservation**: Never alter, override, or default model strings configured by the user in settings.
3. **Zero-Crash Worker Guarding**: All specialist outputs must flow through `guardAnalystResponse`.
4. **Leak-Free Slot Acquisition**: Node capacity slots must always be released in `try...finally` guards on both success and failure.
5. **Non-Breaking Compatibility**: Maintain 100% backward compatibility across all 5 test suites (`test:portable`, `test:simulation`, `test:dist`, `test:cli`, `test:server`) and Vitest test suites.

## Micro-Goal Breakdown
1. `goal-1-node-capacity-manager`: Implement `NodeCapacityManager` in `src/swarm/loadBalancer.ts` to model per-node concurrency limits, track active in-flight requests, and calculate real-time node capacity headroom.
2. `goal-2-capacity-aware-routing`: Extend `SpecialistAffinityRouter` in `src/swarm/loadBalancer.ts` to schedule tasks based on node capacity headroom, preventing saturation and dynamically spilling over to available nodes.
3. `goal-3-engine-slot-lifecycle-and-verification`: Integrate node capacity slot acquisition and release into `src/swarm/engine.ts` (Step 4), emit node capacity telemetry events, and verify across all test suites.
