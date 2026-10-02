export * from './types.ts';
export * from './learningRateManager.ts';
export * from './messageChannel.ts';
export * from './taskDecomposer.ts';
export * from './hypothesisLayer.ts';
export * from './shapedReward.ts';

import { AgentAdaptiveLearningRateManager } from './learningRateManager.ts';
import { HighBandwidthMessageChannel } from './messageChannel.ts';
import { HierarchicalTaskDecomposer } from './taskDecomposer.ts';
import { HypothesisValidationLayer } from './hypothesisLayer.ts';
import { ShapedRewardPolicy } from './shapedReward.ts';

export const globalLearningRateManager = AgentAdaptiveLearningRateManager.getInstance();
export const globalMessageChannel = new HighBandwidthMessageChannel();
export const globalTaskDecomposer = new HierarchicalTaskDecomposer();
export const globalHypothesisLayer = new HypothesisValidationLayer();
export const globalShapedRewardPolicy = new ShapedRewardPolicy();
