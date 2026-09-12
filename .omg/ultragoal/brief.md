# Ultragoal Brief: App Audit, Modularization & Cleanup

## Core Objective
Audit the application for runtime/type errors and duplicate code, modularize frontend and backend architecture, and delete all irrelevant and obsolete files.

## Constraints & Architecture Boundaries
- Preserve core functionality: Swarm analysis pipeline, multi-provider LLM support (Gemini, Groq, OpenRouter, Mistral), Qdrant memory cortex, and generative UI components.
- Do not delete critical configuration or source files: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `.env.example`, `.gitignore`.
- Delete ad-hoc scratch scripts (`*.cjs`, `test_*.js`, `patch_*.cjs`, `fix_*.cjs`, `*.backup`) that clutter the repository.
- Ensure strict TypeScript typing and error-free builds (`tsc --noEmit`, `vite build`).
- Frontend modularization: Decompose `App.tsx` into cohesive components (`components/settings`, `components/timeline`, `components/analysis`).
- Backend modularization: Unify swarm orchestration, memory integration, and server route handling without duplicated logic.
