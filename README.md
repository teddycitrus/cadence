<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->
<div align="center">

[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]

</div>

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <h3 align="center">Cadence</h3>

  <p align="center">
    A desktop workspace where people and AI agents plan, design, and build software together, on your own machine.
    <br />
    <a href="https://github.com/teddycitrus/cadence"><strong>Explore the docs »</strong></a>
    <br />
    <br />
    <a href="https://github.com/teddycitrus/cadence/issues/new?labels=bug">Report Bug</a>
    &middot;
    <a href="https://github.com/teddycitrus/cadence/issues/new?labels=enhancement">Request Feature</a>
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#how-it-fits-together">How It Fits Together</a></li>
        <li><a href="#what-it-does">What It Does</a></li>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#running-it-locally">Running It Locally</a></li>
        <li><a href="#building-the-installer">Building The Installer</a></li>
      </ul>
    </li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#configuration">Configuration</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#contact">Contact</a></li>
  </ol>
</details>

<!-- ABOUT THE PROJECT -->
## About The Project

Cadence puts the whole loop of building software in one app: an issue board,
written plans, visual canvases of your real components, and chats with coding
agents that work on their own branches. People and agents share all of it. An
agent picks up an issue, works in its own workspace, opens a pull request, and
hands off to the next stage, while the people on the team steer, review, and
sign off.

Everything runs on your machine. Your code stays in your repositories, agents
run through the harnesses you already use (Claude Code, Codex, Cursor and
others) with your own logins or keys, and nothing is sent to a hosted service
that you did not set up.

### How It Fits Together

The app is an Electron window around a local server. The server runs as a child
process on Electron's own Node, so heavy work (agent runs, git, dev servers)
never stalls the window, and it shuts down cleanly with the app.

A few choices are worth knowing about:

- **Event sourced.** Every change is an event in a SQLite database; the board,
  docs, chats, and canvases are projections of it. History, undo, and live
  updates all come from the same log.
- **One branch per piece of work.** Each workspace is a git worktree on its own
  branch, so several agents and people can work at once without stepping on
  each other. A workspace you create brings along the project folder's
  uncommitted work; an agent's starts from the last commit.
- **Canvases are source.** A canvas is a `*.canvas.tsx` file in your repo that
  lays out frames rendering your real components and routes. Restyling an
  element on the canvas writes the change back to the component's source.
- **Agents see the same tools you do.** Board, docs, canvas, git, browser, and
  Slack tools are served over MCP, so outside agents can connect too, with a
  personal token or OAuth.

### What It Does

- An issue board with stages, sign-off stages that agents cannot move work
  out of, saved views, filters, manual ordering, and bulk actions.
- Agents with their own instructions and triggers: assignment, stage changes,
  labels, schedules, webhooks, GitHub events, and Slack messages, with budgets
  and a run queue.
- Workspaces with several chats each, plan mode, permission prompts, a
  terminal, a file editor with TypeScript code intelligence, a built-in browser,
  and a full git client with pull request checks and reviews.
- Docs with a rich editor, live co-editing, history, diagrams, and canvases
  embedded inline.
- Canvases of your own components and routes, with a style panel, drawing
  tools, comments, design tokens, and screenshot checks that run in CI.
- Teams: members and roles, invites, share links, several organizations, and
  remote computers that connect to a hub.

### Built With

- Electron 44
- TypeScript 7, Node 24, Express 5, SQLite (`node:sqlite`)
- React 19, Vite 8, Tailwind CSS 4
- TipTap 3 and Yjs for docs, CodeMirror 6 for code, xterm.js for terminals
- The Claude Agent SDK, and the Agent Client Protocol for other harnesses
- Vitest for tests, electron-builder for installers

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- GETTING STARTED -->
## Getting Started

### Prerequisites

- Node 24 or newer, to build and run from source (the installed app can
  install Node for your projects itself)
- Git
- An account or API key for at least one model: a Claude subscription or an
  Anthropic key works out of the box, since Cadence includes Claude Code

The first run checks all three. You can sign in to Claude or paste a key right
there, and Cadence offers to install Node if it is missing.

### Running It Locally

```sh
git clone https://github.com/teddycitrus/cadence.git
cd cadence
npm install
npm run app
```

`npm run app` builds the interface and the desktop bundle, then opens Cadence
in its own window. The first run walks you through setup: what you do, a check
of this machine's tools, a project (start one, open a folder, or clone a
repository), your team, and your first agents.

To work on Cadence itself with live reload, run the server and interface in a
browser instead:

```sh
npm run dev
```

and open `http://localhost:5317`.

### Building The Installer

```sh
npm run package
```

This builds everything and writes an installer to `release/`: an NSIS installer
on Windows, a DMG on macOS, and an AppImage on Linux. Build on the platform you
are targeting. The installers are not code signed yet, so Windows and macOS
will warn on first launch.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- USAGE -->
## Usage

