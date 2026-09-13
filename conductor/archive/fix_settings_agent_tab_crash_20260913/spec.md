# Specification: Fix Settings Modal Crash on Swarm Agents Tab

## Overview
When navigating to the "Swarm Agents" (agent models) tab in the Settings modal ([`src/components/SettingsModal.tsx`](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/components/SettingsModal.tsx)), the application crashes with an unhandled exception: `TypeError: Cannot read properties of undefined (reading 'geminiApiKey')`. 

This occurs because [`SettingsModal.tsx`](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/components/SettingsModal.tsx#L188) renders `<AgentConfigurator agents={settings.agents} onUpdateAgent={onUpdateAgent} />` without passing the `settings` prop required by [`AgentConfiguratorProps`](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/components/AgentConfigurator.tsx#L12-L16). When `AgentConfigurator` calls `getApiKeyForProvider(provider)`, it attempts to access properties on `undefined`, immediately crashing the React component tree.

This track repairs the prop wiring, adds defensive fallback defaults and optional chaining in `AgentConfigurator`, improves empty API key UX, and introduces automated test coverage to prevent future regressions.

## Functional Requirements
1. **Prop Wiring in SettingsModal**:
   - In [`src/components/SettingsModal.tsx`](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/components/SettingsModal.tsx), pass `settings={settings}` to `<AgentConfigurator />` when `activeTab === 'swarm'`.
2. **Defensive Defaults in AgentConfigurator**:
   - In [`src/components/AgentConfigurator.tsx`](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/components/AgentConfigurator.tsx), supply default parameter values (`settings = {} as AppSettings`) and use optional chaining (`settings?.geminiApiKey`, etc.) inside `getApiKeyForProvider`.
3. **Empty/Missing Key & Loading UX**:
   - If a provider requires an API key and none is provided or loaded from secrets, display an inline warning/hint ("Key required in API Keys tab") instead of failing network calls.
   - Display a loading skeleton state while provider models are being fetched asynchronously.
4. **Automated Unit Testing**:
   - Add unit tests verifying that `AgentConfigurator` renders without crashing even if `settings` is omitted or empty.
   - Add unit tests verifying `SettingsModal` renders the `Swarm Agents` tab successfully.

## Non-Functional Requirements
- Maintain clean TypeScript type checks (`npx tsc --noEmit` with 0 errors).
- Zero regressions on existing Swarm Client SDK and core engine test suites (`npm test`).

## Acceptance Criteria
- [ ] Navigating between "API Keys" and "Swarm Agents" tabs in `SettingsModal` succeeds without throwing errors or crashing.
- [ ] Provider and model dropdowns display correctly for all configured swarm agents.
- [ ] Missing API keys are handled gracefully with non-blocking inline hints.
- [ ] Automated tests pass with 100% success.

## Out of Scope
- Redesigning the entire settings modal layout.
- Modifying backend provider adapters or server streaming routes.
