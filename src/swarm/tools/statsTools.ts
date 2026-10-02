import type { SwarmTool } from './types.ts';

/**
 * Built-in statistics summary tool.
 */
export const statsSummaryTool: SwarmTool<
    { numbers: number[] },
    { count: number; sum: number; mean: number; median: number; min: number; max: number; variance: number; stdDev: number }
> = {
    name: 'stats_summary',
    description: 'Computes descriptive statistics (count, sum, mean, median, min, max, variance, stdDev) on a dataset.',
    parameters: {
        numbers: {
            type: 'array',
            description: 'Array of numbers to analyze',
            required: true
        }
    },
    execute({ numbers }) {
        if (!Array.isArray(numbers) || numbers.length === 0) {
            throw new Error('stats_summary requires a non-empty array of numbers.');
        }
        const valid = numbers.filter(n => typeof n === 'number' && !isNaN(n));
        if (valid.length === 0) throw new Error('No valid numbers provided in numbers array.');

        const sorted = [...valid].sort((a, b) => a - b);
        const count = sorted.length;
        let sum = 0;
        let mean_welford = 0;
        let M2 = 0;

        for (let i = 0; i < count; i++) {
            const val = sorted[i];
            sum += val;

            const delta = val - mean_welford;
            mean_welford += delta / (i + 1);
            const delta2 = val - mean_welford;
            M2 += delta * delta2;
        }

        const mean = sum / count;
        const min = sorted[0];
        const max = sorted[sorted.length - 1];

        let median = 0;
        const mid = Math.floor(count / 2);
        if (count % 2 === 0) {
            median = (sorted[mid - 1] + sorted[mid]) / 2;
        } else {
            median = sorted[mid];
        }

        const variance = count > 1 ? Math.max(0, M2 / count) : 0; // Population variance
        const stdDev = Math.sqrt(variance);

        return {
            count,
            sum,
            mean: Number(mean.toFixed(4)),
            median: Number(median.toFixed(4)),
            min,
            max,
            variance: Number(variance.toFixed(4)),
            stdDev: Number(stdDev.toFixed(4))
        };
    }
};

/**
 * Built-in variance calculator tool.
 */
export const varianceTool: SwarmTool<
    { numbers: number[]; sample?: boolean },
    { variance: number }
> = {
    name: 'variance',
    description: 'Computes the variance of a dataset. Set sample=true for sample variance.',
    parameters: {
        numbers: {
            type: 'array',
            description: 'Array of numbers',
            required: true
        },
        sample: {
            type: 'boolean',
            description: 'Whether to calculate sample variance (n-1). Default is false (population variance).',
            required: false
        }
    },
    execute({ numbers, sample = false }) {
        if (!Array.isArray(numbers) || numbers.length === 0) {
            throw new Error('variance requires a non-empty array of numbers.');
        }
        const valid = numbers.filter(n => typeof n === 'number' && !isNaN(n));
        if (valid.length === 0) throw new Error('No valid numbers provided.');

        const count = valid.length;
        if (sample && count <= 1) {
            return { variance: 0 }; // Cannot calculate sample variance for size 1
        }

        let mean = 0;
        let M2 = 0;

        for (let i = 0; i < count; i++) {
            const val = valid[i];
            const delta = val - mean;
            mean += delta / (i + 1);
            const delta2 = val - mean;
            M2 += delta * delta2;
        }

        const divisor = sample ? count - 1 : count;
        const variance = Math.max(0, M2 / divisor);

        return { variance: Number(variance.toFixed(4)) };
    }
};

/**
 * Built-in standard deviation calculator tool.
 */
export const standardDeviationTool: SwarmTool<
    { numbers: number[]; sample?: boolean },
    { stdDev: number }
> = {
    name: 'standard_deviation',
    description: 'Computes the standard deviation of a dataset. Set sample=true for sample standard deviation.',
    parameters: {
        numbers: {
            type: 'array',
            description: 'Array of numbers',
            required: true
        },
        sample: {
            type: 'boolean',
            description: 'Whether to calculate sample standard deviation (n-1). Default is false.',
            required: false
        }
    },
    execute({ numbers, sample = false }) {
        const result = varianceTool.execute({ numbers, sample });
        const variance = (result instanceof Promise) ? 0 : (result as { variance: number }).variance;
        return { stdDev: Number(Math.sqrt(variance).toFixed(4)) };
    }
};

/**
 * Built-in tool for odds conversion and implied probability calculation.
 */
