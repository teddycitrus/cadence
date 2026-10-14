import { defaultSchema, type Options as SanitizeOptions } from "rehype-sanitize";

// Text and background colors in docs. Markdown has no syntax for them, so they
// are stored as small inline HTML tags with a named color (never a free-form
// style), which every Cadence view renders and other Markdown tools show as
// plain text:  <span data-color="blue">text</span>  <mark data-color="yellow">text</mark>
// Kept apart from the editor extensions (colors.ts) so read-only views load no editor code.

export const DOC_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export type DocColor = (typeof DOC_COLORS)[number];

export const isDocColor = (c: unknown): c is DocColor => typeof c === "string" && (DOC_COLORS as readonly string[]).includes(c);

/** For read-only Markdown views: raw HTML is allowed only for these color tags, with a named color. */
export const docSanitizeSchema: SanitizeOptions = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark", "span"],
  attributes: {
    ...defaultSchema.attributes,
    span: [["dataColor", ...DOC_COLORS]],
    mark: [["dataColor", ...DOC_COLORS]],
  },
};

/** Whether a Markdown text holds a color tag, the only raw HTML views render. */
export const hasDocColorTags = (text: string): boolean => /<(span|mark)\s+data-color=/i.test(text);
