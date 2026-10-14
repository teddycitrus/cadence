import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../../../core/types";
import { api } from "../api";
import { Button, ErrorText, Field, inputClass, useAction } from "./ui";

// Recent page errors, kept so a bug report can include them.
const recentErrors: string[] = [];
const note = (text: string) => {
  recentErrors.push(`${new Date().toISOString().slice(11, 19)} ${text}`.slice(0, 500));
  if (recentErrors.length > 20) recentErrors.shift();
};
window.addEventListener("error", (e) => note(e.message || String(e.error)));
window.addEventListener("unhandledrejection", (e) => note(`Unhandled rejection: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`));

const MAX_BYTES = 24 * 1024 * 1024;

function toBase64(blob: Blob | File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the recording"));
    reader.readAsDataURL(blob);
  });
}

/** The report's body: what happened, the recording, and where it happened. */
export function bugReportBody(input: { description: string; recordingUrl: string | null; files?: { name: string; url: string; image: boolean }[]; where: string; browser: string; errors: string[] }): string {
  return [
    input.description.trim() || "_No description._",
    ...(input.recordingUrl ? ["", `![Screen recording](${input.recordingUrl} "video")`] : []),
    ...(input.files?.length ? ["", ...input.files.map((f) => (f.image ? `![${f.name}](${f.url})` : `[${f.name}](${f.url})`))] : []),
    "",
    `**Where:** \`${input.where || "#/home"}\``,
    `**Browser:** ${input.browser}`,
    ...(input.errors.length ? ["", "**Recent errors:**", "```", ...input.errors, "```"] : []),
  ].join("\n");
}

/** Files a bug on the board, optionally with a screen recording of it happening. */
export function BugReport({ snapshot, onClose }: { snapshot: Snapshot; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState(snapshot.projects[0]?.id ?? "");
  const [recording, setRecording] = useState<Blob | null>(null);
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const where = useRef(window.location.hash);
  const action = useAction();
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const record = () =>
    action.run(async () => {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("This browser cannot record the screen");
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
      const type = ["video/webm;codecs=vp9", "video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
      const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 1_500_000 });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: rec.mimeType.split(";")[0] });
        setRecording(blob);
        setPreview(URL.createObjectURL(blob));
        setRecorder(null);
      };
      // Stopping the share from the browser's own bar ends the recording too.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => rec.state === "recording" && rec.stop());
      rec.start(1000);
      setRecorder(rec);
    });

  const submit = () =>
    action.run(async () => {
      let recordingUrl: string | null = null;
      if (recording) {
        if (recording.size > MAX_BYTES) throw new Error("The recording is over 24 MB; record a shorter one");
        const ext = recording.type === "video/mp4" ? "mp4" : "webm";
        recordingUrl = (await api.uploadAsset({ name: `bug-recording.${ext}`, mediaType: recording.type, data: await toBase64(recording) })).url;
      }
      const total = files.reduce((n, f) => n + f.size, 0) + (recording?.size ?? 0);
      if (total > MAX_BYTES) throw new Error("Attachments and the recording together are over 24 MB; remove some");
      const uploaded = [];
      for (const f of files) uploaded.push({ name: f.name, url: (await api.uploadAsset({ name: f.name, mediaType: f.type || "application/octet-stream", data: await toBase64(f) })).url, image: f.type.startsWith("image/") });
      const issue = await api.createIssue({
        title: title.trim(),
        type: "bug",
        projectId: projectId || null,
        body: bugReportBody({ description, recordingUrl, files: uploaded, where: where.current, browser: navigator.userAgent, errors: [...recentErrors] }),
      });
      onClose();
      window.location.hash = `/issues/${issue.id}`;
    });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60" onClick={() => !recorder && onClose()}>
      <div className="w-[32rem] space-y-3 rounded-xl bg-zinc-900 p-5 shadow-2xl ring-1 ring-zinc-700" onClick={(e) => e.stopPropagation()}>
        <p className="font-display text-lg">Report a problem</p>
        <p className="text-xs text-zinc-400">It goes on the board as a bug, with the page you were on and recent errors. A recording shows what happened better than words.</p>
        <Field label="What went wrong">
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Canvas stops updating after a rename" autoFocus />
        </Field>
        <Field label="Details">
          <textarea className={`${inputClass} min-h-24`} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What you did, what you expected, what happened instead" />
        </Field>
        {snapshot.projects.length > 1 && (
          <Field label="Project">
            <select className={inputClass} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">No project</option>
              {snapshot.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="flex items-center gap-2">
          {recorder ? (
            <Button onClick={() => recorder.stop()}>
              <span className="mr-1.5 inline-block size-2 animate-pulse rounded-full bg-red-500" />
              Stop recording
            </Button>
          ) : (
            <Button onClick={() => void record()} disabled={action.busy}>
              {recording ? "Record again" : "Record screen"}
            </Button>
          )}
          {recording && !recorder && <span className="text-xs text-zinc-500">{(recording.size / 1024 / 1024).toFixed(1)} MB recorded</span>}
          <label className="ml-auto cursor-pointer text-xs text-violet-300 hover:underline">
            Attach files
            <input type="file" hidden multiple onChange={(e) => e.target.files && setFiles([...files, ...e.target.files].slice(0, 10))} />
          </label>
        </div>
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1 text-xs">
            {files.map((f, i) => (
              <button key={`${f.name}${i}`} className="rounded bg-zinc-800 px-2 py-0.5 text-zinc-300 hover:text-red-400" title="Remove" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                {f.name} ({Math.max(1, Math.round(f.size / 1024))} KB) x
              </button>
            ))}
          </div>
        )}
        {preview && !recorder && <video src={preview} controls className="max-h-48 w-full rounded-md bg-black" />}
        <div className="flex items-center gap-2 pt-1">
          <Button variant="primary" disabled={!title.trim() || Boolean(recorder) || action.busy} onClick={() => void submit()}>
            {action.busy ? "Filing..." : "File bug"}
          </Button>
          <Button variant="ghost" disabled={Boolean(recorder)} onClick={onClose}>
            Cancel
          </Button>
        </div>
        <ErrorText>{action.error}</ErrorText>
      </div>
    </div>
  );
}
