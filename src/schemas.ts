import { z } from 'zod';

export const AnalystResponseSchema = z.object({
  insights: z.array(z.string()).describe("Key analytical insights derived from the data chunk"),
  anomalies: z.array(z.string()).describe("Any anomalies, errors, or unusual patterns detected in the data"),
  summary: z.string().describe("A brief 1-2 sentence summary of the analysis")
});

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

export type AnalystResponse = z.infer<typeof AnalystResponseSchema>;
export type ManagerResponse = z.infer<typeof ManagerResponseSchema>;
