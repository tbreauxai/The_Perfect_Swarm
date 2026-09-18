# Ultragoal: Tiered Caching and State-Compression (Vector Quantization, Selective Snapshotting)

## Objective
Implement a multi-tier cache hierarchy (L1 Hot Memory LRU, L2 Warm Semantic, L3 Cold Compressed Persistence), Vector Quantization (SQ8 scalar quantization, 1-bit sign binary quantization, sub-byte vector compression, asymmetric distance computation), and Selective State Snapshotting (delta-state serialization, dictionary state compression, hydration) for @perfect-swarm/core with zero external runtime dependencies.

## Key Architecture Boundaries & Requirements
1. **Multi-Tier Cache Hierarchy (L1 / L2 / L3)**:
   - **L1 Hot LRU**: Sub-millisecond exact key lookup with configurable capacity and LRU eviction.
   - **L2 Warm Semantic Cache**: Vector similarity thresholding (e.g. cosine/dot-product >= 0.88) with quantized vector indexes.
   - **L3 Cold Persistent Cache**: Selective serialized state storage with dictionary compression and snapshot hydration.
   - Dynamic promotion (L2/L3 -> L1) and demotion (L1 -> L2 -> L3) on access.
2. **Vector Quantization Engine**:
   - **Scalar Quantization (SQ8)**: Maps 32-bit floats into 8-bit unsigned integers with scaling factor and offset (4x memory reduction).
   - **Binary Sign Quantization (1-bit)**: Maps vector dimensions into binary bitmasks for ultra-fast Hamming distance evaluation (32x memory reduction).
   - **Asymmetric Distance Computation (ADC)**: Compares unquantized query vectors against quantized stored codebooks with high accuracy.
3. **Selective Snapshotting & State Compression**:
   - Delta snapshots: Serializes only mutated agent memories, new anomalies, and delta telemetry rather than full history.
   - Replay and hydration: Reconstructs active swarm state from base snapshot + ordered deltas.
4. **Integration & Telemetry**:
   - Wires tiered cache into `src/swarm/engine.ts` and `src/swarm/types.ts`.
   - Emits `Tiered Cache Event` and `State Snapshot Compressed` telemetry.
   - Exports `@perfect-swarm/core/tieredCache` subpath in ESM, CommonJS, and TypeScript definitions.
   - 100% test passing across all Vitest suites and 5 E2E test suites.
