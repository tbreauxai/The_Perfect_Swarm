# Ultragoal Brief: Confidence Factors (Registry v1, Schema, Validator, Prompt) behind JUDGMENT_FACTORS

## Objective
Implement confidence factors for morning judge behind feature flag `JUDGMENT_FACTORS` (default off, requires `JUDGMENT_SCHEMA_V2`). The judge may optionally supply up to 4 factor objects with `{id, evidence: {kind, ref}}` from a fixed registry without magnitudes or directions.

## Constraints & Rules
- Base commit: `98bb3843447251ebd0b3585a1e6b7a40a1ac1b42` (main)
- Branch: `feat/judgment-factors`
- Single branch, one commit per step, `git add <files>` only (never `-A`)
- Never run: `git reset`, `git checkout .`, `git restore`, `git clean`, `git rebase`, or squash
- Strip-only TS (Node 22): no enums, namespaces, parameter properties, import=require or decorators
- Pre-existing TS1484 errors under `--erasableSyntaxOnly --verbatimModuleSyntax` must remain exactly 10
- Zero Render env changes, no secrets, no migrations, no DB writes
- `judgment.v2.fixtures.json` is NOT touched
