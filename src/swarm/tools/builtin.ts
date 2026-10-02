import type { SwarmTool } from './types.ts';
import { safeEvaluateMath, calculatorTool } from './mathTools.ts';
import { statsSummaryTool, varianceTool, standardDeviationTool, probabilityTool, trendSlopeTool } from './statsTools.ts';
import { regexMatchTool, computeLevenshteinDistance, stringSimilarityTool } from './stringTools.ts';
import { extractJsonPath, jsonExtractTool, dataFilterTool } from './dataTools.ts';
import { dateMathTool } from './dateTools.ts';

export * from './mathTools.ts';
export * from './statsTools.ts';
export * from './stringTools.ts';
export * from './dataTools.ts';
export * from './dateTools.ts';

export const standardBuiltinTools: SwarmTool[] = [
    calculatorTool,
    statsSummaryTool,
    regexMatchTool,
    jsonExtractTool,
    dataFilterTool,
    stringSimilarityTool,
    dateMathTool,
    varianceTool,
    standardDeviationTool,
    probabilityTool,
    trendSlopeTool
];
