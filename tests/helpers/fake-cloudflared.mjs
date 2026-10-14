// Stands in for cloudflared in tests: prints what the real one prints once a
// tunnel is up, records its arguments, and stays running until killed.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_CLOUDFLARED_LOG) appendFileSync(process.env.FAKE_CLOUDFLARED_LOG, `${JSON.stringify(args)}\n`);
if (process.env.FAKE_CLOUDFLARED_FAIL) {
  process.stderr.write("2026-10-14T00:00:00Z ERR failed to request quick Tunnel: 429 Too Many Requests\n");
  process.exit(1);
}
setTimeout(() => {
  if (args.includes("run")) process.stderr.write("2026-10-14T00:00:00Z INF Registered tunnel connection connIndex=0\n");
  else {
    const port = args[args.indexOf("--url") + 1]?.split(":").pop();
    process.stderr.write(`2026-10-14T00:00:00Z INF |  https://fake-tunnel-${port}.trycloudflare.com  |\n`);
  }
}, 100);
setInterval(() => {}, 1000);
