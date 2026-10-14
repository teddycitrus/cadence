// Expo (and any Babel build): add to babel.config.js plugins as "cadence-build/babel".
//
// When CADENCE=1, DOM elements get data-cadence-loc="file:line:col", and React
// Native core components get dataSet={{ cadenceLoc: ... }}, which React Native
// Web renders as the same attribute. Without CADENCE=1 it does nothing.
"use strict";

const path = require("path");
const { LOC_ATTR } = require("./stamp.cjs");

/**
 * Names imported from React Native (View, Animated, ...), recorded when the
 * file is entered: other plugins (Expo's preset on web) rewrite or replace
 * those imports before the JSX below them is visited.
 */
const RN_SOURCE = /^react-native(-web)?(\/|$)/;
function reactNativeNames(program) {
  const names = new Set();
  for (const stmt of program.body) {
    if (stmt.type !== "ImportDeclaration" || !RN_SOURCE.test(stmt.source.value)) continue;
    for (const s of stmt.specifiers) names.add(s.local.name);
  }
  return names;
}

function rootName(name) {
  return name.type === "JSXMemberExpression" ? leftmost(name) : name.type === "JSXIdentifier" ? name.name : null;
}

function leftmost(member) {
  let n = member;
  while (n.type === "JSXMemberExpression") n = n.object;
  return n.type === "JSXIdentifier" ? n.name : null;
}

module.exports = function cadenceBabel(api) {
  // Re-evaluated per build, so turning CADENCE on or off invalidates Babel's cache.
  const on = api.cache.using(() => process.env.CADENCE === "1");
  const t = api.types;
  if (!on) return { name: "cadence", visitor: {} };
  return {
    name: "cadence",
    visitor: {
      Program: {
        enter(p, state) {
          state.cadenceNative = reactNativeNames(p.node);
        },
      },
      JSXOpeningElement(p, state) {
        const file = state.filename;
        const loc = p.node.loc;
        if (!file || !loc || /[\\/]node_modules[\\/]/.test(file)) return;
        const rel = path.relative(state.cwd || process.cwd(), file).split(path.sep).join("/");
        if (rel.startsWith("..")) return;
        const value = `${rel}:${loc.start.line}:${loc.start.column}`;
        const attrs = p.node.attributes;
        const named = (n) => attrs.find((a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name: n }));
        const name = p.node.name;
        if (t.isJSXIdentifier(name) && /^[a-z]/.test(name.name)) {
          if (!named(LOC_ATTR)) attrs.push(t.jsxAttribute(t.jsxIdentifier(LOC_ATTR), t.stringLiteral(value)));
          return;
        }
        if (!state.cadenceNative || !state.cadenceNative.has(rootName(name))) return;
        const prop = t.objectProperty(t.identifier("cadenceLoc"), t.stringLiteral(value));
        const existing = named("dataSet");
        if (!existing) attrs.push(t.jsxAttribute(t.jsxIdentifier("dataSet"), t.jsxExpressionContainer(t.objectExpression([prop]))));
        else if (t.isJSXExpressionContainer(existing.value) && t.isObjectExpression(existing.value.expression)) existing.value.expression.properties.push(prop);
      },
    },
  };
};
