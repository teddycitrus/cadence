import { Router } from "express";
import { z } from "zod";
import type { Container } from "../container";

const TerminalOpen = z.object({
  workspaceId: z.string().min(1).max(100),
  cols: z.number().int().optional(),
  rows: z.number().int().optional(),
  command: z.string().max(2000).nullish(),
  title: z.string().max(80).optional(),
});
const TerminalPatch = z.object({ title: z.string().trim().min(1).max(80) });

/** Terminal lifecycle; the byte stream itself goes over the WebSocket. */
export function terminalRoutes(c: Container): Router {
  const r = Router();

  r.get("/", (req, res) => {
    res.json(c.terminals.list(typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined));
  });

  r.post("/", async (req, res) => {
    const input = TerminalOpen.parse(req.body);
    res.status(201).json(await c.terminals.open(input.workspaceId, input));
  });

  r.patch("/:id", (req, res) => {
    res.json(c.terminals.rename(req.params.id, TerminalPatch.parse(req.body).title));
  });

  r.delete("/:id", (req, res) => {
    c.terminals.close(req.params.id);
    res.json({ ok: true });
  });

  return r;
}
