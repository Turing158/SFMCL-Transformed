import { describe, expect, it } from "vitest";
import {
  gameDirectoryName,
  gameDirectoryPath,
  minecraftDirectoryPath,
} from "./gameDirectories";

describe("游戏目录的显示路径和数据路径", () => {
  it.each([
    [
      "E:\\Game\\Minecraft\\test",
      "E:\\Game\\Minecraft\\test",
      "E:\\Game\\Minecraft\\test\\.minecraft",
    ],
    [
      "E:\\Game\\Minecraft\\test\\.minecraft\\",
      "E:\\Game\\Minecraft\\test",
      "E:\\Game\\Minecraft\\test\\.minecraft",
    ],
    [
      "C:/Users/Alice/AppData/Roaming/.minecraft",
      "C:/Users/Alice/AppData/Roaming",
      "C:/Users/Alice/AppData/Roaming/.minecraft",
    ],
    ["D:\\.minecraft", "D:\\", "D:\\.minecraft"],
    ["D:\\", "D:\\", "D:\\.minecraft"],
    [
      "\\\\server\\share\\我的游戏\\.minecraft",
      "\\\\server\\share\\我的游戏",
      "\\\\server\\share\\我的游戏\\.minecraft",
    ],
    [
      "/home/alice/My Games/",
      "/home/alice/My Games",
      "/home/alice/My Games/.minecraft",
    ],
    ["/", "/", "/.minecraft"],
    [
      "/games/.minecraft-backup",
      "/games/.minecraft-backup",
      "/games/.minecraft-backup/.minecraft",
    ],
    ["", "", ""],
  ])("%s 显示外层目录并定位数据目录", (input, display, root) => {
    expect(gameDirectoryPath(input)).toBe(display);
    expect(minecraftDirectoryPath(input)).toBe(root);
    expect(minecraftDirectoryPath(root)).toBe(root);
    expect(minecraftDirectoryPath(display)).toBe(root);
  });

  it("替换旧记录的文件夹名，保留用户命名", () => {
    const path = "E:\\Games\\test\\.minecraft";
    expect(gameDirectoryName({ name: ".minecraft", path })).toBe("test");
    expect(gameDirectoryName({ name: "默认游戏目录", path })).toBe(
      "默认游戏目录",
    );
  });
});
