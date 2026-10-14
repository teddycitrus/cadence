import { z } from "zod";
import { define, type BoardTool, type ToolContext } from "../agents/board-tools";
import type { BuiltInBrowser } from "./service";
import type { BrowserTab } from "./tab";

function tabOf(browser: BuiltInBrowser, ctx: ToolContext): Promise<BrowserTab> {
  if (!ctx.workspaceId) throw new Error("The built-in browser belongs to a workspace; use it from a workspace chat");
  return browser.tab(ctx.workspaceId);
}

const where = (t: BrowserTab) => `${t.state.title || "(untitled)"} at ${t.state.url}`;

/**
 * The workspace's built-in browser as agent tools. It is the same tab people
 * see in the workspace panel, so they can watch an agent test the app.
 */
export function browserTools(browser: BuiltInBrowser): BoardTool[] {
  return [
    define({
      name: "browser_open",
      description: "Open a URL in this workspace's built-in browser (the one people see in the workspace panel). localhost works, so use it to try the app's dev server.",
      shape: { url: z.string().min(1).max(2000) },
      run: async (a, ctx) => {
        const t = await tabOf(browser, ctx);
        await t.navigate(a.url);
        return `Opened ${where(t)}.`;
      },
    }),
    define({
      name: "browser_screenshot",
      description: "See the built-in browser's current page.",
      shape: {},
      run: async (_a, ctx) => {
        const t = await tabOf(browser, ctx);
        return { text: `${where(t)}:`, images: [{ data: (await t.screenshot()).toString("base64"), mimeType: "image/png" }] };
      },
    }),
    define({
      name: "browser_elements",
      description: "List the page's buttons, links, and fields, each with a number to use in browser_click and browser_type.",
      shape: {},
      run: async (_a, ctx) => {
        const t = await tabOf(browser, ctx);
        const list = await t.elements();
        if (!list.length) return `No interactive elements on ${where(t)}.`;
        return [`${where(t)}:`, ...list.map((e) => `[${e.ref}] ${e.role || e.tag}${e.type ? `(${e.type})` : ""} "${e.name}"${e.value ? ` value="${e.value}"` : ""}`)].join("\n");
      },
    }),
    define({
      name: "browser_click",
      description: "Click an element by its number from browser_elements, or a point on the page.",
      shape: { element: z.number().int().positive().optional(), x: z.number().optional(), y: z.number().optional() },
      run: async (a, ctx) => {
        const t = await tabOf(browser, ctx);
        if (a.element) await t.clickRef(a.element);
        else if (a.x !== undefined && a.y !== undefined) await t.click(a.x, a.y);
        else throw new Error("Give an element number, or x and y");
        await new Promise((r) => setTimeout(r, 300));
        return `Clicked. Now on ${where(t)}.`;
      },
    }),
    define({
      name: "browser_type",
      description: "Replace the text in a field (by its number from browser_elements), optionally pressing Enter after.",
      shape: { element: z.number().int().positive(), text: z.string().max(10_000), submit: z.boolean().optional() },
      run: async (a, ctx) => {
        const t = await tabOf(browser, ctx);
        await t.fill(a.element, a.text, a.submit);
        return `Typed into element ${a.element}${a.submit ? " and pressed Enter" : ""}.`;
      },
    }),
    define({
      name: "browser_press",
      description: "Press a key in the built-in browser.",
      shape: { key: z.enum(["Enter", "Tab", "Escape", "Backspace", "ArrowDown", "ArrowUp"]) },
      run: async (a, ctx) => {
        await (await tabOf(browser, ctx)).press(a.key);
        return `Pressed ${a.key}.`;
      },
    }),
    define({
      name: "browser_read",
      description: "Read the built-in browser's page as text.",
      shape: {},
      run: async (_a, ctx) => {
        const t = await tabOf(browser, ctx);
        return `${where(t)}\n\n${await t.text()}`;
      },
    }),
    define({
      name: "browser_console",
      description: "The built-in browser's recent console messages and uncaught errors, to debug the page.",
      shape: { errors_only: z.boolean().optional(), limit: z.number().int().min(1).max(300).optional() },
      run: async (a, ctx) => {
        const t = await tabOf(browser, ctx);
        const list = t.console.filter((c) => !a.errors_only || c.level === "error" || c.level === "warn").slice(-(a.limit ?? 50));
        return list.map((c) => `${c.at.slice(11, 19)} ${c.level}: ${c.text}`).join("\n") || "No console messages.";
      },
    }),
    define({
      name: "browser_back",
      description: "Go back in the built-in browser's history.",
      shape: {},
      run: async (_a, ctx) => {
        const t = await tabOf(browser, ctx);
        await t.history(-1);
        return `Back on ${where(t)}.`;
      },
    }),
  ];
}
