import { AsyncLocalStorage } from "node:async_hooks";
import type { Actor, Role } from "../core/types";

export interface RequestIdentity {
  actor: Actor;
  memberId: string;
  role: Role;
}

const storage = new AsyncLocalStorage<RequestIdentity>();

/** Runs `fn` with the signed-in person as the default actor for every command it triggers. */
export function withIdentity<T>(identity: RequestIdentity, fn: () => T): T {
  return storage.run(identity, fn);
}

export function currentIdentity(): RequestIdentity | null {
  return storage.getStore() ?? null;
}

/** The person behind the current request, or the owner outside a request (CLI, tests, timers). */
export function currentActor(): Actor {
  return storage.getStore()?.actor ?? "user";
}

export const actorForMember = (memberId: string): Actor => (memberId === "me" ? "user" : `member:${memberId}`);

/** The member behind a human actor, or null for agents and the system. */
export function memberIdOf(actor: Actor): string | null {
  if (actor === "user") return "me";
  return actor.startsWith("member:") ? actor.slice(7) : null;
}
