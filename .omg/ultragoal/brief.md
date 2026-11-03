# Ultragoal Brief: Graded Lesson Index, Critic Veto, and Quota Shift

## Objective
Implement feedback route enhancements, Qdrant graded lesson indexing with deterministic lessonId, point deletion, memory type tag extension, critic veto with raw board slices, manager synthesis board preservation, dynamic token budget quota shifts from rate-limit headers, and comprehensive unit tests as specified in `todo.md`. Clear `todo.md` upon completion.

## Boundaries & Constraints
- Repo: `tbreauxai/The_Perfect_Swarm`, branch main, SHA 44bf569.
- Single collection: `pwa_swarm_dev_cortex_v2`. Partition by payload tags, never new collections.
- No NVIDIA NIM, compound-mini, prompt-guard model, or FastAPI migration.
- Embeddings stay Gemini `text-embedding-005` (768 dims) with `text-embedding-004` fallback. No Cloudflare bge.
- Per-request deterministic fallback must NOT mutate `this.embeddingProvider`.
- All tests must pass: `npm run lint`, `npm run test:unit`, `npm run test:server`, `npm run build`.
