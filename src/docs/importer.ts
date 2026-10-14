import { ValidationError } from "../core/errors";
import type { Actor, Doc } from "../core/types";
import { assetUrl, type AssetStore } from "./assets";
import type { DocCommands } from "./commands";
import { currentActor } from "../auth/context";

export interface ImportInput {
  name: string;
  mediaType: string;
  data: Buffer;
  parentId: string | null;
  issueId: string | null;
}

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function titleFrom(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Imported doc";
}

/**
 * Word tables have no header row, and GFM tables need one, so the first row
 * of each table becomes the header. Cell paragraphs are flattened to text.
 */
function normalizeTables(html: string): string {
  return html.replace(/<table>([\s\S]*?)<\/table>/g, (_m, inner: string) => {
    const cells = inner.replace(/<td>\s*<p>([\s\S]*?)<\/p>\s*<\/td>/g, "<td>$1</td>");
    if (/<th[\s>]/.test(cells)) return `<table>${cells}</table>`;
    const firstRow = /<tr>([\s\S]*?)<\/tr>/.exec(cells);
    if (!firstRow) return `<table>${cells}</table>`;
    const header = firstRow[1]!.replace(/<td>/g, "<th>").replace(/<\/td>/g, "</th>");
    return `<table><thead><tr>${header}</tr></thead><tbody>${cells.replace(firstRow[0], "")}</tbody></table>`;
  });
}

/** Converts HTML to Markdown (loading the converter on first use, since most servers never import a Word file). */
export async function htmlToMarkdown(html: string): Promise<string> {
  const [{ default: TurndownService }, { gfm }] = await Promise.all([import("turndown"), import("turndown-plugin-gfm")]);
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  td.use(gfm);
  return td.turndown(normalizeTables(html)).trim();
}

/** Turns an uploaded file into a doc: markdown and text as-is, docx converted, PDF kept as a viewable file. */
export async function importFile(input: ImportInput, docs: DocCommands, assets: AssetStore, actor: Actor = currentActor()): Promise<Doc> {
  const name = input.name.toLowerCase();
  const base = { title: titleFrom(input.name), parentId: input.parentId, issueId: input.issueId };

  if (input.mediaType === "application/pdf" || name.endsWith(".pdf")) {
    const asset = assets.save(input.name, "application/pdf", input.data, actor);
    return docs.create({ ...base, kind: "pdf", assetId: asset.id }, actor);
  }
  if (input.mediaType === DOCX || name.endsWith(".docx")) {
    const { default: mammoth } = await import("mammoth");
    const result = await mammoth.convertToHtml(
      { buffer: input.data },
      {
        convertImage: mammoth.images.imgElement(async (image) => {
          const buffer = Buffer.from(await image.read("base64"), "base64");
          const asset = assets.save(`image.${image.contentType.split("/")[1] ?? "png"}`, image.contentType, buffer, actor);
          return { src: assetUrl(asset.id) };
        }),
      },
    );
    return docs.create({ ...base, body: await htmlToMarkdown(result.value) }, actor);
  }
  if (/\.(md|markdown|txt)$/.test(name) || input.mediaType.startsWith("text/")) {
    return docs.create({ ...base, body: input.data.toString("utf8") }, actor);
  }
  throw new ValidationError("Import supports Markdown, text, Word (.docx), and PDF files");
}
