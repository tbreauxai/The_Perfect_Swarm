import { Agent } from './agent.ts';
import { SwarmContext } from './context.ts';
import type { SwarmEvent } from './types.ts';

export type HierarchyLayer = 'L1_TRIAGE' | 'L2_SPECIALIST' | 'L3_SYNTHESIS';

export type EventScope = 'all' | 'milestones' | 'triage' | 'specialists' | 'synthesis';

export interface HierarchyNode {
    id: string;
    role: string;
    layer: HierarchyLayer;
    agent: Agent;
    specialties?: string[];
}

export interface TriagePlan {
    task: string;
    selectedSpecialistIds: string[];
    rationale: string;
    priority: 'low' | 'normal' | 'high' | 'critical';
    estimatedSpecialistCount: number;
}

export interface HierarchyExecutionOptions {
    scope?: EventScope;
    maxSpecialists?: number;
    taskTimeoutMs?: number;
}

export interface HierarchicalExecutionResult {
    triagePlan: TriagePlan;
    specialistReports: Record<string, any>;
    synthesisOutput: any;
    bypassedSpecialists: string[];
    broadcastEvents: SwarmEvent[];
}

/**
 * Hierarchical Agent Communication Router (L1 Triage -> L2 Specialists -> L3 Synthesis).
 * Minimizes broadcast overhead, prevents context window drift, and eliminates redundant agent invocations
 * by dynamically gating and routing work only to relevant domain specialists.
 */
export class SwarmHierarchy {
    private triageNode: HierarchyNode | null = null;
    private specialistNodes: Map<string, HierarchyNode> = new Map();
    private synthesisNode: HierarchyNode | null = null;
    private scopedContext: SwarmContext;

    constructor(context?: SwarmContext) {
        this.scopedContext = context || new SwarmContext();
    }

    setTriageNode(agent: Agent, id: string = 'triage-l1', role: string = 'L1 Triage Gatekeeper'): void {
        this.triageNode = {
            id,
            role,
            layer: 'L1_TRIAGE',
            agent,
            specialties: ['routing', 'triage', 'classification', 'filtering']
        };
    }

    addSpecialistNode(agent: Agent, id: string, role: string, specialties: string[] = []): void {
        this.specialistNodes.set(id, {
            id,
            role,
            layer: 'L2_SPECIALIST',
            agent,
            specialties
        });
    }

    setSynthesisNode(agent: Agent, id: string = 'synthesis-l3', role: string = 'L3 Manager Synthesis'): void {
        this.synthesisNode = {
            id,
            role,
            layer: 'L3_SYNTHESIS',
            agent,
            specialties: ['synthesis', 'aggregation', 'ui-generation']
        };
    }

    getSpecialists(): HierarchyNode[] {
        return Array.from(this.specialistNodes.values());
    }

    /**
     * L1 Triage Planning: Dynamically selects only relevant specialists to prevent broadcast bloat.
     */
    planTriage(task: string, dataSample: string = "", maxSpecialists: number = 2): TriagePlan {
        const lowerTask = (task || '').toLowerCase();
        const lowerData = (dataSample || '').toLowerCase().substring(0, 1000);
        const combined = `${lowerTask} ${lowerData}`;

        const specialists = Array.from(this.specialistNodes.values());
        if (specialists.length === 0) {
            return {
                task,
                selectedSpecialistIds: [],
                rationale: 'No L2 specialists registered in hierarchy.',
                priority: 'normal',
                estimatedSpecialistCount: 0
            };
        }

        // Score each specialist based on match against task keywords and declared specialties
        const scored = specialists.map(node => {
            let score = 0;
            for (const specialty of node.specialties || []) {
                const s = specialty.toLowerCase();
                if (combined.includes(s)) {
                    score += 3;
                }
            }
            if (combined.includes(node.role.toLowerCase())) {
                score += 2;
            }
            return { node, score };
        });

        // Sort descending by relevance score
        scored.sort((a, b) => b.score - a.score);

        // Filter specialists with score > 0, or fallback to top N specialists
        let selected = scored.filter(s => s.score > 0).map(s => s.node.id);
        if (selected.length === 0) {
            selected = scored.slice(0, Math.min(maxSpecialists, specialists.length)).map(s => s.node.id);
        } else if (selected.length > maxSpecialists) {
            selected = selected.slice(0, maxSpecialists);
        }

        const priority = lowerTask.includes('critical') || lowerTask.includes('urgent') || lowerTask.includes('security')
            ? 'critical'
            : lowerTask.includes('anomaly') || lowerTask.includes('error')
            ? 'high'
            : 'normal';

        return {
            task,
            selectedSpecialistIds: selected,
            rationale: `L1 Triage selected ${selected.length}/${specialists.length} specialists based on semantic affinity.`,
            priority,
            estimatedSpecialistCount: selected.length
        };
    }

