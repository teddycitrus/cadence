/** Short-lived signals that are not worth persisting, such as streamed text. */
export type Ephemeral =
  | { type: "delta"; chatId: string; text: string }
  | { type: "delta_reset"; chatId: string }
  | { type: "presence"; viewers: { memberId: string; place: string; at: number }[] }
  | { type: "canvas_editing"; editing: { workspaceId: string; path: string | null; actor: string; since: string }[] }
  | { type: "canvas_refresh"; workspaceId: string; path: string | null };

export class EphemeralBus {
  private listeners = new Set<(e: Ephemeral) => void>();

  emit(e: Ephemeral): void {
    for (const l of this.listeners) l(e);
  }

  subscribe(listener: (e: Ephemeral) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
