import { Router, json } from "express";
import { z } from "zod";
import type { AuthService } from "../../auth/service";
import type { SharingService } from "../../sharing/service";
import { identify, type AuthOptions } from "../auth-middleware";

/**
 * /api/sharing: whether people elsewhere can reach this Cadence, and (owner only) turning a
 * tunnel on or off. Opening this computer to the internet is the owner's call, and only once
 * sign-in is set up, since everyone arriving through it must sign in.
 */
export function sharingRoutes(sharing: SharingService, auth: () => AuthService, authOptions: () => AuthOptions): Router {
  const r = Router();
  r.use(json());
  const who = (req: Parameters<typeof identify>[0]) => identify(req, auth(), authOptions());

  r.get("/", (req, res) => {
    const me = who(req);
    if (!me) return void res.status(401).json({ error: "Sign in to Cadence", signIn: true });
    res.json({ ...sharing.status(), canManage: me.role === "owner" });
  });

  const ownerOnly = (req: Parameters<typeof identify>[0]): string | null => {
    const me = who(req);
    if (!me) return "Sign in to Cadence";
    if (me.role !== "owner") return "Only the owner can open this computer to the internet";
    return null;
  };

  r.post("/start", async (req, res) => {
    const denied = ownerOnly(req);
    if (denied) return void res.status(403).json({ error: denied });
    if (!auth().hasTeam()) return void res.status(409).json({ error: "Set a password for your account first (Settings > Members), so everyone who arrives through the public address has to sign in." });
    const { mode } = z.object({ mode: z.enum(["quick", "named"]).default("quick") }).parse(req.body ?? {});
    res.json(await sharing.start(mode));
  });

  r.post("/stop", async (req, res) => {
    const denied = ownerOnly(req);
    if (denied) return void res.status(403).json({ error: denied });
    res.json(await sharing.stop());
  });

  r.put("/named", (req, res) => {
    const denied = ownerOnly(req);
    if (denied) return void res.status(403).json({ error: denied });
    const input = z.object({ token: z.string().trim().min(20).max(4000), url: z.string().trim().url() }).nullable().parse(req.body?.tunnel ?? null);
    try {
      res.json(sharing.configureNamed(input));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return r;
}
