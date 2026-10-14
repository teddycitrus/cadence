# Running a Cadence team server

A team server is one always-on Cadence that everyone signs in to, from the
desktop app (Settings > Preferences > Join) or a browser. Projects, the board,
docs, canvases, and agents live on it, so the team keeps working when any one
laptop is closed.

If you only need teammates in for a while, you do not need a server: in the
desktop app, open Settings > Members and choose **Share this computer**. That
gives your Cadence a public address through a free Cloudflare tunnel for as
long as your computer is on.

## What it needs

- Docker (or any host that runs a Dockerfile)
- A volume for `/data`, where the database, workspaces, and settings live
- An HTTPS address in front of it (most hosts provide one)

## Run it with Docker

```sh
docker build -f config/Dockerfile -t cadence .
docker run -d --name cadence -p 4317:4317 -v cadence-data:/data \
  -e CADENCE_OWNER_EMAIL=you@example.com \
  -e CADENCE_OWNER_PASSWORD='a long password' \
  -e CADENCE_PUBLIC_URL=https://cadence.example.com \
  cadence
```

Put a reverse proxy with HTTPS (Caddy, nginx, Traefik, or Cloudflare) in front
of port 4317, then sign in at your address with the owner email and password.

## Deploy to a host

**Railway.** Create a service from this repository, set the variable
`RAILWAY_DOCKERFILE_PATH` to `config/Dockerfile`, add a volume mounted at
`/data`, and set the owner variables below. Railway assigns `PORT` and an
HTTPS domain; set `CADENCE_PUBLIC_URL` to that domain.

**Fly.io.**

```sh
fly launch --no-deploy --dockerfile config/Dockerfile
fly volumes create cadence_data --size 10
fly secrets set CADENCE_OWNER_EMAIL=you@example.com CADENCE_OWNER_PASSWORD='a long password'
```

Mount the volume at `/data` in `fly.toml` (`[mounts] source = "cadence_data"`,
`destination = "/data"`), set `CADENCE_PUBLIC_URL` to your `https://<app>.fly.dev`
address, and `fly deploy`.

**Render, or any VPS.** Use the Dockerfile at `config/Dockerfile`, a persistent
disk at `/data`, and the same variables.

## Settings

| Variable | What it does |
|----------|--------------|
| `CADENCE_OWNER_EMAIL`, `CADENCE_OWNER_PASSWORD` | The owner's sign-in, set on first start. Required: the server will not start on a network address without a way to sign in. |
| `CADENCE_OWNER_NAME` | The owner's display name (optional) |
| `CADENCE_PUBLIC_URL` | The address people use, for invite links, share links, and webhook URLs |
| `PORT` or `CADENCE_PORT` | The port to listen on (default 4317) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ... | Model keys for agents; these can also be added in Settings > Providers |

After the first start, change the owner password in Settings > Members; the
environment variables only apply while no password is set.

## Inviting the team

Sign in as the owner, open Settings > Members, and create invite links. Each
person opens their link (in a browser, or by pasting it into the desktop app's
Join box) and makes their own account. Members work the board, docs, and
canvases; admins can also run agents, terminals, and git.

## Models and accounts on a server

Agents run on the server, so its models are set up on the server: add API keys
in Settings > Providers, or sign in there with **Sign in with your account**
(the sign-in runs in a terminal on the server). GitHub, Slack, Linear, and Figma
are connected the same way as on a single computer.

## Canvases for teammates

Canvas previews run on dev servers the server starts for each workspace.
Teammates viewing from elsewhere get each preview on its own temporary HTTPS
address (a Cloudflare quick tunnel the server opens on demand), so a project's
code never runs on Cadence's own address. The server needs outbound internet
access for this; `cloudflared` is downloaded on first use and checked against
the checksum Cloudflare publishes.
