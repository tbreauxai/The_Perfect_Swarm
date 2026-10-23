import { runSwarmBenchmark } from '../../dist/swarm/profiler.js';

export async function runProfile(rawArgs) {
    let iterations = 20;
    let batchSize = 5;

    for (let i = 0; i < rawArgs.length; i++) {
        if (rawArgs[i] === '--iterations' && rawArgs[i + 1]) {
            iterations = parseInt(rawArgs[i + 1], 10);
            i++;
        } else if (rawArgs[i] === '--batch-size' && rawArgs[i + 1]) {
            batchSize = parseInt(rawArgs[i + 1], 10);
            i++;
        }
    }

    console.log(`\n=== Perfect Swarm Baseline Profiler & Synthetic Benchmark ===\n`);
    console.log(`Executing baseline workload sweep (${iterations} iterations, ${batchSize} batch tasks per iteration)...`);

    const bench = await runSwarmBenchmark({ iterations, batchSize });

    console.log(`\n[Baseline Profiling Summary]:`);
    console.log(`  Total Iterations:     ${bench.totalIterations}`);
    console.log(`  Total Duration:       ${bench.durationMs}ms`);
    console.log(`  Throughput:           ${bench.opsPerSecond} ops/sec`);
    console.log(`  Latency (Avg):        ${bench.latency.avgMs}ms`);
    console.log(`  Latency (p50):        ${bench.latency.p50Ms}ms`);
    console.log(`  Latency (p95):        ${bench.latency.p95Ms}ms`);
    console.log(`  Latency (p99):        ${bench.latency.p99Ms}ms`);
    console.log(`  Tokens Saved:         ${bench.report.resourceUtilization.totalTokensSaved}`);
    console.log(`  Memory Saved:         ${bench.report.resourceUtilization.totalMemorySavedBytes} bytes`);
    console.log(`  Anomalies Detected:   ${bench.anomalies.length}`);
    console.log(`\n✓ Baseline Profiling & Metrics Collection completed successfully.\n`);
}
