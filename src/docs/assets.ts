import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NotFoundError, ValidationError } from "../core/errors";
import type { EventStore } from "../core/event-store";
import type { Queries } from "../core/queries";
import type { Actor, Asset } from "../core/types";
import { currentActor } from "../auth/context";

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

/** Types the browser may render in place. Everything else is served as a download. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "video/webm", "video/mp4"]);

export function isInline(mediaType: string): boolean {
  return INLINE_TYPES.has(mediaType);
}

/** Uploaded files (pasted images, imported PDFs, docx images), stored under the data dir. */
export class AssetStore {
  constructor(
    private store: EventStore,
    private q: Queries,
    private dataDir: string,
  ) {}

  save(name: string, mediaType: string, data: Buffer, actor: Actor = currentActor()): Asset {
    if (data.length === 0) throw new ValidationError("The file is empty");
    if (data.length > MAX_ASSET_BYTES) throw new ValidationError(`${name} is larger than 25 MB`);
    const id = randomUUID();
    const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "file";
    const dir = join(this.dataDir, "assets");
    mkdirSync(dir, { recursive: true });
    const file = `${id}-${safe}`;
    writeFileSync(join(dir, file), data);
    this.store.append({ aggregate: "asset", type: "AssetAdded", aggregateId: id, payload: { name, mediaType, size: data.length, file } }, actor);
    return this.q.asset(id)!;
  }

  pathOf(id: string): { asset: Asset; path: string } {
    const asset = this.q.asset(id);
    if (!asset) throw new NotFoundError("File not found");
    return { asset, path: join(this.dataDir, "assets", asset.file) };
  }
}

export const assetUrl = (id: string) => `/api/assets/${id}`;
