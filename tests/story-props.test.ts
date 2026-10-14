import { describe, expect, it } from "vitest";
import { setStoryProp, storyProps } from "../src/canvas/story-props";

const CANVAS = `import { Cart } from "./Cart";
export default { name: "Shop" };
export const Full = { name: "Full", render: () => <Cart title="Your cart" count={3} compact discount={-5} items={[]} onPay={() => {}} />, frame: { x: 0, y: 0, width: 390, height: 844 } };
export const Block = { name: "Block", render() { return (<Cart title={\`Hi\`} />); } };
export const Card = { name: "Card", svelte: "src/lib/Card.svelte", props: { title: "Hi", big: false, size: 2, tags: ["a"] } };
`;

describe("frame props", () => {
  it("reads literal props from render JSX and svelte props objects", () => {
    const pick = (id: string) => storyProps(CANVAS, id).map((p) => [p.name, p.value]);
    expect(pick("Full")).toEqual([
      ["title", "Your cart"],
      ["count", 3],
      ["compact", true],
      ["discount", -5],
    ]);
    expect(pick("Block")).toEqual([["title", "Hi"]]);
    expect(pick("Card")).toEqual([
      ["title", "Hi"],
      ["big", false],
      ["size", 2],
    ]);
    expect(storyProps(CANVAS, "Missing")).toEqual([]);
  });

  it("writes values back in the same form, keeping types", () => {
    let src = setStoryProp(CANVAS, "Full", "title", "Saved items")!;
    expect(src).toContain(`<Cart title="Saved items" count={3}`);
    src = setStoryProp(src, "Full", "title", 'Say "hi" & <go>')!;
    expect(src).toContain(`title={"Say \\"hi\\" & <go>"}`);
    expect(storyProps(src, "Full")[0]!.value).toBe('Say "hi" & <go>');
    src = setStoryProp(src, "Full", "count", 12)!;
    expect(src).toContain("count={12}");
    src = setStoryProp(src, "Full", "compact", false)!;
    expect(src).toContain("compact={false}");
    src = setStoryProp(src, "Card", "big", true)!;
    expect(src).toContain(`props: { title: "Hi", big: true, size: 2`);
    expect(setStoryProp(src, "Card", "size", "2")).toBeNull();
    expect(setStoryProp(src, "Full", "items", 1)).toBeNull();
    expect(setStoryProp(src, "Full", "count", Number.NaN)).toBeNull();
  });
});
