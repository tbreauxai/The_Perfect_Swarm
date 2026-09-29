
import { AdaptiveLoadBalancer } from './AdaptiveLoadBalancer.ts';
import { TokenBudgetManager } from './TokenBudgetManager.ts';
import { NodeCapacityManager } from './NodeCapacityManager.ts';
import { SpecialistCapabilityProfiler } from './SpecialistCapabilityProfiler.ts';
import { SpecialistAffinityRouter } from './SpecialistAffinityRouter.ts';

export const globalLoadBalancer = new AdaptiveLoadBalancer();
export const globalTokenBudgetManager = new TokenBudgetManager();
export const globalNodeCapacityManager = new NodeCapacityManager();
export const globalSpecialistProfiler = new SpecialistCapabilityProfiler();
export const globalSpecialistRouter = new SpecialistAffinityRouter(
    globalTokenBudgetManager,
    globalLoadBalancer,
    globalSpecialistProfiler,
    globalNodeCapacityManager
);
