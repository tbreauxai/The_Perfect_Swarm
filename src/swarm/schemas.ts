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
 * Generative UI synthesis schema for Manager Node dashboards.
 */
export const ManagerResponseSchema = z.object({
  ui_title: z.string().describe("Dashboard Title"),
  components: z.array(
    z.discriminatedUnion("type", [
      z.object({
        id: z.string(),
        type: z.literal("MetricCard"),
        props: z.object({
          title: z.string(),
          value: z.string(),
          subtitle: z.string().optional(),
          trend: z.enum(["up", "down", "neutral"]).optional()
        })
      }),
      z.object({
        id: z.string(),
        type: z.literal("InsightList"),
        props: z.object({
          title: z.string(),
          insights: z.array(
            z.object({
              type: z.enum(["success", "warning", "info", "error"]),
              message: z.string()
            })
          )
        })
      }),
      z.object({
        id: z.string(),
        type: z.literal("DataTable"),
        props: z.object({
          title: z.string(),
          columns: z.array(
            z.object({
              key: z.string(),
              header: z.string()
            })
          ),
          rows: z.array(z.record(z.string(), z.any()))
        })
      })
    ])
  ).describe("Array of UI components to render the analysis")
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
export type ManagerResponse = z.infer<typeof ManagerResponseSchema>;
export type GenericAnalysisResponse = z.infer<typeof GenericAnalysisResponseSchema>;
