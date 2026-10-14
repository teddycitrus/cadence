import { api } from "../../api";
import { navigate } from "../../App";
import { openBeside } from "../Workbench";

/** Opens the Welcome workspace's chat with the tour canvas beside it (creating both). */
export async function openWelcome(projectId: string | null): Promise<void> {
  const w = await api.startWelcome(projectId);
  navigate("chats", w.chatId);
  openBeside(`#/canvas/${encodeURIComponent(`${w.workspaceId}|${w.canvasPath}`)}`);
}
