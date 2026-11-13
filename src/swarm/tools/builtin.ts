import type { SwarmTool } from './types.ts';
import { safeEvaluateMath, calculatorTool } from './mathTools.ts';
import { statsSummaryTool, varianceTool, standardDeviationTool, probabilityTool, trendSlopeTool } from './statsTools.ts';
import { regexMatchTool, computeLevenshteinDistance, stringSimilarityTool } from './stringTools.ts';
import { extractJsonPath, jsonExtractTool, dataFilterTool } from './dataTools.ts';
import { dateMathTool } from './dateTools.ts';
import {
    holtWintersForecastTool,
    autocorrelationRegimeTool,
    kellyEdgeSizerTool,
    monteCarloBootstrapTool
} from './forecastingTools.ts';
import { dueloddsSupabaseLookupTool } from './supabaseTools.ts';
import { getGameContextTool } from './gameContextTool.ts';
import {
    getMatchupFundamentalsTool,
    getInjuryAndRosterDeltaTool,
    getPlayerPropSplitsTool,
    getEnvironmentAndWeatherTool,
    getMarketMovementTool,
    getHistoricalLessonsTool,
    dueloddsRpcTools
} from './dueloddsRpcTools.ts';

export * from './mathTools.ts';
export * from './statsTools.ts';
export * from './stringTools.ts';
export * from './dataTools.ts';
export * from './dateTools.ts';
export * from './forecastingTools.ts';
export * from './supabaseTools.ts';
export * from './dueloddsRpcTools.ts';

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
    trendSlopeTool,
    holtWintersForecastTool,
    autocorrelationRegimeTool,
    kellyEdgeSizerTool,
    monteCarloBootstrapTool,
    getGameContextTool,
    dueloddsSupabaseLookupTool,
    getMatchupFundamentalsTool,
    getInjuryAndRosterDeltaTool,
    getPlayerPropSplitsTool,
    getEnvironmentAndWeatherTool,
    getMarketMovementTool,
    getHistoricalLessonsTool
];

export { getGameContextTool } from './gameContextTool.ts';
