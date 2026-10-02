export * from './types.ts';
export * from './circuitBreaker.ts';
export * from './healthCache.ts';
export * from './modelChecker.ts';

import { TwoTierModelHealthChecker } from './modelChecker.ts';

/** Global singleton model health checker for system-wide reuse */
export const globalModelHealthChecker = new TwoTierModelHealthChecker();
