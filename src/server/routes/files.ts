import { Router, type Request } from "express";
import { z } from "zod";
import { deleteWorkspaceFile, listFiles, listImages, searchFiles, readWorkspaceFile, renameWorkspaceFile, writeWorkspaceFile } from "../../workspaces/files";
import type { Container } from "../container";

const wsId = (req: Request) => String((req.params as Record<string, string>).id);
const path = z.string().min(1).max(1000);

/** The Files tab: a workspace's tree, and reading and writing its files. */
export function fileRoutes(c: Container): Router {
  const r = Router({ mergeParams: true });
  const root = async (req: Request) => {
    const ws = c.workspaces.workspaceOrThrow(wsId(req));
    await c.workspaces.ensureOnDisk(ws);
    return ws.path;
  };

  // "/" stays with the workspace routes (file search for @-mentions).
  r.get("/tree", async (req, res) => {
    res.json(await listFiles(await root(req)));
  });

  /** Images the app serves, to use as fills on the canvas. */
  r.get("/images", async (req, res) => {
    res.json(await listImages(await root(req)));
  });

  r.get("/search", async (req, res) => {
    const q = z.object({ q: z.string().max(500), regex: z.string().optional(), word: z.string().optional(), case: z.string().optional() }).parse(req.query);
    res.json(await searchFiles(await root(req), q.q, { regex: q.regex === "1", word: q.word === "1", matchCase: q.case === "1" }));
  });

  r.get("/content", async (req, res) => {
    res.json(readWorkspaceFile(await root(req), path.parse(req.query.path)));
  });

  r.put("/content", async (req, res) => {
    const input = z.object({ path, text: z.string().max(3_000_000), create: z.boolean().default(false) }).parse(req.body);
    res.json(writeWorkspaceFile(await root(req), input.path, input.text, { create: input.create }));
  });

  r.post("/rename", async (req, res) => {
    const input = z.object({ from: path, to: path }).parse(req.body);
    res.json({ path: renameWorkspaceFile(await root(req), input.from, input.to) });
  });

  r.delete("/content", async (req, res) => {
    deleteWorkspaceFile(await root(req), path.parse(req.query.path));
    res.json({ ok: true });
  });

  return r;
}
