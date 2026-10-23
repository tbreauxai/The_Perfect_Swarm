export * from './types.js';
export * from './learningRateManager.js';
export * from './messageChannel.js';
export * from './taskDecomposer.js';
export * from './hypothesisLayer.js';
export * from './shapedReward.js';

import { AgentAdaptiveLearningRateManager } from './learningRateManager.js';
import { HighBandwidthMessageChannel } from './messageChannel.js';
import { HierarchicalTaskDecomposer } from './taskDecomposer.js';
import { HypothesisValidationLayer } from './hypothesisLayer.js';
import { ShapedRewardPolicy } from './shapedReward.js';

export const globalLearningRateManager = AgentAdaptiveLearningRateManager.getInstance();
export const globalMessageChannel = new HighBandwidthMessageChannel();
export const globalTaskDecomposer = new HierarchicalTaskDecomposer();
export const globalHypothesisLayer = new HypothesisValidationLayer();
export const globalShapedRewardPolicy = new ShapedRewardPolicy();
