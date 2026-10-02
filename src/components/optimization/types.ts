export interface OptimizationRunnerProps {
    task: string;
    data: string;
    settings: any;
    onApplyModelToSettings?: (role: string, provider: string, model: string) => void;
}

export interface OptimizationResult {
    id: string;
    role: string;
    model: string;
    provider: string;
    durationMs: number;
    output: any;
    scores: {
        intelligence: number | null;
        accuracy: number | null;
        speed: number | null;
    };
    error?: string;
    gradingError?: string;
    fromCache?: boolean;
    isFullSwarm?: boolean;
    testedAt?: string;
    consensusSamples?: number;
}
