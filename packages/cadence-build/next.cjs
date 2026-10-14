// Next.js: wrap your config so Cadence canvases can map elements to source.
//
//   // next.config.js
//   const { withCadence } = require("cadence-build/next");
//   module.exports = withCadence({ /* your config */ });
//
// It only acts when Cadence runs the dev server with CADENCE=1, for both
// webpack and Turbopack; production builds are untouched.
"use strict";

const { enabled } = require("./stamp.cjs");

const loader = require.resolve("./loader.cjs");

function addTurbopackRules(turbopack) {
  const rules = { ...((turbopack && turbopack.rules) || {}) };
  for (const glob of ["*.jsx", "*.tsx"]) {
    const existing = rules[glob];
    if (!existing) rules[glob] = { loaders: [loader] };
    else if (Array.isArray(existing)) rules[glob] = [...existing, { loaders: [loader] }];
    else rules[glob] = { ...existing, loaders: [...(existing.loaders || []), loader] };
  }
  return { ...(turbopack || {}), rules };
}

function apply(config) {
  if (!enabled()) return config;
  const previous = config.webpack;
  return {
    ...config,
    turbopack: addTurbopackRules(config.turbopack),
    webpack(webpackConfig, context) {
      const out = previous ? previous(webpackConfig, context) : webpackConfig;
      out.module.rules.push({ test: /\.[jt]sx$/, exclude: /node_modules/, enforce: "pre", use: [{ loader }] });
      return out;
    },
  };
}

/** Accepts a config object or a config function, like Next.js itself. */
function withCadence(nextConfig) {
  if (typeof nextConfig === "function") return async (...args) => apply(await nextConfig(...args));
  return apply(nextConfig || {});
}

module.exports = { withCadence, default: withCadence };
