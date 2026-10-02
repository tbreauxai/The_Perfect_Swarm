import type {
    ExperimentConfig,
    AgentVariantConfig,
    ExecutionMetrics,
    ExperimentDecision
} from './types.ts';
import { AgentExperiment } from './agentExperiment.ts';

/**
 * Global registry and coordinator for continuous A/B testing and agent configuration optimization.
 */
export class AgentExperimentManager {
    private experiments: Map<string, AgentExperiment> = new Map();
    private activeExperimentId?: string;

    createExperiment(config: ExperimentConfig): AgentExperiment {
        const exp = new AgentExperiment(config);
        this.experiments.set(exp.id, exp);
        if (!this.activeExperimentId || exp.status === 'active') {
            this.activeExperimentId = exp.id;
        }
        return exp;
    }

    getExperiment(id: string): AgentExperiment | undefined {
        return this.experiments.get(id);
    }

    getActiveExperiment(): AgentExperiment | undefined {
        if (!this.activeExperimentId) {
            for (const exp of this.experiments.values()) {
                if (exp.status === 'active') {
                    this.activeExperimentId = exp.id;
                    return exp;
                }
            }
            return undefined;
        }
        return this.experiments.get(this.activeExperimentId);
    }

    setActiveExperiment(id: string): void {
        if (!this.experiments.has(id)) {
            throw new Error(`Experiment ${id} not found in manager registry`);
        }
        this.activeExperimentId = id;
    }

    resolveVariantForTask(
        task: string,
        appId?: string
    ): { experiment?: AgentExperiment; variant?: AgentVariantConfig } {
        const exp = this.getActiveExperiment();
        if (!exp) return {};
        const key = `${appId || 'default'}:${task}`;
        const variant = exp.allocateVariant(key);
        return { experiment: exp, variant };
    }

    recordExecutionMetrics(
        experimentId: string,
        variantId: string,
        metrics: ExecutionMetrics
    ): ExperimentDecision | undefined {
        const exp = this.experiments.get(experimentId);
        if (!exp) return undefined;
        return exp.recordOutcome(variantId, metrics);
    }

    exportState(): object {
        const exps: Record<string, object> = {};
        for (const [id, exp] of this.experiments.entries()) {
            exps[id] = exp.toJSON();
        }
        return {
            activeExperimentId: this.activeExperimentId,
            experiments: exps
        };
    }

    importState(data: any): void {
        if (!data || !data.experiments) return;
        this.experiments.clear();
        for (const [id, expData] of Object.entries(data.experiments)) {
            this.experiments.set(id, AgentExperiment.fromJSON(expData));
        }
        this.activeExperimentId = data.activeExperimentId;
    }

    clear(): void {
        this.experiments.clear();
        this.activeExperimentId = undefined;
    }
}

export const globalAgentExperimentManager = new AgentExperimentManager();
