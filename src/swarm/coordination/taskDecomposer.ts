import type { StrategicSubtask, TaskDecompositionPlan } from './types.ts';

/**
 * Higher-level agent task decomposition engine breaking macro-tasks into strategic subtasks.
 */
export class HierarchicalTaskDecomposer {
    public decompose(macroTask: string, availableRoles: string[]): TaskDecompositionPlan {
        const roles = availableRoles.length > 0 ? availableRoles : ['Security Analyst', 'Performance Analyst', 'Infrastructure Analyst'];
        const subtasks: StrategicSubtask[] = [];

        // 1. Telemetry and Environment Profiling (prerequisite)
        subtasks.push({
            id: 'sub-env-profile',
            title: `Profile environment baselines for ${macroTask}`,
            assignedRole: roles.find(r => r.toLowerCase().includes('infra')) || roles[0],
            dependencies: [],
            priority: 1,
            status: 'pending'
        });

        // 2. Domain-Specific In-Depth Audits (dependent on 1)
        const auditRoles = roles.filter(r => !r.toLowerCase().includes('infra'));
        if (auditRoles.length === 0) auditRoles.push(roles[0]);

        for (let i = 0; i < auditRoles.length; i++) {
            const role = auditRoles[i];
            subtasks.push({
                id: `sub-audit-${i + 1}`,
                title: `Execute deep specialist audit: ${role}`,
                assignedRole: role,
                dependencies: ['sub-env-profile'],
                priority: 2,
                status: 'pending'
            });
        }

        // 3. Synthesis & Mitigation Formulation (dependent on all audits)
        subtasks.push({
            id: 'sub-synthesis',
            title: `Synthesize multi-domain findings and mitigation actions for ${macroTask}`,
            assignedRole: 'Manager Node',
            dependencies: subtasks.map(s => s.id),
            priority: 3,
            status: 'pending'
        });

        const waves = this.computeWaves(subtasks);

        return {
            macroTask,
            strategySummary: `Decomposed into ${subtasks.length} strategic subtasks across ${waves.length} sequential execution waves.`,
            subtasks,
            executionWaves: waves,
            timestamp: Date.now()
        };
    }

    private computeWaves(subtasks: StrategicSubtask[]): string[][] {
        const completed = new Set<string>();
        const remaining = new Map<string, StrategicSubtask>(subtasks.map(s => [s.id, s]));
        const waves: string[][] = [];

        while (remaining.size > 0) {
            const currentWave: string[] = [];
            for (const [id, task] of remaining.entries()) {
                const canExecute = task.dependencies.every(dep => completed.has(dep));
                if (canExecute) {
                    currentWave.push(id);
                }
            }

            if (currentWave.length === 0) {
                // Cycle or unresolvable dependency fallback
                currentWave.push(Array.from(remaining.keys())[0]);
            }

            for (const id of currentWave) {
                completed.add(id);
                remaining.delete(id);
            }
            waves.push(currentWave);
        }

        return waves;
    }
}
