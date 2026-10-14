/** The canvas authoring guide agents read with canvas_guide. Cadence's own format, in its own words. */
export const CANVAS_GUIDE = `# Cadence canvases

A canvas is a file in the repository named *.canvas.tsx (or *.canvas.ts for Svelte projects). It imports nothing from Cadence, so it never affects the app's build or typecheck. Cadence renders it on a board where each frame is a frame.

## File format

- The default export describes the canvas: { name, background, appCommand?, appUrl?, cover? }.
- Every named export that is an object with render, route, html, or svelte is a frame. Its export name is its id.
  - render: () => <Component ... />   a component frame, rendered by the canvas devserver.
  - route: "/checkout"                 a live route of the running app.
  - html: "mockups/home.html"          a static HTML file in the repo.
  - svelte: "src/lib/Card.svelte", props: { ... }   a Svelte component with props.
- Each frame has name (the label) and frame: { x, y, width, height } in board pixels.
- Optional: locked: true (cannot be moved on the board), vrt: false (left out of visual tests), or vrt: { threshold: 0.1, ignore: [{ x, y, width, height }] }.

Example:

  import { Button } from "../components/Button";
  import "../index.css";

  export default { name: "Buttons", background: "#d7c09b" };

  export const Primary = { name: "Primary", render: () => <Button variant="primary">Pay now</Button>, frame: { x: 0, y: 0, width: 320, height: 120 } };
  export const Checkout = { name: "Checkout page", route: "/checkout", frame: { x: 400, y: 0, width: 1280, height: 800 } };

## Build in the app, preview on the canvas

Frames import the app's real components and pass them props. Build new UI in the app's own source and import it; do not write throwaway components inside the canvas file. Import the app's global CSS in the canvas when components depend on it.

## Route frames and the app's dev server

Plain Vite apps need nothing: routes load from the canvas devserver. Apps with their own server (Next.js, Expo, others) set appCommand to the dev command (Cadence runs it with PORT and CADENCE=1; {port} is replaced) or appUrl to a server already running on this machine. Next.js and Expo projects add the cadence-build plugin so elements map back to source. Use canvas_app_server to set, start, stop, or check it.

## Editing protocol

1. canvas_guide once per session (this text).
2. canvas_start_working before the first change.
3. Create with canvas_create; change frames by editing the file. canvas_layout gives frames that do not overlap.
4. canvas_validate, then canvas_screenshot on one frame you changed. If it fails, canvas_debug once instead of retrying.
5. canvas_finish_working exactly once at the end, even when something failed.

## Visual tests

Frames are tracked by default. canvas_check_visuals compares renders with the baselines in .cadence/vrt; canvas_accept_baseline saves a new baseline when a change is intended. Before tracking a new frame, canvas_verify_visual makes sure it renders the same every time (no clocks, random data, or running animations). canvas_set_visual tracks or untracks one; canvas_post_visuals_to_pr reports results on the pull request.

## Assets and libraries

A canvas can declare the components it showcases as reusable assets in its default export, so people insert them from the Assets panel and agents find them with assets_list:

  export default {
    name: "Buttons",
    library: "Design System",
    assets: {
      Button: {
        usage: "Primary actions: form submits and calls to action. Not for navigation (use Link).",
        variants: { Primary: { props: { variant: "primary" }, children: "Buy now" }, Danger: { props: { variant: "danger" }, children: "Delete" } },
      },
    },
  };

- Keys are components the canvas imports from project files. Declare each component once in the whole workspace.
- library (or libraries: [...]) names the libraries; a library exists when some asset names it. An asset can also name its own.
- usage says what it is for and when not to use it. Write one for every design-system asset.
- variants are named prop sets with literal values (and optional text children), taken from how the app really uses the component.

Before creating or restyling UI, call assets_list and reuse what fits. Design-system canvases (generate-design-system) declare an asset for every top-level component they show, not for sub-parts.

## Comments

People pin comment threads on canvases. canvas_comments lists open ones in this workspace; reply with canvas_reply, and resolve when the feedback is addressed. comments_inbox shows mentions and replies for the person you work for.
`;
