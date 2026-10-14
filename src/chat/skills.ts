import { randomUUID } from "node:crypto";
import { z } from "zod";
import { define, type BoardTool } from "../agents/board-tools";
import { BUILTIN_SKILLS, builtinSkill } from "../skills/builtin";
import { memberIdOf } from "../auth/context";
import { NotFoundError, ValidationError } from "../core/errors";
import type { EventStore } from "../core/event-store";
import type { Queries } from "../core/queries";
import type { Actor, Chat, Skill } from "../core/types";

const NAME = /^[a-z0-9][a-z0-9-]{0,48}$/;

/** Personal skills: named, reusable instructions a person (or their assistant) saves. */
export class SkillService {
  constructor(
    private store: EventStore,
    private q: Queries,
  ) {}

  list(ownerId: string): Skill[] {
    return this.q.skills(ownerId);
  }

  get(ownerId: string, name: string): Skill {
    const s = this.list(ownerId).find((x) => x.name === name);
    if (!s) throw new NotFoundError(`No skill named "${name}"`);
    return s;
  }

  /** Creates the skill, or replaces the one with the same name. */
  save(ownerId: string, input: { name: string; description: string; body: string }, actor: Actor): Skill {
    const name = input.name.trim().toLowerCase();
    if (!NAME.test(name)) throw new ValidationError("Skill names are lowercase words joined by dashes, like write-release-notes");
    if (!input.body.trim()) throw new ValidationError("A skill needs instructions");
    const id = this.list(ownerId).find((x) => x.name === name)?.id ?? randomUUID();
    this.store.append({ aggregate: "skill", type: "SkillSaved", aggregateId: id, payload: { ownerId, name, description: input.description.trim().slice(0, 300), body: input.body.slice(0, 50_000) } }, actor);
    return this.get(ownerId, name);
  }

  /** A copy under a free name (name-copy, name-copy-2, ...), to change without touching the original. */
  duplicate(ownerId: string, id: string, actor: Actor): Skill {
    const original = this.list(ownerId).find((x) => x.id === id);
    if (!original) throw new NotFoundError("Skill not found");
    const taken = new Set(this.list(ownerId).map((x) => x.name));
    const base = `${original.name}-copy`.slice(0, 45);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    return this.save(ownerId, { name, description: original.description, body: original.body }, actor);
  }

  delete(ownerId: string, id: string, actor: Actor): void {
    if (!this.list(ownerId).some((x) => x.id === id)) throw new NotFoundError("Skill not found");
    this.store.append({ aggregate: "skill", type: "SkillDeleted", aggregateId: id, payload: {} }, actor);
  }
}

/** The member who owns a person's chat (agents' chats have none). */
export function chatOwner(chat: Pick<Chat, "agentId" | "createdBy">): string | null {
  if (chat.agentId) return null;
  return memberIdOf(chat.createdBy ?? "user");
}

/** The chat owner's own system prompt and their skills, for the assistant's instructions. */
export function personalInstructions(q: Queries, chat: Pick<Chat, "agentId" | "createdBy">): string {
  const owner = chatOwner(chat);
  if (!owner) return "";
  const member = q.member(owner);
  const skills = q.skills(owner);
  const parts: string[] = [];
  if (member?.systemPrompt?.trim()) parts.push(`## ${member.name}'s standing instructions\n\n${member.systemPrompt.trim()}`);
  if (skills.length) {
    parts.push(
      `## ${member?.name ?? "This person"}'s skills\n\nSaved workflows. When a request matches one, read it with skill_get and follow it. Save new ones with skill_save when asked to remember how to do something.\n\n${skills.map((s) => `- ${s.name}: ${s.description || "(no description)"}`).join("\n")}`,
    );
  }
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}

export function skillTools(skills: SkillService): BoardTool[] {
  const owner = (ctx: { ownerId?: string | null }) => {
    if (!ctx.ownerId) throw new Error("Skills belong to a person; this chat has none");
    return ctx.ownerId;
  };
  return [
    define({
      name: "skill_list",
      description: "List the workflows you can follow: the person's saved skills, then the ones built into Cadence (also runnable as /name in a chat).",
      shape: {},
      run: (_a, ctx) => {
        const own = ctx.ownerId ? skills.list(ctx.ownerId).map((s) => `- ${s.name}: ${s.description}`) : [];
        const builtin = BUILTIN_SKILLS.map((s) => `- ${s.name} (built in): ${s.description}`);
        return [`Saved skills:\n${own.join("\n") || "- none yet"}`, `Built-in workflows:\n${builtin.join("\n")}`].join("\n\n");
      },
    }),
    define({
      name: "skill_get",
      description: "Read a saved skill's full instructions.",
      shape: { name: z.string().min(1) },
      run: (a, ctx) => {
        // The person's own skill wins over a built-in one with the same name.
        const own = ctx.ownerId ? skills.list(ctx.ownerId).find((s) => s.name === a.name.toLowerCase()) : null;
        const builtin = own ? null : builtinSkill(a.name);
        if (builtin) return `# ${builtin.name}: ${builtin.title}\n${builtin.description}\n\n${builtin.body("")}`;
        const s = skills.get(owner(ctx), a.name);
        return `# ${s.name}\n${s.description}\n\n${s.body}`;
      },
    }),
    define({
      name: "skill_save",
      description: "Save (or overwrite) a skill: a named, reusable workflow the person can ask for in any chat. Write it as clear step-by-step instructions.",
      shape: { name: z.string().min(1).max(49).describe("lowercase-with-dashes"), description: z.string().max(300), body: z.string().min(1).max(50_000) },
      run: (a, ctx) => `Saved skill "${skills.save(owner(ctx), a, ctx.actor).name}".`,
    }),
  ];
}
