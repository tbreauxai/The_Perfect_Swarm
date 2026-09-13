import { z } from 'zod';

/**
 * Domain-agnostic Analyst insight schema for swarm worker nodes.
 */
export const AnalystResponseSchema = z.object({
  insights: z.array(z.string()).describe("Key analytical insights derived from the data chunk"),
  anomalies: z.array(z.string()).describe("Any anomalies, errors, or unusual patterns detected in the data"),
  summary: z.string().describe("A brief 1-2 sentence summary of the analysis")
});

/**
 * Domain-agnostic generic analysis result schema for non-web / multi-app integration.
 */
export const GenericAnalysisResponseSchema = z.object({
  title: z.string().describe("Descriptive title of the analysis"),
  summary: z.string().describe("Executive summary of findings"),
  insights: z.array(z.string()).describe("Core insights discovered"),
  anomalies: z.array(z.string()).describe("Identified anomalies, outliers, or warnings"),
  metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Key quantitative metrics"),
  recommendations: z.array(z.string()).optional().describe("Recommended next actions"),
  metadata: z.record(z.string(), z.any()).optional().describe("App-specific contextual metadata")
});

export type AnalystResponse = z.infer<typeof AnalystResponseSchema>;
export type GenericAnalysisResponse = z.infer<typeof GenericAnalysisResponseSchema>;
