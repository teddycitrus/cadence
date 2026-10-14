import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detachComponent, storyComponents } from "../src/canvas/detach";
import { removeTempDir } from "./helpers/temp-dir";

const CANVAS = `import { Cart } from "../components/Cart";
import Header from "../components/Header";
import { useState } from "react";

export default { name: "Checkout" };

export const Empty = {
  name: "Empty cart",
  render: () => (
    <div>
      <Header />
      <Cart items={[]}>
        <span>none</span>
      </Cart>
    </div>
  ),
};

export const Full = { name: "Full", render: () => <Cart items={[1, 2]} /> };
`;

describe("detaching components", () => {
  let root: string;
  afterEach(() => removeTempDir(root));

  const setup = () => {
    root = mkdtempSync(join(tmpdir(), "cadence-detach-"));
    mkdirSync(join(root, "src/components"), { recursive: true });
    mkdirSync(join(root, "src/canvases"), { recursive: true });
    writeFileSync(join(root, "src/components/Cart.tsx"), `import { Item } from "./Item";\nexport function Cart(props: { items: number[] }) { return <ul>{props.items.map((i) => <Item key={i} />)}</ul>; }\n`);
    writeFileSync(join(root, "src/components/Header.tsx"), `export default function Header() { return <header>Shop</header>; }\n`);
    writeFileSync(join(root, "src/canvases/checkout.canvas.tsx"), CANVAS);
  };

  it("lists the project components a frame renders (not library ones)", () => {
    setup();
    expect(storyComponents(CANVAS, "Empty")).toEqual([
      { name: "Header", source: "../components/Header", imported: "default" },
      { name: "Cart", source: "../components/Cart", imported: "Cart" },
    ]);
    expect(storyComponents(CANVAS, "Missing")).toEqual([]);
  });

  it("copies the component beside the original and points only that frame at it", () => {
    setup();
    const r = detachComponent(root, "src/canvases/checkout.canvas.tsx", CANVAS, "Empty", "Cart");
    expect(r.copy).toBe("src/components/Cart.Empty.tsx");
    expect(r.name).toBe("CartEmpty");
    expect(readFileSync(join(root, r.copy), "utf8")).toBe(readFileSync(join(root, "src/components/Cart.tsx"), "utf8"));
    expect(r.source).toContain(`import { useState } from "react";\nimport { Cart as CartEmpty } from "../components/Cart.Empty";`);
    expect(r.source).toContain("<CartEmpty items={[]}>");
    expect(r.source).toContain("</CartEmpty>");
    // The other frame still renders the original.
    expect(r.source).toContain(`export const Full = { name: "Full", render: () => <Cart items={[1, 2]} /> };`);

    const header = detachComponent(root, "src/canvases/checkout.canvas.tsx", r.source, "Empty", "Header");
    expect(header.source).toContain(`import HeaderEmpty from "../components/Header.Empty";`);
    expect(header.source).toContain("<HeaderEmpty />");
    // Detaching the same one again takes a new name, never overwriting a copy.
    writeFileSync(join(root, "src/canvases/checkout.canvas.tsx"), CANVAS);
    const again = detachComponent(root, "src/canvases/checkout.canvas.tsx", CANVAS, "Empty", "Cart");
    expect(again.copy).toBe("src/components/Cart.Empty2.tsx");
    expect(existsSync(join(root, "src/components/Cart.Empty.tsx"))).toBe(true);
    expect(() => detachComponent(root, "src/canvases/checkout.canvas.tsx", CANVAS, "Empty", "Nope")).toThrow(/not a project component/);
  });
});
