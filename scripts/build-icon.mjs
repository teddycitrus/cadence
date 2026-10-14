// Renders src/desktop/icon.svg into the files electron-builder and the window
// use: icon.png (1024 px, macOS and Linux) and icon.ico (16 to 256 px, Windows).
// Run with `node scripts/build-icon.mjs` after changing the SVG.
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../src/desktop/", import.meta.url);
const svg = readFileSync(new URL("icon.svg", root));
const image = await loadImage(svg);

function png(size) {
  const canvas = createCanvas(size, size);
  canvas.getContext("2d").drawImage(image, 0, 0, size, size);
  return canvas.toBuffer("image/png");
}

writeFileSync(new URL("icon.png", root), png(1024));

// An .ico is a directory of images; modern Windows reads PNGs stored in it directly.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map(png);
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => {
  const at = 6 + 16 * i;
  header.writeUInt8(size === 256 ? 0 : size, at);
  header.writeUInt8(size === 256 ? 0 : size, at + 1);
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(images[i].length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += images[i].length;
});
writeFileSync(new URL("icon.ico", root), Buffer.concat([header, ...images]));
console.log("icon: src/desktop/icon.{png,ico}");
