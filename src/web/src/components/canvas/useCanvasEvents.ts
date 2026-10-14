import { useEffect } from "react";
import { COMPOSER_CONTEXT_EVENT } from "../chat/composer-context";

/** Pasting a Figma frame link onto the canvas imports that frame. */
export function useFigmaPaste(workspaceId: string, path: string, onLink: (url: string) => void) {
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!/figma\.com\/(design|file|proto)\/.*node-id=/.test(text)) return;
      e.preventDefault();
      onLink(text.trim());
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [workspaceId, path]);
}

/** Opens the canvas's chat panel when a selection is sent to this workspace's chat. */
export function useOpenChatOnContext(workspaceId: string, open: () => void) {
  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent<string>).detail === workspaceId && open();
    window.addEventListener(COMPOSER_CONTEXT_EVENT, on);
    return () => window.removeEventListener(COMPOSER_CONTEXT_EVENT, on);
  }, [workspaceId]);
}
