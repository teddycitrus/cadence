import type { Interaction, InteractionKind, Question } from "../core/types";
import type { ApprovalAnswer } from "../agents/runtime";

export type InteractionAnswer =
  | { kind: "tool"; allow: boolean; always?: boolean; message?: string }
  | { kind: "question"; answers: Record<string, string> }
  | { kind: "plan"; action: "approve" | "revise" | "execute_fresh"; feedback?: string };

export function classify(toolName: string, input: Record<string, unknown>): { kind: InteractionKind; questions: Question[]; plan: string | null } {
  if (toolName === "AskUserQuestion") {
    const raw = Array.isArray(input.questions) ? (input.questions as Partial<Question>[]) : [];
    const questions = raw.map((q) => ({
      question: String(q.question ?? ""),
      header: String(q.header ?? ""),
      options: Array.isArray(q.options) ? q.options.map((o) => ({ label: String(o.label ?? ""), description: String(o.description ?? "") })) : [],
      multiSelect: Boolean(q.multiSelect),
    }));
    return { kind: "question", questions, plan: null };
  }
  if (toolName === "ExitPlanMode") {
    return { kind: "plan", questions: [], plan: typeof input.plan === "string" ? input.plan : null };
  }
  return { kind: "tool", questions: [], plan: null };
}

/** Maps a person's answer onto what the harness expects, plus a short record of the decision. */
export function toApproval(interaction: Interaction, answer: InteractionAnswer): { approval: ApprovalAnswer; resolution: string } {
  if (answer.kind !== interaction.kind) throw new Error(`This is a ${interaction.kind} request, not a ${answer.kind}`);
  switch (answer.kind) {
    case "tool":
      return answer.allow
        ? { approval: { allow: true, always: Boolean(answer.always) }, resolution: answer.always ? "Allowed always" : "Allowed once" }
        : { approval: { allow: false, message: answer.message || "The user denied this action." }, resolution: `Denied${answer.message ? `: ${answer.message}` : ""}` };
    case "question": {
      const lines = Object.entries(answer.answers).map(([q, a]) => `${q} ${a}`);
      return { approval: { allow: true, updatedInput: { ...interaction.input, answers: answer.answers } }, resolution: lines.join("\n") };
    }
    case "plan":
      if (answer.action === "approve") return { approval: { allow: true }, resolution: "Plan approved" };
      if (answer.action === "execute_fresh") return { approval: { allow: false, message: "The plan was approved and will be carried out in a fresh chat.", interrupt: true }, resolution: "Approved; executing in a new chat" };
      return { approval: { allow: false, message: `Keep planning. Feedback: ${answer.feedback || "Revise the plan."}` }, resolution: `Revise: ${answer.feedback ?? ""}` };
  }
}
