import { describe, expect, it } from "vitest";
import { minecraftPlainText, parseMinecraftText } from "./minecraftFormatting";

describe("Minecraft legacy text formatting", () => {
  it("recognizes the sixteen Java colors case-insensitively", () => {
    const expected = [
      "#000000",
      "#0000aa",
      "#00aa00",
      "#00aaaa",
      "#aa0000",
      "#aa00aa",
      "#ffaa00",
      "#aaaaaa",
      "#555555",
      "#5555ff",
      "#55ff55",
      "#55ffff",
      "#ff5555",
      "#ff55ff",
      "#ffff55",
      "#ffffff",
    ];
    Array.from("0123456789ABCDEF").forEach((code, index) => {
      expect(parseMinecraftText(`§${code}颜色`)).toEqual([
        expect.objectContaining({ text: "颜色", color: expected[index] }),
      ]);
    });
  });
  it("accumulates bold, italic, underline, strike and obfuscation", () => {
    const runs = parseMinecraftText("§l粗§o斜§n下§m删§k乱");
    expect(runs[0]).toMatchObject({ text: "粗", bold: true, italic: false });
    expect(runs[1]).toMatchObject({ text: "斜", bold: true, italic: true });
    expect(runs[2]).toMatchObject({
      text: "下",
      underline: true,
      italic: true,
    });
    expect(runs[3]).toMatchObject({
      text: "删",
      underline: true,
      strikethrough: true,
    });
    expect(runs[4]).toMatchObject({
      text: "乱",
      bold: true,
      italic: true,
      underline: true,
      strikethrough: true,
      obfuscated: true,
    });
  });
  it("a color code clears all previously accumulated styles", () => {
    expect(parseMinecraftText("§k§l§m§n§o前§c后")[1]).toEqual({
      text: "后",
      color: "#ff5555",
      bold: false,
      italic: false,
      underline: false,
      strikethrough: false,
      obfuscated: false,
    });
  });
  it("reset restores the surrounding title's default appearance", () => {
    expect(parseMinecraftText("§a§l绿§r普通")[1]).toEqual({
      text: "普通",
      bold: false,
      italic: false,
      underline: false,
      strikethrough: false,
      obfuscated: false,
    });
  });
  it("consumes unknown pairs and a trailing section sign as Minecraft does", () => {
    expect(minecraftPlainText("前§z后§")).toBe("前后");
    expect(parseMinecraftText("§l前§z后")).toEqual([
      expect.objectContaining({ text: "前后", bold: true }),
    ]);
    expect(minecraftPlainText("§§a")).toBe("a");
  });
  it("preserves Unicode, whitespace and literal HTML while removing only codes", () => {
    const title = "§b世界 🌍\n <img src=x> §r末尾";
    expect(minecraftPlainText(title)).toBe("世界 🌍\n <img src=x> 末尾");
    expect(parseMinecraftText("§a§l§r")).toEqual([]);
  });
});
