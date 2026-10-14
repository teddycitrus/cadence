import { Router, type Response } from "express";
import { z } from "zod";
import type { Container } from "../container";
import { isInline } from "../../docs/assets";

const UploadInput = z.object({ name: z.string().trim().min(1).max(200), mediaType: z.string().max(200), data: z.string().min(1).max(36_000_000) });

export function assetRoutes(c: Container): Router {
  const r = Router();

  r.post("/", (req, res) => {
    const input = UploadInput.parse(req.body);
    const asset = c.assets.save(input.name, input.mediaType, Buffer.from(input.data, "base64"));
    res.status(201).json({ ...asset, url: `/api/assets/${asset.id}` });
  });

  r.get("/:id", (req, res) => sendAsset(c, res, req.params.id));

  return r;
}

/** Serves an asset with headers that stop it from running as a page. */
export function sendAsset(c: Container, res: Response, id: string): void {
  const { asset, path } = c.assets.pathOf(id);
  const inline = isInline(asset.mediaType);
  // Only known-safe types render in the page; anything else (HTML, SVG...) downloads.
  res.setHeader("Content-Type", inline ? asset.mediaType : "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (asset.mediaType.startsWith("image/")) res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${asset.name.replace(/"/g, "")}"`);
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.sendFile(path);
}
