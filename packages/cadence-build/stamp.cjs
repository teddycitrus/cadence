// Adds data-cadence-loc="file:line:col" to every DOM element in JSX, so a
// click on the canvas maps to the exact source position. Shared by Cadence's
// canvas devserver (Vite) and the Next.js loader.
"use strict";

const { parse } = require("@babel/parser");
const MagicString = require("magic-string");

const LOC_ATTR = "data-cadence-loc";
const LOCK_ATTR = "data-cadence-locked";

function parseSource(code) {
  return parse(code, { sourceType: "module", plugins: ["typescript", "jsx"], errorRecovery: true });
}

/** Returns { code, map } with locations stamped, or null when nothing changed or the file does not parse. */
function stampLocations(code, relPath) {
  let ast;
  try {
    ast = parseSource(code);
  } catch {
    return null;
  }
  const MS = MagicString.default || MagicString;
  const s = new MS(code);
  let touched = false;
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (node.type === "JSXOpeningElement") {
      const name = node.name;
      const loc = node.loc;
      if (name.type === "JSXIdentifier" && /^[a-z]/.test(name.name || "") && loc && !node.attributes.some((a) => a.type === "JSXAttribute" && a.name && a.name.name === LOC_ATTR)) {
        s.appendLeft(name.end, ` ${LOC_ATTR}="${relPath}:${loc.start.line}:${loc.start.column}"`);
        touched = true;
      }
    }
    for (const k of Object.keys(node)) {
      if (k === "loc" || k === "start" || k === "end") continue;
      const v = node[k];
      if (v && typeof v === "object") visit(v);
    }
  };
  visit(ast.program);
  return touched ? { code: s.toString(), map: s.generateMap({ hires: true, source: relPath }) } : null;
}

/** Whether the build should stamp: only when Cadence started it (CADENCE=1). */
const enabled = () => process.env.CADENCE === "1";

module.exports = { LOC_ATTR, LOCK_ATTR, stampLocations, parseSource, enabled };
