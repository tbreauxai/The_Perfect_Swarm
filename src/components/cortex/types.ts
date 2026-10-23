export interface RoleRecommendation {
  role: string;
  recommendedProvider: string;
  recommendedModel: string;
  reason: string;
}

export interface SeatAccuracyEntry {
  appId: string;
  role: string;
  wins: number;
  losses: number;
  pushes: number;
  total: number;
  winRate: number;
  ucb1Score: number;
  capabilityScore: number;
}

export interface LearningTelemetry {
  supabaseConfigured: boolean;
  calibrationAppId: string;
  calibration: {
    globalBias: number;
    sportBias: Record<string, number>;
    sampleSize: number;
    sportSamples: Record<string, number>;
    brier: number;
    meanPredicted: number;
    meanActual: number;
  };
  seatAccuracy: SeatAccuracyEntry[];
}

export interface CortexDiagnostics {
  qdrantAvailable: boolean;
  collectionName: string;
  pointCount: number;
  appCount: number;
  apps: string[];
  fallbackStoreSize: number;
  storageByDomain: Record<string, number>;
  storageByRole: Record<string, number>;
  latencyStats?: {
      mean: number | null;
      p95: number | null;
      p99: number | null;
  };
  cacheHitRatio?: number;
  totalTokensBurned?: number;
  promptTokens?: number;
  completionTokens?: number;
  estimatedCostUsd?: number;
  errorRate?: number;
  totalRequests?: number;
  failureCount?: number;
  modelSuggestions?: string;
  roleRecommendations?: RoleRecommendation[];
  learningTelemetry?: LearningTelemetry;
}