    /**
     * Executes tiered hierarchical workflow: L1 Triage -> Active L2 Specialists -> L3 Synthesis.
     * Prevents broadcast overhead by scoping events and passing distilled findings upward.
     */
    async execute(
        task: string,
        data: string = "",
        options?: HierarchyExecutionOptions
    ): Promise<HierarchicalExecutionResult> {
        const maxSpecialists = options?.maxSpecialists ?? 2;
        const triagePlan = this.planTriage(task, data.substring(0, 500), maxSpecialists);
        const allSpecialists = Array.from(this.specialistNodes.keys());
        const bypassedSpecialists = allSpecialists.filter(id => !triagePlan.selectedSpecialistIds.includes(id));

        // Record L1 Triage event
        this.scopedContext.addEvent({
            agentRole: this.triageNode?.role || 'L1 Triage Gatekeeper',
            action: 'Hierarchical Task Partitioning',
            modelName: this.triageNode?.agent.modelName || 'Local/Hierarchy',
            prompt: `Triage dispatch: ${triagePlan.rationale}`,
            output: {
                selectedSpecialists: triagePlan.selectedSpecialistIds,
                bypassedSpecialists,
                priority: triagePlan.priority
            },
            durationMs: 0
        });

        // Dispatch concurrently only to selected L2 specialists
        const specialistReports: Record<string, any> = {};
        const specialistPromises = triagePlan.selectedSpecialistIds.map(async (id) => {
            const node = this.specialistNodes.get(id);
            if (!node) return;

            const prompt = `Specialist Role: ${node.role}\nTask: ${task}\nSpecialty Focus: ${(node.specialties || []).join(', ')}\n\nData Payload:\n${data.substring(0, 4000)}`;
            try {
                const output = await node.agent.run(prompt, this.scopedContext, {
                    responseMimeType: 'application/json',
                    timeoutMs: options?.taskTimeoutMs ?? 120000
                });
                specialistReports[id] = {
                    role: node.role,
                    output
                };
            } catch (err: any) {
                specialistReports[id] = {
                    role: node.role,
                    error: err.message || String(err)
                };
            }
        });

        await Promise.all(specialistPromises);

        // L3 Manager Synthesis
        let synthesisOutput: any = null;
        if (this.synthesisNode) {
            const compiledFindings = Object.entries(specialistReports)
                .map(([id, r]) => `[${r.role} (${id})]:\n${typeof r.output === 'string' ? r.output : JSON.stringify(r.output || r.error, null, 2)}`)
                .join('\n\n');

            const synthesisPrompt = `Task: ${task}\n\nTriage Priority: ${triagePlan.priority}\n\nSpecialist Findings:\n${compiledFindings}`;
            try {
                synthesisOutput = await this.synthesisNode.agent.run(synthesisPrompt, this.scopedContext, {
                    responseMimeType: 'application/json',
                    timeoutMs: options?.taskTimeoutMs ?? 120000
                });
            } catch (err: any) {
                synthesisOutput = { error: `Synthesis failed: ${err.message || String(err)}` };
            }
        }

        return {
            triagePlan,
            specialistReports,
            synthesisOutput,
            bypassedSpecialists,
            broadcastEvents: this.filterEventsByScope(this.scopedContext.events, options?.scope || 'all')
        };
    }

    /**
     * Filters event broadcasts according to requested scope to prevent UI thread bloat and context drift.
     */
    filterEventsByScope(events: SwarmEvent[], scope: EventScope): SwarmEvent[] {
        if (scope === 'all') return events;

        return events.filter(e => {
            const role = (e.agentRole || '').toLowerCase();
            if (scope === 'milestones') {
                return e.action.includes('Completed') || e.action.includes('Partitioning') || e.action.includes('Synthesis');
            }
            if (scope === 'triage') {
                return role.includes('triage') || role.includes('router');
            }
            if (scope === 'specialists') {
                return role.includes('specialist') || role.includes('analyst');
            }
            if (scope === 'synthesis') {
                return role.includes('manager') || role.includes('synthesis') || role.includes('orchestrator');
            }
            return true;
        });
    }

    getContext(): SwarmContext {
        return this.scopedContext;
    }
}
