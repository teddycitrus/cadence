import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "../core/errors";
import { git } from "../git/git";

// Design tokens: the CSS custom properties a project defines (in :root,
// theme selectors, or Tailwind v4 @theme blocks), read and edited in place.

export type TokenKind = "color" | "length" | "font" | "shadow" | "other";

export interface Token {
  name: string;
  value: string;
  kind: TokenKind;
  /** The block it is declared in: ":root", "@theme", ".dark", ... */
  scope: string;
  file: string;
  /** Where the value sits in the file, for write-back. */
  valueRange: [number, number];
  /** Set when the value is another token (an alias), e.g. var(--blue-500). */
  aliasOf: string | null;
}

const NAME = /^--[a-zA-Z0-9_-]{1,80}$/;

export function tokenKind(name: string, value: string): TokenKind {
  const v = value.trim();
  if (/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color-mix\()/i.test(v) || /(^|-)(color|bg|fg|border|accent|brand|primary|secondary|surface|text|muted)(-|$)/.test(name.slice(2))) return "color";
  if (/^-?[\d.]+(px|rem|em|%|vh|vw|ch)$/.test(v) || /(^|-)(space|spacing|radius|size|gap|width|height|text)(-|$)/.test(name.slice(2))) return "length";
  if (/(^|-)(font|family)(-|$)/.test(name.slice(2)) || /,\s*(sans-serif|serif|monospace)/.test(v)) return "font";
  if (/(^|-)shadow(-|$)/.test(name.slice(2))) return "shadow";
  return "other";
}

/** Strips comments but keeps offsets (comments become spaces). */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
}

/** Every custom property declared in a stylesheet, with the block it is in. */
export function parseTokens(css: string, file: string): Token[] {
  const src = blankComments(css);
  const out: Token[] = [];
  const stack: string[] = [];
  let header = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "{") {
      stack.push(header.trim().replace(/\s+/g, " "));
      header = "";
      i++;
      continue;
    }
    if (ch === "}") {
      stack.pop();
      header = "";
      i++;
      continue;
    }
    if (ch === ";") {
      header = "";
      i++;
      continue;
    }
    // A declaration starts with "--" inside a block.
    if (ch === "-" && src[i + 1] === "-" && stack.length && !header.trim()) {
      const m = /^(--[a-zA-Z0-9_-]+)\s*:\s*/.exec(src.slice(i));
      if (m) {
        const start = i + m[0].length;
        let end = start;
        let depth = 0;
        while (end < src.length) {
          const c = src[end]!;
          if (c === "(") depth++;
          else if (c === ")") depth--;
          else if ((c === ";" || c === "}") && depth <= 0) break;
          end++;
        }
        const raw = css.slice(start, end);
        const value = raw.trim();
        const trimmedStart = start + (raw.length - raw.trimStart().length);
        const alias = /^var\(\s*(--[a-zA-Z0-9_-]+)\s*\)$/.exec(value)?.[1] ?? null;
        out.push({ name: m[1]!, value, kind: tokenKind(m[1]!, value), scope: stack.at(-1) || ":root", file, valueRange: [trimmedStart, trimmedStart + value.length], aliasOf: alias });
        i = end;
        continue;
      }
    }
    header += ch;
    i++;
  }
  return out;
}

const VALUE_OK = (v: string) => v.trim().length > 0 && v.length <= 500 && !/[;{}]/.test(v);

/** Changes one token's value in a stylesheet. */
export function setTokenValue(css: string, token: Pick<Token, "name" | "scope">, value: string): string | null {
  if (!VALUE_OK(value)) return null;
  const t = parseTokens(css, "").find((x) => x.name === token.name && x.scope === token.scope);
  if (!t) return null;
  return css.slice(0, t.valueRange[0]) + value.trim() + css.slice(t.valueRange[1]);
}

/** Adds a token to the first @theme (Tailwind) or :root block, or a new :root block. */
export function addToken(css: string, name: string, value: string): string | null {
  if (!NAME.test(name) || !VALUE_OK(value)) return null;
  if (parseTokens(css, "").some((t) => t.name === name)) return null;
  const block = /(@theme[^{]*|:root)\s*\{/.exec(blankComments(css));
  if (!block) return `${css.trimEnd()}\n\n:root {\n  ${name}: ${value.trim()};\n}\n`;
  const open = block.index + block[0].length;
  const indent = /\n([ \t]+)--/.exec(css.slice(open))?.[1] ?? "  ";
  return `${css.slice(0, open)}\n${indent}${name}: ${value.trim()};${css.slice(open)}`;
}

const STYLESHEET = /\.(css|pcss|postcss)$/;

/** Stylesheets of a project (tracked or new, never node_modules). */
export async function stylesheets(root: string): Promise<string[]> {
  const out = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.css", "*.pcss", "*.postcss"], true);
  return out.split("\n").filter((p) => p && STYLESHEET.test(p) && !p.split("/").includes("node_modules"));
}

/** All tokens in a project. */
export async function projectTokens(root: string): Promise<Token[]> {
  const out: Token[] = [];
  for (const file of await stylesheets(root)) {
    const full = join(root, file);
    if (existsSync(full)) out.push(...parseTokens(readFileSync(full, "utf8"), file));
  }
  return out;
}

/** Edits or adds a token in one of the project's stylesheets. */
export function writeToken(root: string, file: string, change: { name: string; scope?: string; value: string; add?: boolean }): void {
  if (!STYLESHEET.test(file) || file.includes("..") || file.split(/[\\/]/).includes("node_modules")) throw new ValidationError(`"${file}" is not a stylesheet in this project`);
  const full = join(root, file);
  if (!existsSync(full)) throw new ValidationError(`${file} not found`);
  const css = readFileSync(full, "utf8");
  const next = change.add ? addToken(css, change.name, change.value) : setTokenValue(css, { name: change.name, scope: change.scope ?? ":root" }, change.value);
  if (next === null) throw new ValidationError(change.add ? `Could not add ${change.name} (taken, or not a valid name or value)` : `Could not find ${change.name} in ${change.scope ?? ":root"} of ${file}`);
  writeFileSync(full, next);
}
