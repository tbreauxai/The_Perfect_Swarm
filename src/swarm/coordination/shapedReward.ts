import type { ShapedRewardParams } from './types.ts';

/**
 * Reinforcement-learning based reward shaping that balances novel strategy exploration
 * with proven tactic exploitation.
 */
export class ShapedRewardPolicy {
    private beta: number; // Novelty exploration weight
    private gamma: number; // Redundancy penalty weight

    public constructor(beta: number = 0.20, gamma: number = 0.15) {
        this.beta = beta;
        this.gamma = gamma;
    }

    public calculateShapedReward(params: ShapedRewardParams): {
        shapedReward: number;
        components: {
            extrinsic: number;
            noveltyBonus: number;
            redundancyPenalty: number;
        };
    } {
        const noveltyBonus = Math.min(1.0, Math.max(0, params.noveltyScore)) * (params.noveltyWeight ?? this.beta);
        const redundancyPenalty = Math.min(1.0, params.redundancyCount * 0.1) * (params.redundancyPenalty ?? this.gamma);

        const raw = params.extrinsicReward + noveltyBonus - redundancyPenalty;
        const shapedReward = Math.max(-1.0, Math.min(1.0, Math.round(raw * 1000) / 1000));

        return {
            shapedReward,
            components: {
                extrinsic: params.extrinsicReward,
                noveltyBonus: Math.round(noveltyBonus * 1000) / 1000,
                redundancyPenalty: Math.round(redundancyPenalty * 1000) / 1000
            }
        };
    }
}
