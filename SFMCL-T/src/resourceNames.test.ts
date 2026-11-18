import { describe, expect, it } from "vitest";
import { localResourceSearchText, resourceName } from "./resourceNames";
import type { LocalResource } from "./types";

describe("resource names", () => {
  it("displays Chinese mod and modpack names while retaining the original", () => {
    expect(resourceName("Create", { name: "机械动力", aliases: [] })).toBe(
      "机械动力（Create）",
    );
    expect(
      resourceName("GT: New Horizons", {
        name: "格雷科技：新视野",
        aliases: [],
      }),
    ).toBe("格雷科技：新视野（GT: New Horizons）");
    expect(resourceName("天空工厂4", { name: "天空工厂4", aliases: [] })).toBe(
      "天空工厂4",
    );
  });
  it("keeps unknown and untranslated names and handles empty originals", () => {
    expect(resourceName("Unknown Pack")).toBe("Unknown Pack");
    expect(
      resourceName("Life In The Village", {
        name: "Life in the village",
        aliases: [],
      }),
    ).toBe("Life In The Village");
    expect(resourceName("", { name: "钠", aliases: [] })).toBe("钠");
  });
  it("searches Chinese names, original names and abbreviations", () => {
    const item = {
      name: "Just Enough Items",
      localizedName: {
        name: "JEI物品管理器",
        aliases: ["Just Enough Items", "JEI"],
      },
      authors: "Author",
      description: "Original description",
    } as LocalResource;
    const text = localResourceSearchText(item);
    expect(text).toContain("物品管理器");
    expect(text).toContain("just enough items");
    expect(text).toContain("jei");
    expect(item.name).toBe("Just Enough Items");
  });
});
