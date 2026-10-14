# Reference app teardown

What the reference app (a desktop app, v0.0.120) actually is, from inspecting the installed app on 2026-10-06. Sources are tagged:

- **[live]** seen in the running, logged-in app (Windows, fresh org, no projects)
- **[ui]** renderer bundle `out/renderer/assets/index-*.js` (plain JS)
- **[main]** string literals in the main-process V8 bytecode (`out/main/index.cjsc`)
- **[sdk]** the public the reference SDK npm package (0.0.51)

Not observed live: anything that needs a project (chat/workspace UI, canvas editor, doc editor, issue detail, git panel). Those sections come from code only.

## 1. Architecture

| Layer | What it is |
|---|---|
| Shell | Electron app, its Electron shell. Main process shipped as V8 bytecode. Auto-update via electron-updater. |
| Backend | Convex (realtime DB + functions), Clerk auth, PostHog analytics, Sentry. [ui] |
| Collaboration | Yjs for docs and issue bodies (`docs_yjs_body`). Realtime presence, comments, reactions. [ui] |
| Agent runtimes | Runs agents **on the user's machine** through local harnesses: Claude Code (`@anthropic-ai/claude-agent-sdk`), Codex (`@openai/codex-sdk`), Cursor CLI, Grok, OpenCode. Talks to them over the Agent Client Protocol (`@agentclientprotocol/sdk`). [main] |
| Tool surface for agents | Its own MCP server: `issues_*`, `docs_*`, `canvas_*`, `agents_*`, `slack_*`, `linear_*`. Personal access tokens let outside agents (e.g. "codex-cloud", "grokbot") sign into it. [ui][main] |
| Code intelligence | Bundled TypeScript + tsserver, oxc-parser, lightningcss, Tailwind language server, Monaco editor. [main][ui] |
| Inference | A managed inference proxy with monthly credit plans, or bring-your-own key per model, or use local Claude Code / Codex subscriptions. [live] |
| Sharing | Public share links on `<share domain>/<org-slug>/...` for canvases, docs, issues. [live][ui] |
| Remote | "Machines": workspaces can live on another machine; Remote Control sessions. [ui] |

## 2. Navigation [live]

Left rail: org switcher, **Chats**, **Docs**, **Design**, **Issues**, **Agents**; footer: bug report (with screen recording), help, settings, profile. Top bar: sidebar toggle, back/forward history, right-panel toggle, split view.

Home ("Let's Cook."): **Generate**, **Open folder**, **Import project** (clone from git URL).

Generate page ("Start Your Next Project."): prompt box, model picker (default Opus 5.5 1M), effort (High), mode chip, and three generation modes: **Mockup** (HTML design), **React Prototype** (scaffolded Vite + React + Tailwind app with a dev server), **Blank Project**.

## 3. Core object model

- **Organization**: members (Admin/Member), invite link + email invites + access requests, logo, name, workspace URL slug, projects, stages, integrations, public agents, delete. [live]
- **Project**: a git repo. Name, device folder, GitHub repo. Org Setup Script (runs when a workspace is created), Org Run Scripts (named commands), plus personal My Setup Script. [live][ui]
- **Workspace**: a git branch/worktree for one piece of work. Holds multiple chats, canvases, a source-control panel, a built-in browser, files, terminal. States: pinned, archived (branch kept), deleted, remote-hosted, unread/streaming/interrupted indicators. [ui]
- **Chat**: an agent conversation inside a workspace. [ui]
- **Issue**: board card with stage, assignees (humans and agents), priority, type, estimate, labels, linked PRs/branches/canvases/docs/chats, comments, markdown body. [ui]
- **Doc**: collaborative rich-text doc (PRDs, plans), tree with sub-pages and icons. [ui][live]
- **Canvas**: a `*.canvas.tsx` file in the repo containing storyboards. [sdk]
- **Agent**: saved prompt + model + effort + triggers + permissions + visibility, runs on its owner's machine. [live][ui]

## 4. Issues [live][ui]

Board with views: Organization (Triage, Active), Private (My Issues), saved filters. Board and list layouts, split view, search, filters (save / save as), display properties, ordering, grouping/sub-grouping, bulk actions (including "create workspaces" for many issues at once), activity feed, AI chat side panel.

