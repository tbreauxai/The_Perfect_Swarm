export function printHelp() {
    console.log(`
Usage: perfect-swarm <command> [options]

Commands:
  doctor                         Verify environment keys, free-tier connectivity, and memory cortex
  init <app-name> [dest-dir]     Scaffold an isolated, portable AI swarm worker for a target application
  run "<task>" [options]         Execute a headless swarm analysis workflow from the command line
  export-memory [options]        Export memories from MemoryCortex to JSON or JSONL file
  import-memory <file> [options] Import and hydrate memories into MemoryCortex
  profile [options]              Run baseline performance profiling and benchmark metrics collection
  bench [options]                Alias for profile
  feedback-stats [options]       Display aggregated feedback insights and reward statistics
  drift-check                    Check active concept drift alerts across latency, quality, and embeddings
  policy-inspect                 Inspect current evolutionary tuned swarm parameters and policy status
  graph-inspect                  Inspect shared knowledge graph version, node counts, and relationships
  hypotheses-inspect             Inspect proposed, validated, and pruned agent hypotheses
  rates-inspect                  Inspect per-agent adaptive learning rates and convergence state

Options:
  --data <data-payload>          Input data payload for analysis
  --app <app-id>                 Target application namespace (default: perfect-swarm)
  --out <file-path>              Output destination file for memory export (default: memories.jsonl)
  --min-rating <number>          Minimum quality rating filter for exported memories
  --format <json|jsonl|auto>     Snapshot serialization format (default: auto)
  --target-app <app-id>          Target application namespace for imported memories
  --no-dedup                     Disable deduplication during memory import
  --help, -h                     Show help information
`);
}
