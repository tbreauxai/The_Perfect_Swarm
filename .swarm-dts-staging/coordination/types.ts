export interface AgentLearningState {
    agentId: string;
    learningRate: number;
    emaReward: number;
    rewardVariance: number;
    consecutiveSuccesses: number;
    consecutiveFailures: number;
    totalUpdates: number;
}

export interface AdaptiveLearningRateConfig {
    defaultLearningRate?: number;
    minLearningRate?: number;
    maxLearningRate?: number;
    emaAlpha?: number;
    accelerationFactor?: number;
    dampingFactor?: number;
}

export interface InteragentMessage {
    id: string;
    senderId: string;
    targetId: string | 'broadcast';
    topic: string;
    payload: any;
    timestamp: number;
    latencyNs?: number;
}

export interface StrategicSubtask {
    id: string;
    title: string;
    assignedRole: string;
    dependencies: string[];
    priority: number;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    outputSnippet?: string;
}

export interface TaskDecompositionPlan {
    macroTask: string;
    strategySummary: string;
    subtasks: StrategicSubtask[];
    executionWaves: string[][]; // Array of subtask ID batches executable in parallel
    timestamp: number;
}

export type HypothesisStatus = 'proposed' | 'validated' | 'refuted' | 'pruned';

export interface Hypothesis {
    id: string;
    claim: string;
    proposedBy: string;
    confidence: number; // 0.0 - 1.0
    evidence: string[];
    status: HypothesisStatus;
    validationFeedback?: string;
    timestamp: number;
}

export interface ShapedRewardParams {
    extrinsicReward: number; // Task outcome accuracy & SLA score
    noveltyScore: number;    // Unexplored state/parameter novelty
    redundancyCount: number; // Duplicated queries or redundant actions
    noveltyWeight?: number;  // beta parameter
    redundancyPenalty?: number; // gamma parameter
}
