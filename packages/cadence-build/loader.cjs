// A webpack and Turbopack loader for JSX/TSX: stamps source locations when
// CADENCE=1 and passes files through untouched otherwise.
"use strict";

const path = require("path");
const { stampLocations, enabled } = require("./stamp.cjs");

module.exports = function cadenceLoader(source, map) {
  if (!enabled() || this.resourcePath.includes(`${path.sep}node_modules${path.sep}`) || this.resourcePath.includes("/node_modules/")) {
    if (this.callback) return this.callback(null, source, map);
    return source;
  }
  const root = this.rootContext || process.cwd();
  const rel = path.relative(root, this.resourcePath).split(path.sep).join("/");
  const out = rel.startsWith("..") ? null : stampLocations(String(source), rel);
  if (this.callback) return this.callback(null, out ? out.code : source, out ? JSON.parse(out.map.toString()) : map);
  return out ? out.code : source;
};
