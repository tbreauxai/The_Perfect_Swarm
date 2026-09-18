import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  build: {
    outDir: 'dist/swarm',
    emptyOutDir: false,
    lib: {
      entry: {
        index: path.resolve(__dirname, 'src/swarm/index.ts'),
        engine: path.resolve(__dirname, 'src/swarm/engine.ts'),
        memory: path.resolve(__dirname, 'src/swarm/memory.ts'),
        router: path.resolve(__dirname, 'src/swarm/router.ts'),
        lifecycle: path.resolve(__dirname, 'src/swarm/lifecycle.ts'),
        cache: path.resolve(__dirname, 'src/swarm/cache.ts'),
        loadBalancer: path.resolve(__dirname, 'src/swarm/loadBalancer.ts'),
        profiler: path.resolve(__dirname, 'src/swarm/profiler.ts'),
        server: path.resolve(__dirname, 'src/swarm/server.ts'),
        tools: path.resolve(__dirname, 'src/swarm/tools/index.ts'),
        parser: path.resolve(__dirname, 'src/swarm/parser.ts'),
        client: path.resolve(__dirname, 'src/swarm/client.ts'),
        communication: path.resolve(__dirname, 'src/swarm/communication.ts'),
        vectorIndex: path.resolve(__dirname, 'src/swarm/vectorIndex.ts'),
        speculative: path.resolve(__dirname, 'src/swarm/speculative.ts'),
        experiment: path.resolve(__dirname, 'src/swarm/experiment.ts'),
        compression: path.resolve(__dirname, 'src/swarm/compression.ts'),
        scheduler: path.resolve(__dirname, 'src/swarm/scheduler.ts'),
        hierarchy: path.resolve(__dirname, 'src/swarm/hierarchy.ts'),
        tieredCache: path.resolve(__dirname, 'src/swarm/tieredCache.ts'),
        feedback: path.resolve(__dirname, 'src/swarm/feedback.ts'),
        knowledgeGraph: path.resolve(__dirname, 'src/swarm/knowledgeGraph.ts'),
        coordination: path.resolve(__dirname, 'src/swarm/coordination.ts'),
        health: path.resolve(__dirname, 'src/swarm/health.ts')
      },
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => `${entryName}.${format === 'es' ? 'js' : 'cjs'}`
    },
    rollupOptions: {
      external: [
        '@google/genai',
        '@qdrant/js-client-rest',
        'zod',
        'zod-to-json-schema',
        'node:crypto',
        'node:url',
        'node:path',
        'node:fs',
        'node:http',
        'crypto',
        'url',
        'path',
        'fs',
        'http'
      ],
      output: [
        {
          format: 'es',
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js'
        },
        {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: 'chunks/[name]-[hash].cjs'
        }
      ]
    }
  }
});
