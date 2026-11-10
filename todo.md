Perfect Swarm: read DuelOdds' real context-store envelope | Swarm-only (no DuelOdds changes)
Base: The_Perfect_Swarm main e6d18792. Contract source: DuelOdds 82e54e58, migration 20261107172900 L366-641 (read_game_context_v1).
Branch: feat/context-store-reader. One PR.

GIT (do first)

- [x] git status clean or STOP. git checkout main && git pull --ff-only. git merge-base --is-ancestor e6d18792 HEAD or STOP.
- [x] git checkout -b feat/context-store-reader. Commit after each step with explicit `git add <named files>`, never -A.
- [x] Never reset, checkout ., restore, clean, rebase, squash or force-push.
- [x] Node 22 strip-only TypeScript: no parameter properties, enums, namespaces, import=require or decorators.

1. [x] P0 adapter | gameContext.ts readGameContextFromStore (~L1044-1100) + parser (~L213-220, 327-354, 755-778)
   Accept the real envelope: { status: "ready" | "empty", items: [...] } per the migration. Add one small adapter that maps each item to the swarm's
   existing sections + source_status. status "empty" (or items: []) is a valid "no context" result, not an error. Missing stays missing, never zero
   or a default; unknown/extra fields ignored; malformed shape returns a logged reason and no context. Never fabricate sections.
   Done when: a ready fixture yields the same sections the swarm already consumes; empty yields no-context with no throw.
2. [x] Env names only | render.yaml + .env.example
   Declare SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (sync: false in render.yaml, empty values). This path uses the read-only publishable key,
   never the service-role key; fail closed (no context, logged reason) when either is unset. No values in any file.
3. [x] ID resolution | same reader, before the RPC
   If retrievalContext / entityIds arrive as 32-hex Odds API ids, resolve each to its ESPN canonical event_id with a read of canonical_game_aliases
   (provider = Odds API, by provider_event_id + game_date). Unresolved ids are skipped with a logged reason (count + id), never guessed.
   No truncation; keep the 40-entity cap and the existing entity_ids_limit_exceeded behaviour.
4. [x] Contract test | new tests/contract/contextStoreEnvelope.test.ts + fixtures/duelodds_read_game_context_v1.json
   Copy the fixture shape from the DuelOdds migration (ready with 2 items incl. one partial section, and empty). Assert adapter output, empty path,
   malformed path, hex-to-canonical resolution (mocked alias read), unresolved skip, and that the publishable key (never service role) is used.
   Keep the historyScope gate exactly as is: app tokens never unlock private history (add one assertion if not already covered).

FINAL VERIFY (once): the repo's full test run, lint, typecheck and build. Then a startup smoke test: the real start command, then GET /api/health returns 200.
Paste git log --oneline main..HEAD and git diff --stat main; confirm the diff isn't empty.
git push -u origin feat/context-store-reader && gh pr create. NEVER push to main; push only the feature branch. No auto-merge.

TYLER: Merge outside 9-10 PM CT (Render auto-deploys on merge). Before or with the merge, set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in the Render
dashboard (publishable/anon key only). No migration. If the swarm misbehaves, unset the key (reader falls back to no context) or roll back the Render deploy.
