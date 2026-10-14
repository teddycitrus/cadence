import { Router } from "express";
import { z } from "zod";
import { CLAUDE_MODELS, isProviderId, providerInfo } from "../../core/providers";
import { claudeAccount } from "../../agents/claude-binary";
import { signInCommand } from "../../agents/sign-in";
import { NotFoundError, ValidationError } from "../../core/errors";
import type { Container } from "../container";

const EnvName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "Use an environment variable name like OPENAI_API_KEY");
const ProviderPatch = z.object({
  command: z.string().trim().max(500).nullable().optional(),
  cliCommand: z.string().trim().max(500).nullable().optional(),
  // A value of null removes that variable.
  env: z.record(EnvName, z.string().max(4000).nullable()).optional(),
  // Keys for one model only, e.g. { "gpt-6-astra": { OPENAI_API_KEY: "..." } }.
  modelEnv: z.record(z.string().regex(/^[\w.:\-[\]/]{1,100}$/), z.record(EnvName, z.string().max(4000).nullable())).optional(),
});

/** Settings > Providers: which harnesses this machine can run, their commands, and keys. */
export function providerRoutes(c: Container): Router {
  const r = Router();
  const idOf = (raw: string) => {
    if (!isProviderId(raw)) throw new NotFoundError(`Unknown provider "${raw}"`);
    return raw;
  };

  r.get("/", (_req, res) => {
    res.json(c.providers.all());
  });

  r.put("/:id", (req, res) => {
    const id = idOf(req.params.id);
    const patch = ProviderPatch.parse(req.body);
    if (patch.command !== undefined && id === "claude-code" && patch.command) throw new ValidationError("Claude Code runs through its SDK; it has no launch command");
    res.json(c.providers.update(id, patch));
  });

  /** Starts the harness and asks for a session, to check it is installed and signed in. */
  r.post("/:id/check", async (req, res) => {
    const id = idOf(req.params.id);
    try {
      const reply = await c.runtimes.get(id).complete("Reply with the single word: ready", { cwd: c.dataDir, model: id === "claude-code" ? CLAUDE_MODELS[0]! : "default", system: "You are being health-checked." });
      res.json({ ok: true, reply: reply.slice(0, 200) });
    } catch (err) {
      res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Opens a terminal running the harness's own sign-in (a Claude or ChatGPT subscription, a Cursor
   * or xAI account), for people who would rather sign in than paste a key.
   */
  r.post("/:id/sign-in", (req, res) => {
    const id = idOf(req.params.id);
    const { cols, rows } = z.object({ cols: z.number().int().optional(), rows: z.number().int().optional() }).parse(req.body ?? {});
    const command = signInCommand(id);
    if (!command) throw new ValidationError(`${providerInfo(id).label} is not installed here. ${providerInfo(id).install}.`);
    res.status(201).json(c.terminals.openProgram(command, { cols, rows }));
  });

  /** Who the harness is signed in as, where it can say (Claude Code). */
  r.get("/:id/account", async (req, res) => {
    const id = idOf(req.params.id);
    res.json({ account: id === "claude-code" ? await claudeAccount() : null });
  });

  return r;
}
