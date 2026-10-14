import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

// Code in Cadence's colors. Everything is a CSS variable from styles.css, so one
// editor follows sand and night without being rebuilt.

const v = (name: string) => `var(--color-${name})`;

const chrome = EditorView.theme({
  "&": { color: v("zinc-200"), backgroundColor: v("zinc-950") },
  ".cm-content": { caretColor: v("violet-400") },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: v("violet-400") },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: `color-mix(in oklab, ${v("violet-500")} 26%, transparent)`,
  },
  ".cm-activeLine": { backgroundColor: `color-mix(in oklab, ${v("zinc-800")} 45%, transparent)` },
  ".cm-gutters": { backgroundColor: v("zinc-950"), color: v("zinc-600"), border: "none", borderRight: `1px solid ${v("zinc-800")}` },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: v("zinc-400") },
  ".cm-foldPlaceholder": { backgroundColor: v("zinc-800"), border: "none", color: v("zinc-400") },
  ".cm-matchingBracket, .cm-nonmatchingBracket": { backgroundColor: `color-mix(in oklab, ${v("violet-500")} 22%, transparent)`, outline: "none" },
  ".cm-searchMatch": { backgroundColor: `color-mix(in oklab, ${v("amber-500")} 30%, transparent)` },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: `color-mix(in oklab, ${v("amber-500")} 50%, transparent)` },
  ".cm-panels": { backgroundColor: v("zinc-900"), color: v("zinc-200") },
  ".cm-panels.cm-panels-bottom": { borderTop: `1px solid ${v("zinc-800")}` },
  ".cm-tooltip": { backgroundColor: v("zinc-900"), color: v("zinc-200"), border: `1px solid ${v("zinc-800")}`, borderRadius: "8px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: v("zinc-800"), color: v("zinc-100") },
  ".cm-diagnostic-error": { borderLeftColor: v("red-400") },
  ".cm-diagnostic-warning": { borderLeftColor: v("amber-400") },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: `underline wavy ${v("red-400")}` },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: `underline wavy ${v("amber-400")}` },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: v("red-400") },
  { tag: [t.string, t.special(t.string), t.regexp], color: v("emerald-400") },
  { tag: [t.number, t.bool, t.null, t.atom], color: v("amber-400") },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: v("zinc-500"), fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: v("sky-400") },
  { tag: [t.typeName, t.className, t.namespace], color: v("violet-400") },
  { tag: [t.tagName], color: v("red-400") },
  { tag: [t.attributeName], color: v("amber-400") },
  { tag: [t.propertyName], color: v("zinc-200") },
  { tag: [t.definition(t.variableName)], color: v("zinc-100") },
  { tag: [t.operator, t.punctuation, t.bracket], color: v("zinc-400") },
  { tag: [t.heading], color: v("zinc-100"), fontWeight: "600" },
  { tag: [t.link, t.url], color: v("violet-300"), textDecoration: "underline" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "600" },
  { tag: [t.invalid], color: v("red-300") },
]);

export const cadenceCodeTheme = [chrome, syntaxHighlighting(highlight)];
