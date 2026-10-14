import type { Snapshot } from "../../../core/types";
import { usePresence } from "../live";
import { UserAvatar } from "./ui";

/** Avatars of the other people looking at the same thing right now. */
export function Viewers({ place, snapshot }: { place: string; snapshot: Snapshot }) {
  const others = usePresence(place).filter((v) => v.memberId !== snapshot.viewer.memberId);
  if (!others.length) return null;
  const names = others.map((v) => snapshot.members.find((m) => m.id === v.memberId)?.name ?? "Someone");
  return (
    <span className="flex items-center -space-x-1.5" title={`Also here: ${names.join(", ")}`}>
      {others.slice(0, 5).map((v) => (
        <span key={v.memberId} className="rounded-full ring-2 ring-zinc-950">
          <UserAvatar size="size-6" member={snapshot.members.find((m) => m.id === v.memberId)} />
        </span>
      ))}
      {others.length > 5 && <span className="pl-2 text-xs text-zinc-400">+{others.length - 5}</span>}
    </span>
  );
}
