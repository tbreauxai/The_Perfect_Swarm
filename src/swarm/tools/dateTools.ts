import type { SwarmTool } from './types.ts';

/**
 * Built-in date and duration calculator tool.
 */
export const dateMathTool: SwarmTool<
    any,
    any
> = {
    name: 'date_math',
    description: 'Calculates the duration/difference between two dates or performs date arithmetic (add/subtract).',
    parameters: {
        startDate: {
            type: 'string',
            description: 'Starting date/timestamp in ISO or parseable format (or dateA)',
            required: true
        },
        endDate: {
            type: 'string',
            description: 'Ending date/timestamp (or dateB)',
            required: false
        },
        operation: {
            type: 'string',
            description: 'Operation: "diff", "add", or "subtract" (default: "diff")',
            required: false
        },
        amount: {
            type: 'number',
            description: 'Amount to add or subtract when operation is "add" or "subtract"',
            required: false
        },
        unit: {
            type: 'string',
            description: 'Unit: "seconds", "minutes", "hours", "days", "milliseconds" (default: "seconds")',
            required: false
        }
    },
    execute(rawParams: any) {
        const operation = rawParams.operation || 'diff';
        const rawStart = rawParams.startDate || rawParams.dateA || rawParams.start || rawParams.date;
        const rawEnd = rawParams.endDate || rawParams.dateB || rawParams.end;
        const unit = rawParams.unit || 'seconds';
        const amount = rawParams.amount ?? 0;

        const start = new Date(rawStart);
        if (isNaN(start.getTime())) throw new Error(`date_math: Invalid startDate '${rawStart}'`);

        if (operation === 'add' || operation === 'subtract') {
            const multiplier = operation === 'subtract' ? -1 : 1;
            let msOffset = 0;
            switch (unit) {
                case 'milliseconds':
                    msOffset = amount;
                    break;
                case 'seconds':
                    msOffset = amount * 1000;
                    break;
                case 'minutes':
                    msOffset = amount * 60000;
                    break;
                case 'hours':
                    msOffset = amount * 3600000;
                    break;
                case 'days':
                default:
                    msOffset = amount * 86400000;
                    break;
            }
            const resDate = new Date(start.getTime() + (msOffset * multiplier));
            return {
                operation,
                resultDate: resDate.toISOString(),
                startIso: start.toISOString(),
                amount,
                unit
            };
        }

        const end = rawEnd ? new Date(rawEnd) : new Date();
        if (isNaN(end.getTime())) throw new Error(`date_math: Invalid endDate '${rawEnd}'`);

        const diffMs = Math.abs(end.getTime() - start.getTime());
        let difference: number;

        switch (unit) {
            case 'milliseconds':
                difference = diffMs;
                break;
            case 'minutes':
                difference = Number((diffMs / 60000).toFixed(2));
                break;
            case 'hours':
                difference = Number((diffMs / 3600000).toFixed(2));
                break;
            case 'days':
                difference = Number((diffMs / 86400000).toFixed(2));
                break;
            case 'seconds':
            default:
                difference = Number((diffMs / 1000).toFixed(2));
                break;
        }

        return {
            difference,
            diff: difference,
            unit,
            isPast: (end.getTime() - start.getTime()) < 0,
            startIso: start.toISOString(),
            endIso: end.toISOString()
        };
    }
};