```sh
npm run app             # build, then open the desktop app
npm run package         # build the installer into release/
npm run dev             # server and interface with live reload, in a browser
npm start               # the server alone, serving the built interface on :4317
npm run build           # type check, then build the interface to dist/web
npm run build:desktop   # bundle the desktop main process and server to dist/desktop
npm test                # the test suite
npm run lint            # type check
```

Inside the app, everything starts from the left rail: Home, Chats, Issues,
Agents, Docs, and Canvases, with Settings at the bottom. Press `Ctrl+K`
(`Cmd+K` on macOS) to jump anywhere.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONFIGURATION -->
## Configuration

The desktop app keeps its data, logs, and settings in the per-user app data
folder (`%APPDATA%\Cadence` on Windows, `~/Library/Application Support/Cadence`
on macOS, `~/.config/Cadence` on Linux). It serves on port 4317 when that port
is free and remembers whichever port it ends up using, since MCP connections and
share links point at it.

Most settings live in the app, under Settings. When running the server on its
own (`npm start`), these environment variables apply:

| Variable | Default | What it does |
|----------|---------|--------------|
| `CADENCE_PORT` | `4317` | The port to serve on |
| `CADENCE_DATA_DIR` | `./data` | Where the database, worktrees, and settings live |
| `CADENCE_HOST` | `127.0.0.1` | The address to listen on |
| `CADENCE_API_TOKEN` | not set | A token every API call must carry |
| `CADENCE_TRUST_LOCAL` | on without a token | Treat requests from this machine as the owner |

Cadence refuses to listen on a network address until a password or
`CADENCE_API_TOKEN` is set, so a team server is never left open by accident.

### Accounts And Keys

Cadence has no hosted service and no account of its own. Everything it talks
to uses your own sign-in or key, entered in the app and kept on your machine
(in the data folder, never sent to the browser or to other team members).

| For | Where | What it takes |
|-----|-------|---------------|
| Claude Code | Settings > Providers | Sign in with your Claude account, or an `ANTHROPIC_API_KEY` (and optional `ANTHROPIC_BASE_URL`) |
| Codex | Settings > Providers | Sign in with your ChatGPT account, or an `OPENAI_API_KEY` |
| Cursor, Grok, OpenCode | Settings > Providers | Their own sign-in once installed, or `CURSOR_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY` |
| GitHub | Settings > GitHub | A personal access token, or your `gh` CLI login |
| Slack | Settings > Integrations | A bot token and an app-level token from your own Slack app |
| Linear | Settings > Integrations | A Linear API key |
| Figma | Settings > Integrations | A Figma personal access token |
| Email invites | Settings > Members | Your SMTP server |
| MCP servers | Settings > Integrations | Whatever each server needs |

Keys can also be set for one model only, under Keys per model. The usual
environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`
or `GH_TOKEN`) work too when running the server yourself, and
`CADENCE_CLAUDE_CLI` points Cadence at a different `claude` binary.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ROADMAP -->
## Roadmap

- [x] Issue board, stages, and agents with triggers and budgets
- [x] Workspaces with chats, terminal, files, browser, and git
- [x] Docs with live co-editing
- [x] Canvases with source write-back and screenshot checks in CI
- [x] Teams, share links, organizations, and remote computers
- [x] Desktop app with an installer
- [x] Automatic updates from GitHub releases
- [ ] Code signing
- [x] An app icon and loading animation
- [ ] Hosted remote computers

See the [open issues](https://github.com/teddycitrus/cadence/issues) for the
full list.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTRIBUTING -->
## Contributing

Contributions are welcome. Fork the repo, create a feature branch, and open a
pull request.

```sh
git checkout -b feature/your-feature
git commit -m "Add your feature"
git push origin feature/your-feature
```

Please run the tests and the type check first:

```sh
npm test
npm run lint
```

Keep files under 500 lines, and validate input wherever it crosses into the
server.

> **Note:** Agents run real commands in your repositories with the permissions
> you give them. Review an agent's instructions and permission mode before
> enabling it, especially on a shared machine.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- LICENSE -->
## License

No license file yet. Until one is added, all rights are reserved.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTACT -->
## Contact

Project Link: [https://github.com/teddycitrus/cadence](https://github.com/teddycitrus/cadence)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- MARKDOWN LINKS & BADGES -->
[contributors-shield]: https://img.shields.io/github/contributors/teddycitrus/cadence.svg?style=for-the-badge
[contributors-url]: https://github.com/teddycitrus/cadence/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/teddycitrus/cadence.svg?style=for-the-badge
[forks-url]: https://github.com/teddycitrus/cadence/network/members
[stars-shield]: https://img.shields.io/github/stars/teddycitrus/cadence.svg?style=for-the-badge
[stars-url]: https://github.com/teddycitrus/cadence/stargazers
[issues-shield]: https://img.shields.io/github/issues/teddycitrus/cadence.svg?style=for-the-badge
[issues-url]: https://github.com/teddycitrus/cadence/issues