**Stages** are org-configurable (rename, recolor, reorder, add, delete), grouped into fixed categories. Default set:

| Category | Stages |
|---|---|
| Triage | New Idea, Scoping, Spec & Concept Design, Design Polish, Ready For Dev, Backlog, Candidate, Planned |
| In Progress | Implementation, Requirements, Design, Eng Plan |
| In Review | PR Review, Design Review, QA |
| Done | Merged, Deployed — Staging, Deployed — Production, Documented, Promoted |
| Cancelled | Duplicate, Won't Do |

The default board shows a subset (New Idea through Deployed — Production plus Duplicate and Won't Do).

Issue detail: properties (status, type, priority, estimate, assignee), labels with colors, comments with reactions/images/edit/delete, copy ID, breadcrumb trail, "Create workspace" (spins off a workspace with the issue attached as context and a prompt sent as the first message), linked artifacts (branches, PRs with check status, canvases, docs, chats). "Awaiting response" badge when an agent asked something.

## 5. Agents [live][ui]

An agent = name, icon/color, description, prompt, model, effort, permission mode, visibility (private / public to org; public agents can be read and copied but still run only on the owner's machine), "Runs on" machine, enabled flag. Concurrency: "Max concurrent agent runs" per device; extra triggered runs queue (queued runs can be edited, steered, or removed).

**Triggers:**
- Assigned to agent (always on)
- Issue created
- Issue moved to a stage (column)
- Label added
- Issue commented
- Issue assigned to specific people (with type/label filters)
- Schedule: cron, or plain-English that generates cron ("Weekdays 9am"), in the user's timezone
- Webhook URL with secret (any app can POST context)
- GitHub: PR opened / merged / ready for review / review submitted
- Slack: channel post, mention, reaction; channel posts start a new workspace, thread replies route back to the same workspace chat

**Templates (12):**

| Template | Trigger | Effort | Behavior |
|---|---|---|---|
| Bug Fixer | assigned | xhigh | Reproduce test-first, never guess from static analysis; skip dev-only bugs (close as won't-do); open a non-draft PR without auto-merge; screenshots or canvas link for UI changes; comment summary on issue, unassign self, assign PR Reviewer. Adds logging when it cannot reproduce. |
| Feature Builder | assigned | high | Checks out the issue's design branch, reads all linked context, files open questions on the issue, confirms its mental model with the PM before building, writes an implementation plan doc, builds on top of the canvas UI code (no duplicate UI), keeps scope tight (spins extras into New Idea), e2e happy-path tests. |
| Spec & Design | assigned | xhigh | Senior PM + designer. Produces a PRD in Docs and a clickable canvas prototype covering every state; self-reviewed by fresh-context sub-agents; never implements; works headless and asks the PM then stops. |
| Feedback Triage | Slack | — | Watches feedback channels; two-question routing ladder; researches, dedupes, files one precise issue; replies in thread with the issue link. |
| Board Sync on Merged PRs | GitHub | — | On merge, move the matching issue to done/Merged, reply once in the originating Slack thread, run non-automatic deploys if the repo documents them. |
| PR Reviewer | assigned | high | Adversarial. P0 blocks, P1/P2 comment, P3 ignored. Idempotent per head SHA. Verifies the PR does exactly what the issue claims (no scope creep). Canvases must point at real app code. Never pushes or merges. |
| Production Error Sweep | schedule | high | Pull 72h of errors (Sentry, PostHog, diagnostics), group into bugs, update existing issues or file new ones with evidence. |
| Daily Bug Report | schedule 9am weekdays | medium | Posts new vs fixed, open by priority, trend; never a partial report. |
| Build-in-Public Curator | schedule daily | medium | Read-only git; picks up to 5 tweet-worthy shipped changes; DMs drafts; never posts publicly. |
| Prioritization | schedule hourly | high | RICE-ranks the PM's queue in PM-minutes, tops it up to about half a day of work, DMs the top 3 decisions. |
| Brainstorming | schedule daily | high | Files 0 to 3 evidence-backed New Ideas labelled Needs PM Input; zero is the expected result. |
| Daily Release Driver | schedule nightly | xhigh | Cuts staging, watches CI in the foreground, fixes flakes properly, leaves a draft production build. |

**Shared prompt rules** every template includes:
1. *Pipeline preamble*: a Mermaid diagram of the whole factory and "where you sit". Agents act only inside their own box, hand the card to the next box, never do a downstream job, never move a card past a human gate. Columns are resolved at runtime with `issues_list_stages`; agents are matched by role, not name.
2. *Context hygiene*: on Slack, only post when @-tagged or explicitly asked in the reference app; issue comments are 1 to 2 sentences max; anything longer goes in a doc attached to the issue.

**The pipeline:**

```
Feedback -> Triage agent [New Idea]
  Bug  -> Bug Fixer: Reproduce -> Create fix   (or Add logging) [Ready For Dev] -> PR Review agent
  Feature -> Scoping agent [Scoping] -> HUMAN refine
          -> Spec + Concept Design agent [Spec & Concept Design] -> HUMAN refine
          -> Design Polish agent [Design Polish] -> HUMAN refine
          -> Feature Builder [Ready For Dev] <-> HUMAN confirms eng approach
          -> PR Review agent [PR Review] -> HUMAN merge -> Merged-PRs bot [Merged] (closes loop in Slack)
  Clear + small features skip Scoping.
```

## 6. Chat [ui]

Provider selector (Claude, Codex, Cursor, Grok, OpenCode), model selector, effort, fast-mode toggle, speed menu, Plan Mode (plan edited in a doc; "Clear Context & Execute plan"), attachments and drag-drop images, `@` context (files, designs, docs, Linear issues), slash commands with argument hints, MCP menu, Generate Design / Generate Prototype menu items, todo/task list extension, tool-call blocks with file actions, permission prompts (allow once, allow always with patterns, reject with message), ask-user-question cards, queued messages (edit/steer/delete while the agent works), compaction notice, turn summaries, token usage and cost, artifact strip (branches, PRs, previews), CLI mode (run the provider CLI in an embedded terminal and switch between GUI and CLI), chat transfer between workspaces, archive/unread/rename/bulk actions, recent chats.

Settings > Chat: default model and effort ("Last used" or fixed), a personal system prompt added to every conversation, personal **Skills** (saved workflows usable in any chat; the agent can create/edit them).

## 7. Design / Canvases [sdk][ui]

A canvas is a TSX file in the repo:

```tsx
import type { SdkPage, SdkStoryboard } from "<sdk>";
const page: SdkPage = { name: "Checkout", backgroundColor: "#232323" };
export default page;
export const Empty: SdkStoryboard = {
  name: "Empty cart",
  render: () => <Cart items={[]} />,
  layout: { x: 0, y: 0, width: 390, height: 844 },
};
```

Newer form: `<Canvas>` with `<Storyboard id component props layout vrt />`, `<RouteStoryboard route=... />` (a live route of the running app), `<HtmlStoryboard filepath=... />` (static HTML mockups). Svelte supported via `SvelteStoryboard`.

- A build plugin (Vite, Next.js, Expo) adds a `data-*-filepath` attribute / a `data-*-position` attribute to every JSX element when an env flag, so clicking a rendered element maps to its exact source location.
- A canvas devserver renders storyboards; a supervisor manages the app's own dev server for route storyboards (attached over CDP).
- **Style panel**: layout (flex, grid templates, align, distribute, tidy up), position, padding/margin, size and aspect ratio, typography, fill (colors, gradients, image fills), stroke, effects, transforms, SVG fill/stroke. Edits are written straight back into source. Supports CSS variables / design tokens with a Variables modal (aliases, component-scoped vars).
- **AI mode**: edits that cannot be applied deterministically (dynamic styles, loop-rendered elements, missing fonts) are staged in a ledger and applied by an agent in one commit.
- Detach component instances, duplicate storyboards, layers panel, locked layers, frame presets.
- Figma paste (with a personal access token for image fills).
- Canvas comments: pinned threads on the canvas, attachments, reactions, resolve.
- Visual regression testing per storyboard (thresholds, ignore regions); changes compared in PRs.
- Canvas home page with thumbnails per branch, folders, sort and categorize by branch, share links.
- Design-system skills: generate design system (one canvas per component family, components declared as insertable assets, design debt storyboards), audit violations, harden, design review.

## 8. Docs [live][ui]

Doc tree with sub-pages and custom icons, collaborative Yjs editor (TipTap/ProseMirror), Mermaid diagrams, embedded canvases and storyboards, AI chat side panel, "generate canvases from a doc", docx and PDF viewers, link to issues. Empty-state copy: "Docs define what to build. Write one here, then generate canvases from it."

## 9. Source control [ui]

Full git client: changed files with stage/unstage/discard, diff view (full or hunks), commit bar (commit, amend, sign-off, commit and push, commit and sync, AI-written messages), branches (create, rename, switch), remotes (add, change, copy, open), tags, stash, fetch/pull/push, undo commit, abort rebase, behind-remote indicator with pull, publish branch, create PR, PR check status (passing/failing), PR review state (approved / changes requested). PR insights dashboard (per-user metrics chart).

## 10. Integrations [live]

- **Linear**: sync chosen teams' issues into the reference app, use as AI context, optional write-back (agents update issues and comment as the reference app).
- **Slack**: one org-wide connection; agents read threads, post messages, react, and trigger from channel activity once `@mention` is invited.
- **GitHub**: repo per project, PR triggers with webhook secret.
- **Figma**: personal access token.
- **MCP**: personal access tokens to use the reference app's MCP server from outside agents; manage MCP servers from chat.

## 11. Settings [live]

Personal: Preferences (theme, auto-upload canvas diagnostics, max concurrent agent runs, open chat/PR links inside the reference app, Figma token), Chat (default model/effort, system prompt, skills), Billing, Auth tokens, Providers.

Billing (managed inference): Pro $30/mo, Scale $50/mo, Ultimate $100/mo, Power $350/mo; the price equals monthly model credit; promo codes; skip entirely if your own Anthropic/Bedrock/etc. credentials are detected.

Providers (BYO key per model, stored on device): OpenCode (GLM 5.2, Big Pickle, Kimi K3, Grok 4.7/4.6, DeepSeek V4 Pro, Qwen3.6 Plus), Codex (GPT-6 Astra, GPT-6.1 Sol, GPT-6 Sol/Luna, GPT-5.6 Sol/Terra, GPT-5.5, GPT-5.3 Codex Spark), Claude Code (Opus 5.5/5, Fable 5.1, Opus 4.8, Sonnet 5.5/5 all 1M, Haiku 4.5). Optional OpenAI-compatible base URL.

Org: General, Members, Projects, Stages, Admin, Integrations, Agents (public agents).

## 12. Onboarding [ui]

Role picker, project method (generate / open / import), invite team, then "Start your first agents" with four starter tasks, each opening its own workspace and running a skill: **Spec and design a feature** (12 min, ~150k tokens), **Generate a design system** (20 min, ~300k), **Audit my tests and CI** (10 min, ~120k), **Launch Your Software Factory** (8 min, ~80k: finds where tickets and feedback live, pulls the three lowest-hanging issues in, assigns agents).

## 13. Gap against Cadence (this repo)

Status after the seven-phase rebuild (2026-10-06) and the gap work on 2026-10-07 and 2026-10-08. "Not built" items are the remaining gaps.

| Area | The reference app | Cadence now | Not built |
|---|---|---|---|
| Pipeline | 6 agent roles across 5 stage categories, 3 to 4 human gates | Same 12-stage default workflow, categories, gates enforced for agents and MCP clients | |
| Stages | Org-configurable, categories, colors, order | Configurable (admins only in team mode) | |
| Agents | User-defined, templates, many trigger kinds, schedules, webhooks, queue, steer, private/public | Same, plus Slack triggers and PR-watcher GitHub triggers; 10 templates in our own words; private agents (owner only) and public agents (team can read and copy; owner or admins manage) | |
| Agent runtime | Claude Code / Codex / Cursor / Grok / OpenCode harnesses | Claude Code through the Agent SDK; Codex, Cursor, Grok, and OpenCode over the Agent Client Protocol (src/agents/acp), with board tools reached through a per-session MCP bridge, mode and model mapping, approvals, resume, and CLI mode. Codex verified live | |
| Tool surface | Its MCP server (issues, docs, canvas, agents, Slack, Linear) | Board, docs, PR, canvas, Slack, Linear, agent-management, and built-in browser tools; MCP endpoint with personal tokens (now owned by a member) | |
| Workspaces + chat | Multi-chat per branch, plan mode, attachments, @ context, slash commands, CLI mode, built-in browser | All of these, plus queued/steered messages; chat transfer; personal system prompt and skills; built-in browser (a host Chrome tab per workspace, streamed to the side panel, driven by people and agents) | |
| Docs | Collaborative rich-text tree, embedded canvases, generate canvases | Tree, TipTap editor, mermaid, history, imports, AI panel, live co-editing, canvas embeds (```canvas blocks with previews and a picker), "Generate canvases" agent flow | |
| Canvases | Full visual editor writing back to source | Own canvas format (*.canvas.tsx, or .ts for Svelte), Vite devserver, selection, style panel with gradient and image fills, layer and frame locking, Agent queue, comments, VRT, Figma import; design tokens (a Variables panel editing the project's CSS variables in place, with token suggestions in the style panel); detaching a component instance into a per-storyboard copy; canvas home grouped by branch, folder, or project and sortable; visual checks posted to the pull request as one updating comment; a design actions menu (generate a design system, audit violations, design review, harden components); Svelte frames; Next.js and Expo through the cadence-build package (webpack/Turbopack loader, Babel plugin), an app supervisor, and a bridge proxy. Next 16 and Expo 57 verified live | |
| Source control | Full git client, PRs, checks, insights | Full git client, AI commit messages, commit-and-sync, hunk-level staging, PR open/track, checks and reviews, insights | |
| Integrations | Linear, Slack, GitHub, Figma, MCP tokens | All five (Slack over Socket Mode) | Live-tested only against fakes for Slack, Linear, GitHub, Figma (no credentials on the build machine) |
| Collaboration | Orgs, members, invites, presence, comments, share links | Multiple organizations (each its own data folder and container, switcher, per-org sign-in), members and roles, invites by link or email (SMTP per org), access requests, presence, comments, share links | |
| Inference/billing | Managed credits, BYO keys, multi-provider | Harness logins or BYO keys per provider (Settings > Providers); usage by harness, agent, and person, with org and per-agent monthly budgets that pause work (Settings > Usage) | The reference app's own paid inference proxy (not applicable to a self-hosted tool) |
| Onboarding and home | Role picker, generate / open / import, starter agents | Home page ("Let's build.") with generate (mockup, React prototype, blank), open folder, and import; first-run onboarding (role, project, team invites, four starter agents) | |
| Machines | Remote workspaces on other computers, remote-control sessions | Machines connect out to a hub with a token (src/machines); the hub relays each shared port on its own origin, so a machine's whole Cadence (workspaces, chats, canvases with live reload, terminals) opens from the hub; the hub lists running chats and answers approvals on the machine | Hosted cloud machines (the reference app runs VMs for you; Cadence connects computers you already run) |
| App shell | Themes, back and forward, split view, bug reports | Light, dark, or system theme; back and forward arrows; split view (a second view beside the main one); bug reports with a screen recording, filed on the board | |

## 14. Second pass (2026-10-12): live project and the public packages

Sources added in this pass:

- **[live2]** the running app with a real project open (`recursive-self-improvement`, one local workspace, an agent chat mid-run), driven over the app's DevTools port.
- **[mcp]** the public the reference MCP package package (0.0.124). Its source maps carry the original TypeScript for every toolset, the agent templates, the canvas guide, and the devserver.
- **[vr]** the public the reference visual-review package package (0.0.124): the GitHub Actions capture and report CLI.
- The reference SDK is at 0.0.52 (was 0.0.51). A separate npm package of the same family is a 2025 legacy CLI and out of scope.

### 14.1 Things the first pass missed

| Area | What the reference app does | Source |
|---|---|---|
| Workflow skills | Installs 16 slash commands into `~/.claude/commands`: onboarding, design, generate-design, generate-prototype, generate-design-system, generate-product-flows, html-to-jsx, spec-design-feature, launch-software-factory, audit-tdd, audit-design-system-violations, design-review, harden, canvas-code-quality, designer-pr-polish, document-design-preferences | [live2] |
| Run and setup scripts | Per project: Org Setup Script and Org Run Scripts (shared), My Setup Script and My Run Scripts (personal). Setup runs as `org && mine` with a source-path env var pointing at the source checkout. The top bar has a Run button for the named commands; with none, it opens project settings. Danger zone: "Delete from client" | [live2][mcp] |
| Standalone MCP | `npx the reference MCP package` (stdio) for any local agent host, and a hosted its hosted MCP endpoint (OAuth). Flags `--toolsets a,b` and `--readonly`; `login`, `whoami`, `token create`. Toolsets: issues, docs, comments, agents, scripts, slack, linear, design-context, canvas, assets | [mcp][live2] |
| Tool surface | About 150 tools (list in 14.2) against Cadence's 54 | [mcp] |
| Code intelligence | Bundled typescript-language-server and tsserver processes run per project | [live2] |
| Welcome canvas | `resources/welcome-canvas-template`: a demo canvas of hero components (chat, docs, issues, build, run, models) | [live2] |
| Canvas project | the project settings file (canvases root, install and start scripts, `apps[0]` start/stop/url for the real app), a a sidecar folder sidecar host, canvases at `designs/<zone>/<name>/index.canvas.tsx`, zones `design-system/`, `libraries/<lib>/`, `canvases/`. "Set up canvases" scaffolds this | [mcp][live2] |
| Asset libraries | `defineAsset(Component, {...})` declarations in zone canvases form named libraries (design system, component library, UI kit); agents call `asset_list` before building UI and reuse per `usageInstructions`. `defineControls` gives prop editors | [mcp] |
| Canvas agent protocol | `start_working_on_canvas` locks the canvas from auto-refresh and shows "agent editing"; `finish_working_on_canvas` releases and refreshes. `canvas_validate`, `canvas_debug`, `canvas_compute_layout`, `canvas_set_home`, `canvas_verify_vrt` (renders N fresh mounts and compares), `canvas_set_vrt`, `canvas_share` | [mcp] |
| Visual review CI | `visual_review_doctor` / `visual_review_init` write `.github/workflows/visual-review.yml`, which runs the reference visual-review package (`claim`, `install-browsers`, `capture --parallel`, `report`): captures tracked storyboards in Actions, sets a `visual-review` commit status, and keeps one sticky PR comment | [vr][mcp] |
| Design context | `list_design_context_targets` / `get_design_context`: an outside agent reads the current canvas selection in the desktop app (source locations, classes, ancestors, storyboard, errors, PNGs), like Cmd+L | [mcp] |
| Comment inbox | Canvas comment threads with positions, reactions, read state, @mentions; a global unread-notification inbox; org-wide thread list and search; per-canvas activity feed | [mcp] |
| Git panel details | Changes list sort (path, name, status), list or tree view, "Open remote in browser", commit submenu (staged / all / amend / signed off), undo last commit, abort rebase | [live2] |
| Providers | Bring-your-own key per model, not per provider | [live2] |
| Chat details | Header "N tool calls, M messages"; background task list ("2 Tasks, recent"); context window percent; turn duration; per-tool "Open in..." | [live2] |
| 0.0.121 (not installed) | ChatGPT sidebar app with GitHub-backed cloud canvases; canvases side by side with the active chat | [live2] |

### 14.2 Built in this pass (2026-10-12)

Personal and shared prep and Run commands with a Run button and CADENCE_SOURCE_PATH; manual issue ranking; about 80 new agent tools (issues, docs, agents, Slack, canvas comments, canvas protocol, host, assets, selection context, visual check); toolsets and read-only MCP connections; the `cadence-mcp` stdio package; a comment inbox; the 16 workflows as built-in /skills; component kits (`assets` in a canvas's default export); Div, Rectangle, and Text drawing tools; a browser bar for route frames; layer class and read-only toggles; main canvas and open-beside; per-model provider keys; git sort, tree view, and open remote; visual check in GitHub Actions (src/ci); copy and run on chat code blocks, and clickable file paths.

Later the same day: a context-window gauge and background-task list in chat; the welcome tour (a Welcome workspace with a seeded chat and a tour canvas beside it, after onboarding or from Help); code intelligence in the Files editor through TypeScript 7's own language server (`tsc --lsp --stdio`, one per editor connection, pull diagnostics, hover, completion, definitions, rename) over /api/workspaces/:id/lsp; OAuth 2.1 on /mcp (discovery documents, dynamic client registration, authorization code with PKCE, a consent page; approving mints a personal MCP token) so ChatGPT, claude.ai, and Claude mobile connectors can sign in.

From the UI label audit: doc text and background colors (stored as `<span data-color>` and `<mark data-color>`, sanitized in read-only views), Change to, Heading 4, Ask the assistant and Keep writing, Markdown and PDF export; canvas element arrange (forward, backward, front, back), duplicate, delete, and Send to chat; drawing tool variants (column, row, grid, box; seven shapes; heading, paragraph, label, link); blend mode, filter, and box-sizing style fields with Hug and Fill sizes and an eyedropper; grouped frame presets; pasting Figma links; Slack PDF page images and Google Docs reading; comment thread reading and exact-replace issue body edits for agents; a visual check commit status; public agents that teammates can edit (running, deleting, and changing access stay with the owner and admins); a "release published" GitHub trigger and a PR author filter; Slack triggers that include other bots (bots never wake an agent's thread); chat sidebar sorting; a canvas Comments list with only-yours, resolved, and oldest or unread-first sorting; discarding a single hunk and folding unchanged diff lines; a first-run check for Node, Git, and Claude Code; an interface size setting (Ctrl+Alt+= and Ctrl+Alt+-); and descriptions for the harness's own slash commands in the composer (from the SDK's `supportedCommands()` or ACP's command list).

From testing on a real project made with the reference app (2026-10-13): Cadence now reads and edits that app's current canvas format, a default-exported component returning `<Canvas>` with `<Storyboard component={X}>`, `<RouteStoryboard>`, `<HtmlStoryboard>`, and `<SvelteStoryboard>` children laid out by `layout={{...}}` (src/canvas/jsx-format.ts). Edits write attributes back so the file stays valid in that format; the format's tag module resolves to a stand-in inside the canvas devserver; a marker comment marks the main canvas; the app's dev command and URL come from `apps[0]` in the project settings file (src/canvas/project-config.ts). The exact names those files use live in src/canvas/jsx-compat.ts. New workspaces a person creates bring over the project folder's uncommitted work (src/git/carry-over.ts); agents' workspaces start from the last commit.

From the desktop audit (2026-10-13, against the reference app's 187-method preload API and its install folder): Cadence is an Electron app too (src/desktop). Its window bridge (preload.cjs, exposed as `window.cadenceDesktop`) gives pages a native folder picker, paths of files and folders dropped from the file manager, reveal in the file manager, a memory readout across every process including the server, and update state. The menu has Settings (Ctrl+,), Keyboard Shortcuts, Report a Problem, Check for Updates, and the data and logs folders. The window remembers its size and position. Updates come from GitHub releases through electron-updater, download in the background, and install on restart (a banner offers it). Workspaces open in the file manager or any installed editor (src/workspaces/open-in.ts). Canvases pop out into their own window. Where the reference app ships Node.js inside its installer, Cadence offers to install the official Node 24 release into its data folder, checked against the release's SHA-256 (src/projects/node-toolchain.ts). The built-in browser and canvas screenshots use Chrome or Edge when present and Electron's own Chromium otherwise (src/desktop/browser-host.cjs opens offscreen windows, since Electron's DevTools cannot create tabs). The reference app's remaining preload methods are git and workspace operations that Cadence's server API already covers.

Not reproduced, by design: the reference app's paid inference proxy, its hosted cloud machines, and the ChatGPT sidebar app with GitHub-backed cloud canvases from 0.0.121 (Cadence is self-hosted; its OAuth MCP endpoint is what a ChatGPT connector uses).
