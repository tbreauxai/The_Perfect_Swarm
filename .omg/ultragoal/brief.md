# Read DuelOdds' Real Context-Store Envelope

## Objective
Update The_Perfect_Swarm's context store reader to accept DuelOdds' real `read_game_context_v1` envelope (`{ status: "ready" | "empty", items: [...] }`), resolve 32-hex Odds API ids to ESPN canonical event_ids via `canonical_game_aliases`, declare publishable key environment variables, and establish full contract test coverage.

## Constraints & Architecture Boundaries
- Swarm-only (no DuelOdds changes).
- Branch: `feat/context-store-reader`.
- Explicit `git add <named files>`, never `-A`.
- Never reset, checkout ., restore, clean, rebase, squash or force-push.
- Node 22 strip-only TypeScript: no parameter properties, enums, namespaces, import=require or decorators.
- Use read-only publishable key (`SUPABASE_PUBLISHABLE_KEY`), never service-role key. Fail closed if unset.
- Status "empty" or `items: []` is valid no-context result, not an error.
- Missing stays missing (no zero or default values); never fabricate sections.
- Unresolved 32-hex ids skipped with logged reason (count + id), keeping 40-entity cap.
- Preserve historyScope security gate: app tokens never unlock private history.
- Zero conversational filler.
