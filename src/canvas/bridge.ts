// Runs inside every frame page. It talks only to the Cadence windows in
// PARENTS (fixed when the devserver starts), never to anything else.
export const BRIDGE_SOURCE = String.raw`
const PARENTS = __PARENT_ORIGINS__;
const ATTR = "data-cadence-loc";
const STYLE_KEYS = ["display", "flexDirection", "alignItems", "justifyContent", "gap", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "marginTop", "marginRight", "marginBottom", "marginLeft", "width", "height", "backgroundColor", "color", "fontSize", "fontWeight", "fontFamily", "lineHeight", "textAlign", "borderRadius", "borderWidth", "borderColor", "opacity", "backgroundImage", "backgroundSize", "backgroundPosition", "backgroundRepeat", "flexWrap", "gridTemplateColumns", "gridTemplateRows", "overflow", "position", "top", "right", "bottom", "left", "zIndex", "aspectRatio", "minWidth", "maxWidth", "minHeight", "maxHeight", "letterSpacing", "textTransform", "fontStyle", "textDecorationLine", "borderStyle", "outlineWidth", "outlineColor", "outlineStyle", "outlineOffset", "boxShadow", "filter", "backdropFilter", "rotate", "scale", "translate", "fill", "stroke", "strokeWidth", "textShadow", "mixBlendMode", "boxSizing"];
const LOCK = "data-cadence-locked";
let selecting = false;
let hovered = null;
let selected = null;

const post = (msg) => { if (window.parent === window) return; for (const o of PARENTS) window.parent.postMessage({ source: "cadence-canvas", ...msg }, o); };
window.__cadenceReport = (err) => post({ type: "error", message: String(err && err.message || err) });
window.addEventListener("error", (e) => post({ type: "error", message: e.message }));
window.addEventListener("unhandledrejection", (e) => post({ type: "error", message: String(e.reason && e.reason.message || e.reason) }));

const box = (color) => {
  const d = document.createElement("div");
  d.setAttribute("data-cadence-overlay", "");
  d.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:1.5px solid " + color + ";border-radius:2px;display:none;box-sizing:border-box";
  document.documentElement.appendChild(d);
  return d;
};
let hoverBox, selectBox;
const place = (b, el) => {
  if (!el || !el.isConnected) { b.style.display = "none"; return; }
  const r = el.getBoundingClientRect();
  Object.assign(b.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
};
// Locked elements, and everything inside them, cannot be picked on the canvas.
const target = (el) => !el || !el.closest || el.closest("[" + LOCK + "]") ? null : el.closest("[" + ATTR + "]");

function describe(el) {
  const cs = getComputedStyle(el);
  const styles = {};
  for (const k of STYLE_KEYS) styles[k] = cs[k];
  const loc = el.getAttribute(ATTR);
  const textOnly = el.childNodes.length === 1 && el.firstChild.nodeType === 3;
  const r = el.getBoundingClientRect();
  const ancestors = [];
  for (let p = el.parentElement; p && ancestors.length < 8; p = p.parentElement) {
    const at = p.getAttribute(ATTR);
    if (at) ancestors.push({ loc: at, tag: p.tagName.toLowerCase(), className: p.getAttribute("class") || "" });
  }
  return { loc, tag: el.tagName.toLowerCase(), className: el.getAttribute("class") || "", inlineStyle: el.getAttribute("style") || "", text: textOnly ? el.textContent : null, count: document.querySelectorAll("[" + ATTR + '="' + CSS.escape(loc) + '"]').length, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, styles, ancestors };
}

function tree() {
  const out = [];
  const walk = (el, depth) => {
    for (const child of el.children) {
      const loc = child.getAttribute && child.getAttribute(ATTR);
      if (loc) {
        const id = child.id ? "#" + child.id : "";
        const text = child.childNodes.length === 1 && child.firstChild.nodeType === 3 ? child.textContent.trim().slice(0, 30) : "";
        const cls = typeof child.className === "string" ? child.className.trim().slice(0, 200) : "";
        out.push({ loc, tag: child.tagName.toLowerCase() + id, depth, label: text, locked: child.hasAttribute(LOCK), classes: cls });
        if (out.length < 600) walk(child, depth + 1);
      } else walk(child, depth);
    }
  };
  walk(document.body, 0);
  return out;
}

let treeTimer = null;
// After any change, refresh the layers and the selected element's details: frameworks
// without Vite's HMR events (Next.js, Expo) update elements in place.
const sendTree = () => { clearTimeout(treeTimer); treeTimer = setTimeout(() => { post({ type: "tree", nodes: tree() }); place(hoverBox, hovered); if (!selected) return; if (!selected.isConnected) reselect(selected.getAttribute(ATTR)); else { place(selectBox, selected); post({ type: "selected", element: describe(selected) }); } }, 150); };
const reselect = (loc) => {
  selected = loc ? document.querySelector("[" + ATTR + '="' + CSS.escape(loc) + '"]') : null;
  place(selectBox, selected);
  if (selected) post({ type: "selected", element: describe(selected) });
};

function start() {
  hoverBox = box("#a78bfa88");
  selectBox = box("#8b5cf6");
  new MutationObserver(sendTree).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  sendTree();
  post({ type: "ready", width: innerWidth, height: innerHeight });
  // The frame's browser bar shows where the page is, through client-side navigation too.
  const where = () => post({ type: "location", path: location.pathname + location.search + location.hash });
  for (const k of ["pushState", "replaceState"]) {
    const orig = history[k];
    history[k] = function (...args) { const r = orig.apply(this, args); where(); return r; };
  }
  addEventListener("popstate", where);
  where();
  addEventListener("scroll", () => { place(hoverBox, hovered); place(selectBox, selected); }, true);
  addEventListener("resize", () => place(selectBox, selected));
  document.addEventListener("mousemove", (e) => {
    if (!selecting) return;
    hovered = target(e.target);
    place(hoverBox, hovered);
  }, true);
  document.addEventListener("click", (e) => {
    if (!selecting) return;
    const el = target(e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    selected = el;
    place(selectBox, el);
    post({ type: "selected", element: describe(el) });
  }, true);
}

window.addEventListener("message", (e) => {
  if (!PARENTS.includes(e.origin) || !e.data || e.data.source !== "cadence-host") return;
  const m = e.data;
  if (m.type === "mode") {
    selecting = Boolean(m.select);
    if (!selecting) { hovered = null; place(hoverBox, null); }
    document.documentElement.style.cursor = selecting ? "crosshair" : "";
  } else if (m.type === "select") reselect(m.loc);
  else if (m.type === "hover") { hovered = m.loc ? document.querySelector("[" + ATTR + '="' + CSS.escape(m.loc) + '"]') : null; place(hoverBox, hovered); }
  else if (m.type === "clear") { selected = null; place(selectBox, null); }
  else if (m.type === "nav") {
    if (m.action === "back") history.back();
    else if (m.action === "forward") history.forward();
    else if (m.action === "reload") location.reload();
    // Only paths on this same origin; the canvas never sends a frame elsewhere.
    else if (m.action === "go" && typeof m.path === "string" && m.path.startsWith("/") && !m.path.startsWith("//")) location.assign(m.path);
  }
});

if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
if (import.meta.hot) import.meta.hot.on("vite:afterUpdate", () => { sendTree(); if (selected) setTimeout(() => reselect(selected.getAttribute(ATTR)), 50); });
`;
