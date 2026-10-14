import { z } from "zod";
import { define, type BoardTool } from "./board-tools";

// Code review findings as data, so the chat can show them as a list (worst
// first) instead of prose, and people can jump to each file.

export const FINDING_SEVERITIES = ["high", "medium", "low"] as const;

export const FindingSchema = z.object({
  file: z.string().min(1).max(500),
  line: z.number().int().min(1).max(1_000_000).optional(),
  severity: z.enum(FINDING_SEVERITIES),
  summary: z.string().min(1).max(500),
  failureScenario: z.string().max(2000).optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

export function reviewTools(): BoardTool[] {
  return [
    define({
      name: "report_findings",
      description:
        "Report the result of a code review as structured findings (ranked high, medium, low), shown to people as a list. Call it once with everything you verified; an empty list means nothing was found. Each finding names the file (and line), says what is wrong in one sentence, and how it fails (inputs or state that lead to the wrong result).",
      shape: { title: z.string().max(200).optional(), findings: z.array(FindingSchema).max(50) },
      run: (a) => {
        const order = { high: 0, medium: 1, low: 2 } as const;
        const sorted = [...a.findings].sort((x, y) => order[x.severity] - order[y.severity]);
        if (!sorted.length) return "Reported: no findings.";
        const counts = FINDING_SEVERITIES.map((s) => `${sorted.filter((f) => f.severity === s).length} ${s}`).join(", ");
        return `Reported ${sorted.length} finding${sorted.length === 1 ? "" : "s"} (${counts}).`;
      },
    }),
  ];
}
