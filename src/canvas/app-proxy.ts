import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { BRIDGE_SOURCE } from "./bridge";

const BRIDGE_PATH = "/__cadence/bridge.js";

/** The selection bridge as a classic script, for pages Cadence did not build (Next.js, Expo). */
export function classicBridge(parentOrigins: string[]): string {
  const body = BRIDGE_SOURCE.replace("__PARENT_ORIGINS__", JSON.stringify(parentOrigins))
    .split("\n")
    .filter((l) => !l.includes("import.meta"))
    .join("\n");
  return `(() => {\n${body}\n})();\n`;
}

/** Puts the bridge script at the start of <head> (or of the document). */
export function injectBridge(html: string): string {
  const tag = `<script src="${BRIDGE_PATH}"></script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  return tag + html;
}

/** Headers that would stop the page loading in Cadence's frame or running the injected bridge. */
const DROP = new Set(["x-frame-options", "content-security-policy", "content-security-policy-report-only", "content-length", "content-encoding", "transfer-encoding"]);

interface Running {
  server: Server;
  url: string;
}

/**
 * Request headers as the app expects them from its own origin. Dev servers
 * refuse cross-origin HMR and dev resources (Next.js allowedDevOrigins), so
 * Host, Origin, and Referer name the app rather than the proxy.
 */
function asUpstream(headers: IncomingMessage["headers"], host: string, port: number, origin: string): IncomingMessage["headers"] {
  const out: IncomingMessage["headers"] = { ...headers, host: `${host}:${port}` };
  if (out.origin) out.origin = origin;
  if (typeof out.referer === "string") {
    try {
      const r = new URL(out.referer);
      out.referer = `${origin}${r.pathname}${r.search}`;
    } catch {
      delete out.referer;
    }
  }
  return out;
}

/**
 * Proxies an app's own dev server (Next.js, Expo, anything on localhost) so
 * route frames get the selection bridge: HTML pages have it injected,
 * everything else (assets, HMR websockets) passes straight through.
 */
export class AppProxies {
  private running = new Map<string, Running>();
  private starting = new Map<string, Promise<string>>();

  constructor(private parentOrigins: string[]) {}

  /** The proxy URL for an app URL on this machine, starting the proxy if needed. */
  ensure(target: string): Promise<string> {
    const url = new URL(target);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return Promise.reject(new Error("Only apps on this machine can be proxied"));
    const key = url.origin;
    const r = this.running.get(key);
    if (r) return Promise.resolve(r.url);
    let p = this.starting.get(key);
    if (!p) {
      p = this.start(url).finally(() => this.starting.delete(key));
      this.starting.set(key, p);
    }
    return p;
  }

  private start(target: URL): Promise<string> {
    const port = Number(target.port || 80);
    const host = target.hostname === "localhost" ? "127.0.0.1" : target.hostname;
    const server = createServer((req, res) => {
      if (req.url === BRIDGE_PATH) {
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
        // Built per request: the origins it may talk to grow when people view from elsewhere.
        res.end(classicBridge(this.parentOrigins));
        return;
      }
      this.forward(req, res, host, port, target.origin);
    });
    // HMR and other websockets: a raw pipe to the app.
    server.on("upgrade", (req, socket, head) => {
      const upstream = connect(port, host, () => {
        const headers = asUpstream(req.headers, host, port, target.origin);
        const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`, ...Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : v !== undefined ? [`${k}: ${v}`] : []))];
        upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      const end = () => {
        upstream.destroy();
        socket.destroy();
      };
      upstream.on("error", end);
      socket.on("error", end);
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        this.running.set(target.origin, { server, url });
        resolve(url);
      });
    });
  }

  private forward(req: IncomingMessage, res: ServerResponse, host: string, port: number, origin: string): void {
    const headers = asUpstream(req.headers, host, port, origin);
    // Uncompressed, so HTML can be edited on the way through.
    delete headers["accept-encoding"];
    const up = request({ host, port, method: req.method, path: req.url, headers }, (upRes) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upRes.headers)) if (v !== undefined && !DROP.has(k)) out[k] = v;
      // Redirects to the app itself (by either loopback name) stay inside the proxy.
      if (typeof out.location === "string") {
        for (const self of [origin, `http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
          if (out.location.startsWith(self)) {
            out.location = out.location.slice(self.length) || "/";
            break;
          }
        }
      }
      const html = (upRes.headers["content-type"] ?? "").includes("text/html");
      if (!html) {
        res.writeHead(upRes.statusCode ?? 502, out);
        upRes.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      upRes.on("data", (c: Buffer) => chunks.push(c));
      upRes.on("end", () => {
        const body = Buffer.from(injectBridge(Buffer.concat(chunks).toString("utf8")), "utf8");
        res.writeHead(upRes.statusCode ?? 200, { ...out, "content-length": String(body.length) });
        res.end(body);
      });
    });
    up.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`The app at ${origin} is not answering (${err.message}). Start its dev server, or set appCommand in the canvas so Cadence starts it.`);
    });
    req.pipe(up);
  }

  async stopAll(): Promise<void> {
    const all = [...this.running.values()];
    this.running.clear();
    await Promise.all(
      all.map(
        (r) =>
          new Promise((done) => {
            r.server.close(() => done(undefined));
            // Keep-alive and HMR connections would hold close() open.
            r.server.closeAllConnections();
          }),
      ),
    );
  }
}
