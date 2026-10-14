import { useRef, useState } from "react";
import type { Snapshot } from "../../../core/types";
import { api } from "../api";
import { navigate } from "../App";
import { DocPage, fileToBase64 } from "./docs/DocPage";
import { DocTree } from "./docs/DocTree";
import { Empty, ErrorText, inputClass, useAction } from "./ui";

export function DocsView({ snapshot, selected }: { snapshot: Snapshot; selected: string | null }) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const action = useAction();
  const fileInput = useRef<HTMLInputElement>(null);
  const doc = selected ? snapshot.docs.find((d) => d.id === selected) : undefined;

  const importFiles = (files: FileList) =>
    action.run(async () => {
      let last = "";
      for (const file of [...files]) {
        const created = await api.importDoc({ name: file.name, mediaType: file.type, data: await fileToBase64(file), parentId: null });
        last = created.id;
      }
      if (last) navigate("docs", last);
    });

  return (
    <div className="flex h-full">
      <aside data-sidebar-pane className="flex w-64 shrink-0 flex-col border-r border-zinc-900">
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h2 className="font-semibold">Docs</h2>
          <span className="flex items-center gap-2 text-zinc-500">
            <button className="text-xs hover:text-zinc-100" title="Import Markdown, Word, or PDF" onClick={() => fileInput.current?.click()}>
              Import
            </button>
            <button
              className="text-lg leading-none hover:text-zinc-100"
              title="New doc"
              onClick={() => action.run(async () => navigate("docs", (await api.createDoc({ title: "Untitled" })).id))}
            >
              +
            </button>
          </span>
          <input ref={fileInput} type="file" hidden multiple accept=".md,.markdown,.txt,.docx,.pdf,text/*,application/pdf" onChange={(e) => e.target.files && importFiles(e.target.files)} />
        </div>
        <div className="px-3 pb-2">
          <input className={inputClass} placeholder="Search docs" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          <DocTree docs={snapshot.docs} selected={selected} query={query} onError={setError} />
          {snapshot.docs.length === 0 && <p className="px-2 py-6 text-center text-sm text-zinc-500">No docs yet</p>}
        </nav>
        <div className="px-3 pb-3">
          <ErrorText>{error ?? action.error}</ErrorText>
        </div>
      </aside>
      {doc ? (
        <DocPage key={doc.id} docId={doc.id} snapshot={snapshot} />
      ) : (
        <div className="flex-1 p-8">
          <Empty title={snapshot.docs.length ? "Pick a doc to open" : "No docs yet"}>
            Docs define what to build. Write one here, then generate canvases from it. Nest docs as sub-pages, link them to issues, embed canvases, and import Markdown, Word, or PDF files. Agents read and edit the same docs.
          </Empty>
        </div>
      )}
    </div>
  );
}
