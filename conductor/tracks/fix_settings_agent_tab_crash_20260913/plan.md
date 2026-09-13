# Implementation Plan: Fix Settings Modal Crash on Swarm Agents Tab

## Phase 1: TDD & Core Bug Fix (Prop Wiring & Safe Fallbacks)

- [x] Task: Write Failing Component/Unit Tests for SettingsModal & AgentConfigurator (TDD Red Phase) (331f964)
  - [x] Write unit test verifying `AgentConfigurator` behavior when `settings` prop is missing or partial
  - [x] Write unit test verifying `SettingsModal` successfully renders `Swarm Agents` tab
  - [x] Run test suite via `vitest` and confirm Red phase test failure
- [~] Task: Fix Prop Propagation and Safe Defaults (TDD Green Phase)
  - [ ] Pass `settings={settings}` to `<AgentConfigurator />` in [`src/components/SettingsModal.tsx`](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/components/SettingsModal.tsx#L188)
  - [ ] Add defensive fallback defaults (`settings = {} as AppSettings`) and optional chaining in [`src/components/AgentConfigurator.tsx`](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/components/AgentConfigurator.tsx)
  - [ ] Run `vitest` to confirm all tests pass (Green Phase)
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 2: Enhanced Defensive UX & Full Regression Verification

- [ ] Task: Add Loading Skeletons and Empty Key Inline Hints in AgentConfigurator
  - [ ] Render clean inline hints when a provider's key is not configured
  - [ ] Render loading skeleton state during async model retrieval
- [ ] Task: Full Regression Test & Build Verification
  - [ ] Run `npx tsc --noEmit` to verify type safety with zero errors
  - [ ] Run `npm run build` to verify client and swarm distribution builds
  - [ ] Run `npm test` to verify all 5 core test suites pass 100%
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)
