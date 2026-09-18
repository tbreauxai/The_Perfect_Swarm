# Ultragoal Brief: Continuous Feedback Loop, Policy Evolution & Drift-Aware Knowledge Repository

## Objective
Introduce an autonomous, continuous learning and adaptation system for `@perfect-swarm/core` comprising:
1. **Continuous Feedback Loop**: Captures multidimensional performance metrics after each analysis cycle and feeds them back into the swarm for autonomous parameter tuning.
2. **Reinforcement Learning & Evolutionary Policy Adaptation**: Employs reward signals tied to accuracy, quality, and resource economy to adapt swarm decision policies using evolutionary strategies and contextual multi-armed bandit optimization.
3. **Automated Data Validation & Concept Drift Detection**: Validates incoming memory data and detects statistical/distributional drift (Page-Hinkley test, embedding centroid drift) over sliding observation windows to trigger proactive knowledge re-indexing and policy recalibration.
4. **Shared Knowledge Repository**: Durable, structured repository logging analysis outcomes, validation scores, drift events, and parameter genealogies to inform future swarm optimization cycles.

## Architecture Boundaries
- **Module**: `src/swarm/feedback.ts`
- **Zero Runtime Dependencies**: Pure TypeScript conforming strictly to Node.js built-ins.
- **Core Components**:
  - `ContinuousFeedbackEngine`: Coordinates post-analysis telemetry capture, reward attribution, and parameter auto-tuning.
  - `PolicyOptimizer`: Adaptive policy engine implementing evolutionary mutation ((1+$\lambda$)-ES) and contextual RL reward functions ($R = w_q \cdot \text{quality} + w_a \cdot \text{accuracy} - w_l \cdot \text{cost}$).
  - `ConceptDriftDetector`: Sliding-window drift monitor utilizing Page-Hinkley tests and embedding divergence to signal knowledge obsolescence.
  - `SwarmKnowledgeRepository`: Append-only shared outcome store indexing analysis outputs, quality ratings, drift alerts, and policy version histories.
  - `SwarmEngine Integration`: Hooks into Step 7 and Memory Cortex to log outcomes, validate memories, and dynamically adjust swarm runtime parameters.

## Verification Criteria
- Unit tests in `src/swarm/feedback.test.ts` verifying policy evolution, reward calculation, drift alerts, and knowledge repository CRUD.
- Integration tests in `src/swarm/feedback-engine.test.ts` verifying engine feedback loop execution, parameter adaptation, and drift remediation.
- Distribution builds (`build:client`, `build:swarm`) and 100% pass rate across all Vitest suites and 5 E2E suites (`npm test`, `npm run lint`).
