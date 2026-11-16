import { describe, expect, it, vi } from "vitest";
import { createImageCache } from "./images";
import { mutationImagePaths } from "./imageInvalidation";
import type { Bootstrap } from "./types";

describe("image cache", () => {
  it("shares pending reads and invalidates only the selected path", async () => {
    const cache = createImageCache();
    const fetch = vi.fn(async () => "skin");
    const skin = vi.fn(),
      background = vi.fn();
    cache.subscribe("C:/skin.png", skin);
    cache.subscribe("C:/background.png", background);
    const first = cache.load("C:/skin.png", fetch);
    expect(cache.load("c:\\SKIN.png", fetch)).toBe(first);
    await first;
    await cache.load("C:/background.png", async () => "background");
    cache.invalidate(["c:\\SKIN.png"]);
    expect(skin).toHaveBeenCalledTimes(1);
    expect(background).not.toHaveBeenCalled();
    expect(await cache.load("C:/background.png", fetch)).toBe("background");
    await cache.load("C:/skin.png", fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not restore stale content when an invalidated request finishes late", async () => {
    const cache = createImageCache();
    let finish!: (value: string) => void;
    const old = cache.load(
      "skin",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    cache.invalidate(["skin"]);
    await cache.load("skin", async () => "new");
    finish("old");
    await old;
    expect(await cache.load("skin", async () => "unexpected")).toBe("new");
  });

  it("shares UNC paths across separators and case", async () => {
    const cache = createImageCache();
    await cache.load("\\\\server\\share\\Skin.png", async () => "old");
    expect(
      await cache.load("//SERVER/share/skin.png", async () => "unexpected"),
    ).toBe("old");
    cache.invalidate(["//SERVER/share/skin.png"]);
    expect(
      await cache.load("\\\\server\\share\\Skin.png", async () => "new"),
    ).toBe("new");
  });

  it("evicts the least recently used entry without flushing every image", async () => {
    const cache = createImageCache(2);
    await cache.load("a", async () => "a");
    await cache.load("b", async () => "b");
    await cache.load("a", async () => "unexpected");
    await cache.load("c", async () => "c");
    expect(await cache.load("a", async () => "unexpected")).toBe("a");
    expect(await cache.load("c", async () => "unexpected")).toBe("c");
    expect(await cache.load("b", async () => "reloaded")).toBe("reloaded");
  });

  it("bounds cached bytes and allows a failed request to be retried", async () => {
    const cache = createImageCache(100, 8);
    await cache.load("a", async () => "aaa");
    await cache.load("b", async () => "bbb");
    expect(await cache.load("a", async () => "new")).toBe("new");
    await expect(
      cache.load("bad", async () => {
        throw Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(await cache.load("bad", async () => "ok")).toBe("ok");
  });
});

it("maps only image-changing mutations to their affected resources", () => {
  const data = {
    settings: { activeDir: "C:/Games" },
    players: [
      { uuid: "one", skin: "one.png", cape: "cape.png" },
      { uuid: "two", skin: "two.png", cape: "" },
    ],
  } as Bootstrap;
  expect(
    mutationImagePaths(
      "players.skin",
      { id: "one" },
      { skin: "new.png" },
      data,
    ),
  ).toEqual(["one.png", "cape.png", "new.png"]);
  expect(
    mutationImagePaths(
      "versions.icon",
      { id: "Game", directory: "D:\\Game\\.minecraft" },
      true,
      data,
    ),
  ).toEqual(["D:\\Game\\.minecraft/versions/Game/icon.png"]);
  for (const operation of [
    "players.select",
    "settings.save",
    "versions.favorite",
    "versions.select",
  ])
    expect(mutationImagePaths(operation, {}, {}, data)).toEqual([]);
});
