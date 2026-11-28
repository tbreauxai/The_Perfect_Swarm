---
description: Keep docs/ARCHITECTURE_MAP.md synchronized when files, routes, tools, providers, or validators change
globs: "**/*"
alwaysApply: true
---

# Architecture Map Auto-Update Rule

Whenever files in `src/` or root server/config files are added, deleted, or renamed, or when routes, tools, providers, or validators change:
- Run `node scripts/generate-architecture-map.mjs` before concluding the task.
- Do NOT remove `docs/ARCHITECTURE_MAP.md` from `.git/info/exclude` or stage it for Git push.
