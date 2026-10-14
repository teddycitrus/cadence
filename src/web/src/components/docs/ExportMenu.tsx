import { useState } from "react";

/** The doc's rendered HTML on a plain page, for the browser's "Save as PDF". */
function printDoc(title: string) {
  const body = document.querySelector(".tiptap")?.innerHTML ?? "";
  const win = window.open("", "_blank", "width=900,height=1100");
  if (!win) return;
  const safeTitle = title.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title><style>
    body { font: 15px/1.6 system-ui, sans-serif; color: #3c1b29; max-width: 720px; margin: 40px auto; padding: 0 24px; }
    h1, h2, h3, h4 { font-family: Newsreader, Georgia, "Iowan Old Style", serif; font-weight: 500; letter-spacing: -0.01em; } h1 { font-size: 34px; } h2 { font-size: 26px; } h3 { font-size: 20px; } h4 { font-size: 16px; }
    pre, code { font-family: ui-monospace, monospace; background: #f3ead9; border-radius: 4px; } pre { padding: 12px; overflow: auto; }
    blockquote { border-left: 3px solid #c3a983; margin-left: 0; padding-left: 12px; color: #775858; }
    table { border-collapse: collapse; } td, th { border: 1px solid #d7c09b; padding: 4px 8px; }
    img { max-width: 100%; } mark { background: #ecd9a0; } a { color: #485218; }
    ${["gray:#857566", "brown:#8a5a3c", "orange:#b5602a", "yellow:#9a7414", "green:#557035", "blue:#3d6a7c", "purple:#6d4a7a", "pink:#a5506a", "red:#a8382a"].map((p) => { const [n, c] = p.split(":"); return `[data-color="${n}"]:not(mark){color:${c}} mark[data-color="${n}"]{background:${c}22}`; }).join(" ")}
    @media print { body { margin: 0; } }
  </style></head><body><h1>${safeTitle}</h1>${body}</body></html>`);
  win.document.close();
  win.focus();
  // Give images a moment to load, then open the print dialog (choose "Save as PDF").
  setTimeout(() => win.print(), 300);
}

/** Download the doc as Markdown, or print it to PDF. */
export function ExportMenu({ docId, title }: { docId: string; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <button className="rounded-md px-2.5 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800/70" onClick={() => setOpen((o) => !o)}>
        Export
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 w-48 rounded-lg bg-zinc-900 py-1 text-sm shadow-2xl ring-1 ring-zinc-700">
            <a className="block px-3 py-1.5 text-zinc-200 hover:bg-zinc-800" href={`/api/docs/${docId}/export`} onClick={() => setOpen(false)}>
              Markdown (.md)
            </a>
            <button className="block w-full px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-800" onClick={() => (setOpen(false), printDoc(title))}>
              PDF (print)
            </button>
          </div>
        </>
      )}
    </span>
  );
}