export const probabilityTool: SwarmTool<
    { odds: number | string; format?: 'decimal' | 'american' | 'fractional' },
    { impliedProbability: number; decimalOdds: number; americanOdds: string; fractionalOdds: string }
> = {
    name: 'probability_odds_converter',
    description: 'Converts betting odds between decimal, american, and fractional formats and calculates implied probability.',
    parameters: {
        odds: {
            type: 'string',
            description: 'The odds value (e.g. 1.5, -200, "1/2")',
            required: true
        },
        format: {
            type: 'string',
            description: 'The format of the input odds ("decimal", "american", "fractional"). If not provided, it will attempt to auto-detect.',
            required: false
        }
    },
    execute(params: any) {
        let odds = params.odds;
        let format = params.format;

        let decimalOdds = 0;

        // Auto-detect format if not provided
        if (!format) {
            if (typeof odds === 'string' && odds.includes('/')) {
                format = 'fractional';
            } else if (Number(odds) >= 100 || Number(odds) <= -100 || (typeof odds === 'string' && (odds.startsWith('+') || odds.startsWith('-')))) {
                format = 'american';
            } else {
                format = 'decimal';
            }
        }

        // Convert to decimal first
        if (format === 'fractional') {
            const [num, den] = String(odds).split('/').map(Number);
            if (isNaN(num) || isNaN(den) || den === 0) throw new Error('Invalid fractional odds format.');
            decimalOdds = (num / den) + 1;
        } else if (format === 'american') {
            const numOdds = Number(odds);
            if (isNaN(numOdds)) throw new Error('Invalid american odds format.');
            if (numOdds > 0) {
                decimalOdds = (numOdds / 100) + 1;
            } else if (numOdds < 0) {
                decimalOdds = (100 / Math.abs(numOdds)) + 1;
            } else {
                throw new Error('American odds cannot be 0.');
            }
        } else {
            decimalOdds = Number(odds);
            if (isNaN(decimalOdds) || decimalOdds < 1) throw new Error('Invalid decimal odds format.');
        }

        // Calculate implied probability
        const impliedProbability = 1 / decimalOdds;

        // Calculate other formats from decimal
        let americanOdds = '';
        if (decimalOdds >= 2.0) {
            americanOdds = '+' + Math.round((decimalOdds - 1) * 100);
        } else {
            americanOdds = '-' + Math.round(100 / (decimalOdds - 1));
        }

        // Very basic fractional approximation
        const fracDen = 100;
        const fracNum = Math.round((decimalOdds - 1) * 100);
        const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
        const common = gcd(fracNum, fracDen);
        const fractionalOdds = `${fracNum / common}/${fracDen / common}`;

        return {
            impliedProbability: Number(impliedProbability.toFixed(4)),
            decimalOdds: Number(decimalOdds.toFixed(2)),
            americanOdds,
            fractionalOdds
        };
    }
};

/**
 * Built-in linear regression trend slope calculator.
 */
export const trendSlopeTool: SwarmTool<
    { data: number[] | {x: number, y: number}[] },
    { slope: number; intercept: number; trend: string }
> = {
    name: 'trend_slope',
    description: 'Calculates the linear regression slope of a dataset to identify trends (positive, negative, flat).',
    parameters: {
        data: {
            type: 'array',
            description: 'Array of numbers (y-values) or objects with x,y coordinates',
            required: true
        }
    },
    execute({ data }) {
        if (!Array.isArray(data) || data.length < 2) {
            throw new Error('trend_slope requires an array with at least 2 data points.');
        }

        let points: {x: number, y: number}[] = [];

        if (typeof data[0] === 'number') {
            points = (data as number[]).map((y, x) => ({ x, y }));
        } else if (typeof data[0] === 'object' && 'x' in data[0] && 'y' in data[0]) {
            points = data as {x: number, y: number}[];
        } else {
            throw new Error('Invalid data format. Must be array of numbers or {x,y} objects.');
        }

        const n = points.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;

        for (const p of points) {
            sumX += p.x;
            sumY += p.y;
            sumXY += p.x * p.y;
            sumXX += p.x * p.x;
        }

        const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
        const intercept = (sumY - slope * sumX) / n;

        let trend = 'flat';
        if (slope > 0.01) trend = 'positive';
        else if (slope < -0.01) trend = 'negative';

        return {
            slope: Number(slope.toFixed(4)),
            intercept: Number(intercept.toFixed(4)),
            trend
        };
    }
};
