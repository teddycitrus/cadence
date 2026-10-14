import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// pdf.js draws PDFs' standard fonts (Helvetica, Times) from files it ships.
const STANDARD_FONTS = `${join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "standard_fonts").split("\\").join("/")}/`;

export interface DocumentText {
  text: string;
  /** PDFs only: page count, and pages with no extractable text (scans, diagrams). */
  pages?: number;
  pagesWithoutText?: number[];
  truncated: boolean;
}

const MAX_CHARS = 200_000;
const MAX_PDF_PAGES = 200;

const kindOf = (name: string, mediaType: string) => {
  const n = name.toLowerCase();
  if (mediaType === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (n.endsWith(".docx") || mediaType.includes("wordprocessingml")) return "docx";
  if (/\.(md|markdown|txt|csv|json|log|ya?ml)$/.test(n) || mediaType.startsWith("text/")) return "text";
  return null;
};

async function pdfText(data: Buffer): Promise<Omit<DocumentText, "truncated">> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: false, disableFontFace: true, standardFontDataUrl: STANDARD_FONTS });
  const doc = await task.promise;
  try {
    const parts: string[] = [];
    const empty: number[] = [];
    const count = Math.min(doc.numPages, MAX_PDF_PAGES);
    for (let n = 1; n <= count; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items.map((i) => ("str" in i ? i.str + (i.hasEOL ? "\n" : "") : "")).join("").trim();
      if (!text) empty.push(n);
      parts.push(`--- Page ${n} ---\n${text}`);
    }
    return { text: parts.join("\n\n"), pages: doc.numPages, pagesWithoutText: empty };
  } finally {
    await task.destroy();
  }
}

/**
 * A Google Doc's text through its plain-text export, which works for docs
 * shared with "anyone with the link". A sign-in page means it is not shared
 * that way (the editor page loading is no test: it can load for anyone).
 */
export async function googleDocText(url: string, fetchImpl: typeof fetch = fetch): Promise<{ id: string; text: string; truncated: boolean }> {
  const m = /^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([\w-]{20,})/.exec(url.trim());
  if (!m) throw new Error("Not a Google Docs link (https://docs.google.com/document/d/...)");
  const res = await fetchImpl(`https://docs.google.com/document/d/${m[1]}/export?format=txt`, { redirect: "follow" });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || type.includes("text/html")) throw new Error("That doc is not shared with anyone who has the link, so it cannot be read without signing in. Ask for it to be shared that way, or exported to Slack as a file.");
  const text = (await res.text()).replace(/^﻿/, "");
  return { id: m[1]!, text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS };
}

/**
 * One PDF page as a PNG, for scans and diagrams with no text layer. Rendered
 * at up to 1600px on the long side so a vision model can read it.
 */
export async function pdfPageImage(data: Buffer, page: number): Promise<{ png: Buffer; pages: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  const task = pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: false, standardFontDataUrl: STANDARD_FONTS });
  const doc = await task.promise;
  try {
    if (!Number.isInteger(page) || page < 1 || page > doc.numPages) throw new Error(`The PDF has ${doc.numPages} pages; ask for 1 to ${doc.numPages}`);
    const p = await doc.getPage(page);
    const base = p.getViewport({ scale: 1 });
    const viewport = p.getViewport({ scale: Math.min(4, 1600 / Math.max(base.width, base.height)) });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await p.render({ canvas: canvas as never, canvasContext: ctx as never, viewport }).promise;
    return { png: canvas.toBuffer("image/png"), pages: doc.numPages };
  } finally {
    await task.destroy();
  }
}

/** Plain text of a Word document, PDF, Markdown, or text file, for agents to read. */
export async function documentText(name: string, mediaType: string, data: Buffer): Promise<DocumentText> {
  const kind = kindOf(name, mediaType);
  if (!kind) throw new Error(`Cannot read ${name}: only .docx, .pdf, Markdown, and text files`);
  const out = kind === "pdf" ? await pdfText(data) : kind === "docx" ? { text: (await (await import("mammoth")).default.extractRawText({ buffer: data })).value } : { text: data.toString("utf8") };
  const truncated = out.text.length > MAX_CHARS;
  return { ...out, text: truncated ? out.text.slice(0, MAX_CHARS) : out.text, truncated };
}
