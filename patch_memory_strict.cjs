const fs = require('fs');
let code = fs.readFileSync('src/memory.ts', 'utf-8');

const optimizersStr = `                    optimizers_config: {
                        default_segment_number: 8, // Match to vCPU core count for low per-query latency
                        max_optimization_threads: 1, // Serializes background merges per shard to eliminate CPU spikes
                        deleted_threshold: 0.3, // Prevent vacuum optimizer from interrupting search threads prematurely
                        prevent_unoptimized: true // Prevents brute-force backlog scans during write bursts
                    },`;

const newOptimizersStr = `                    optimizers_config: {
                        default_segment_number: 8, // Match to vCPU core count for low per-query latency
                        max_optimization_threads: 1, // Serializes background merges per shard to eliminate CPU spikes
                        deleted_threshold: 0.3, // Prevent vacuum optimizer from interrupting search threads prematurely
                        prevent_unoptimized: true // Prevents brute-force backlog scans during write bursts
                    },
                    strict_mode_config: {
                        unindexed_filtering_retrieve: false, // Hard-rejects any filters on unindexed fields to prevent catastrophic latency spikes
                        unindexed_filtering_update: false
                    },`;

code = code.replace(optimizersStr, newOptimizersStr);
fs.writeFileSync('src/memory.ts', code);
