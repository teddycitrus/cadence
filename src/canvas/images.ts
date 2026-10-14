import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "../core/errors";

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif" };

/**
 * Saves an image for an image fill into the project's static folder (public/,
 * or static/ in SvelteKit) and returns the root-relative URL the app serves it
 * at. The name carries a content hash, so re-uploads dedupe.
 */
export function saveProjectImage(root: string, input: { name: string; mediaType: string; data: string }): { url: string; path: string } {
  const ext = EXTENSIONS[input.mediaType];
  if (!ext) throw new ValidationError("Use a PNG, JPEG, GIF, WebP, SVG, or AVIF image");
  const bytes = Buffer.from(input.data, "base64");
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new ValidationError("Images must be under 10 MB");
  const staticDir = ["public", "static"].find((d) => existsSync(join(root, d))) ?? "public";
  const base = input.name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "image";
  const name = `${base}-${createHash("sha256").update(bytes).digest("hex").slice(0, 8)}.${ext}`;
  mkdirSync(join(root, staticDir, "cadence"), { recursive: true });
  writeFileSync(join(root, staticDir, "cadence", name), bytes);
  return { url: `/cadence/${name}`, path: `${staticDir}/cadence/${name}` };
}
