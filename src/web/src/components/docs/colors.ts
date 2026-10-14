import { Mark, mergeAttributes } from "@tiptap/core";
import { Highlight } from "@tiptap/extension-highlight";
import { isDocColor as isColor } from "./color-names";

// The editor side of doc colors; the names and the read-only sanitizer live in color-names.ts.
export { DOC_COLORS, type DocColor } from "./color-names";

/** Colored text: <span data-color="...">. */
export const TextColor = Mark.create({
  name: "textColor",
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el) => (isColor(el.getAttribute("data-color")) ? el.getAttribute("data-color") : null),
        renderHTML: (attrs) => (isColor(attrs.color) ? { "data-color": attrs.color } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-color]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ class: "doc-text-color" }, HTMLAttributes), 0];
  },
  renderMarkdown: (node, h) => {
    const inner = h.renderChildren(node);
    return isColor(node.attrs?.color) ? `<span data-color="${node.attrs!.color}">${inner}</span>` : inner;
  },
});

/** Highlight with an optional named color; uncolored highlight stays ==text==. */
export const ColorHighlight = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el) => (isColor(el.getAttribute("data-color")) ? el.getAttribute("data-color") : null),
        renderHTML: (attrs) => (isColor(attrs.color) ? { "data-color": attrs.color } : {}),
      },
    };
  },
  renderMarkdown: (node, h) => {
    const inner = h.renderChildren(node);
    return isColor(node.attrs?.color) ? `<mark data-color="${node.attrs!.color}">${inner}</mark>` : `==${inner}==`;
  },
}).configure({ multicolor: true });
