# Fix DuelOdds Tool RPC Params

## Objective
Update The_Perfect_Swarm's 5 DuelOdds Supabase RPC tools to send PostgREST `p_*`-prefixed parameters, enforce publishable key only (no service-role key), eliminate fabricated props and market movement defaults, and provide contract tests against real DuelOdds signatures.

## Constraints & Architecture Boundaries
- Base: `2c0729e67d27fc07d4960b5244dcd838e7516a1d`
- Branch: `fix/tool-rpc-params`
- Explicit `git add <named files>`, never `-A`.
- Never reset, checkout ., restore, clean, rebase, squash or force-push.
- Node 22 strip-only TypeScript: no parameter properties, enums, namespaces, import=require or decorators.
- Publishable key only (reject service-role keys).
- Missing != zero; no fabrication (e.g. no fake `-110` prices, no default 0% hit rate or fake sample size).
- Zero conversational filler.
