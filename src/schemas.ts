import { z } from 'zod';

export const AnalystResponseSchema = z.object({
  insights: z.array(z.string()).describe("Key analytical insights derived from the data chunk"),
  anomalies: z.array(z.string()).describe("Any anomalies, errors, or unusual patterns detected in the data"),
  summary: z.string().describe("A brief 1-2 sentence summary of the analysis")
});

export const ManagerResponseSchema = z.object({
  synthesis: z.string().describe("The final synthesized markdown report combining insights from all analysts"),
  action_plan: z.array(
    z.object({
      step: z.string(),
      description: z.string()
    })
  ).describe("A list of actionable steps derived from the analysis")
});

export type AnalystResponse = z.infer<typeof AnalystResponseSchema>;
export type ManagerResponse = z.infer<typeof ManagerResponseSchema>;
