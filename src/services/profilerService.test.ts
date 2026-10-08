import { describe, it, expect } from 'vitest';
import * as profilerService from './profilerService';
import { globalUnifiedProfiler } from '../swarm/profiler';

describe('ProfilerService module', () => {
    it('should act as a backward compatibility re-export module', () => {
        // Assert that the module properly re-exports the expected functionality
        // from src/swarm/profiler.ts. The prompt indicates "export class ProfilerService"
        // was in the original file, but reviewing the git history shows this file is purely
        // a facade for backward compatibility `export * from '../swarm/profiler.ts'`.
        expect(profilerService.UnifiedSwarmProfiler).toBeDefined();
        expect(typeof profilerService.UnifiedSwarmProfiler).toBe('function');

        expect(profilerService.globalUnifiedProfiler).toBeDefined();
        expect(profilerService.globalUnifiedProfiler).toBe(globalUnifiedProfiler);

        expect(profilerService.SwarmMetricsCollector).toBeDefined();
        expect(profilerService.runSwarmBenchmark).toBeDefined();
    });
});
