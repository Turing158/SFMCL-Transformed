import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";
import { answerConfirmation } from "./lib/confirmation.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("evidence/local-resource-directories");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(8000);
const errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(resourceCenterFixture);
await page.addInitScript(() => {
  const state = window.__pixelTest;
  window.__directoryTest = { requests: [], pending: [], finished: 0 };
  const test = window.__directoryTest;
  const items = state.resources.localItems["1.20.1-Fabric"];
  const make = (kind, name, entryType, extra = {}) => ({
    ...items[kind][0],
    name,
    entryType,
    description: "",
    authors: "",
    version: "",
    path: items[kind][0].path.replace("test.zip", name),
    size: entryType === "file" ? 2048 : null,
    details: {},
    ...extra,
  });
  items.resourcepack = [
    make("resourcepack", "Textures.v2", "resourceDirectory", {
      description: "正常材质包",
    }),
    make("resourcepack", "Notes.v1", "directory"),
    make("resourcepack", "Broken.v3", "resourceDirectory", {
      error: "pack.mcmeta 无法解析",
    }),
  ];
  items.shader = [
    make("shader", "Complementary.v5", "resourceDirectory"),
    make("shader", "Shader notes.v1", "directory"),
    make(
      "shader",
      "Long_shader_directory_超长光影名称与版本_Unbound_r5.6.1",
      "resourceDirectory",
    ),
  ];
  items.world = [
    make("world", "Damaged.v1", "resourceDirectory", {
      error: "存档信息读取失败",
    }),
    make("world", "Healthy.v1", "resourceDirectory", {
      details: { seed: "123", gameMode: 0, difficulty: 2 },
    }),
    make("world", "Unreadable.v1", "resourceDirectory"),
  ];
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (args?.operation === "resources.localSize") {
      test.requests.push(structuredClone(args.payload));
      if (!test.automatic)
        await new Promise((resolve) => test.pending.push(resolve));
      test.finished++;
      if (args.payload.path.endsWith("Broken.v3"))
        throw new Error("size unavailable");
      return test.automatic ? 8192 : 4096;
    }
    return invoke(command, args);
  };
});
const tab = (name) =>
  page.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
const rows = page.locator(".local-resources .resource-list .resource-row");
const row = (name) =>
  rows.filter({ has: page.getByRole("heading", { name, exact: true }) });
const lastOpen = () =>
  page.evaluate(
    () =>
      window.__pixelTest.requests
        .filter((r) => r.operation === "path.open")
        .at(-1)?.payload,
  );
const back = () =>
  page
    .getByRole("navigation", { name: "页面路径" })
    .getByRole("button", { name: "返回上一级", exact: true })
    .first()
    .click();
try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "版本管理", exact: true })
    .click();
  await page
    .getByRole("button", { name: "查看 1.20.1-Fabric 本地资源", exact: true })
    .click();
  await tab("材质包");
  await expect(rows).toHaveCount(3);
  await expect(row("Textures.v2").locator(".local-resource-size")).toHaveText(
    "计算中…",
  );
  await expect(row("Notes.v1").getByRole("button")).toHaveCount(1);
  await expect(
    row("Notes.v1").locator(".local-resource-size, .local-resource-error"),
  ).toHaveCount(0);
  await expect(row("Notes.v1")).toContainText("普通文件夹");
  await row("Notes.v1").getByRole("button").click();
  expect(await lastOpen()).toEqual({
    path: "C:/Pixel-Test/Minecraft/.minecraft/versions/1.20.1-Fabric/resourcepacks/Notes.v1",
  });
  await row("Textures.v2").getByRole("button", { name: /^打开/ }).click();
  expect(await lastOpen()).toEqual({
    path: "C:/Pixel-Test/Minecraft/.minecraft/versions/1.20.1-Fabric/resourcepacks/Textures.v2",
  });
  await row("Textures.v2")
    .getByRole("button", { name: "删除 Textures.v2", exact: true })
    .click();
  await expect(page.getByRole("dialog", { name: "确认操作" })).toContainText(
    "将删除该文件夹及其全部内容",
  );
  await answerConfirmation(page, false);
  await expect(rows).toHaveCount(3);
  expect(
    await page.evaluate(() => window.__directoryTest.requests.length),
  ).toBe(2);
  checks.push(
    "Lists render before directory sizes complete; ordinary directories only open themselves, and deleting a pack directory explains that its contents are included.",
  );

  // Release one worker so its result is shown before all other scans finish.
  await page.evaluate(() => window.__directoryTest.pending.shift()());
  await expect(row("Textures.v2").locator(".local-resource-size")).toHaveText(
    "4.0 KB",
  );
  await expect(row("Broken.v3").locator(".local-resource-size")).toHaveText(
    "计算中…",
  );
  // Refresh while old size work is pending. Its later results must not overwrite this scan.
  await page.evaluate(() => {
    window.__directoryTest.automatic = true;
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(row("Textures.v2").locator(".local-resource-size")).toHaveText(
    "8.0 KB",
  );
  await expect(row("Broken.v3").locator(".local-resource-size")).toHaveText(
    "大小未知",
  );
  await expect(row("Broken.v3").locator(".local-resource-error")).toHaveText(
    "pack.mcmeta 无法解析",
  );
  await page.evaluate(() => {
    window.__directoryTest.pending.splice(0).forEach((resolve) => resolve());
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__directoryTest.finished ===
          window.__directoryTest.requests.length,
      ),
    )
    .toBe(true);
  await expect(row("Textures.v2").locator(".local-resource-size")).toHaveText(
    "8.0 KB",
  );
  expect(
    await page.evaluate(() =>
      window.__directoryTest.requests.some((r) => /Notes|notes/.test(r.path)),
    ),
  ).toBe(false);
  checks.push(
    "Size work is limited to two concurrent requests, ordinary folders are never queued, failed sizes remain unknown, and stale refresh results are discarded.",
  );

  for (const label of ["材质包", "光影", "存档"]) {
    await tab(label);
    if (label === "光影") {
      await expect(row("Complementary.v5")).toContainText("文件夹");
      await expect(row("Shader notes.v1")).toContainText("普通文件夹");
      await expect(row("Shader notes.v1").getByRole("button")).toHaveCount(1);
      await row("Complementary.v5").getByRole("button").click();
      expect(await lastOpen()).toEqual({
        path: "C:/Pixel-Test/Minecraft/.minecraft/versions/1.20.1-Fabric/shaderpacks/Complementary.v5",
      });
    }
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      for (const width of [1440, 768, 375]) {
        await page.setViewportSize({ width, height: 960 });
        await expect
          .poll(() =>
            rows.evaluateAll((elements) =>
              elements.every((e) => e.scrollWidth <= e.clientWidth + 1),
            ),
          )
          .toBe(true);
        await expect
          .poll(() =>
            page
              .locator("main.page")
              .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
          )
          .toBe(true);
        await page.screenshot({
          path: `${evidence}/${label}-${theme}-${width}.png`,
        });
      }
    }
  }
  await expect(row("Damaged.v1").locator(".local-resource-error")).toHaveText(
    "存档信息读取失败",
  );
  await row("Damaged.v1")
    .getByRole("button", { name: "Damaged.v1 详情", exact: true })
    .click();
  const detail = page.locator(".local-resource-page");
  await expect(detail.getByRole("alert")).toHaveText("存档信息读取失败");
  await expect(
    detail.locator(".world-details, .seed-row, .gamerules"),
  ).toHaveCount(0);
  await detail
    .getByRole("button", { name: "打开所在目录", exact: true })
    .click();
  expect(await lastOpen()).toEqual({
    path: "C:/Pixel-Test/Minecraft/.minecraft/versions/1.20.1-Fabric/saves/Damaged.v1",
  });
  await back();
  await row("Unreadable.v1")
    .getByRole("button", { name: "Unreadable.v1 详情", exact: true })
    .click();
  await expect(detail.getByRole("alert")).toHaveCount(0);
  await expect(
    detail.locator(".world-details, .seed-row, .gamerules"),
  ).toHaveCount(0);
  await back();
  await row("Healthy.v1")
    .getByRole("button", { name: "Healthy.v1 详情", exact: true })
    .click();
  await expect(detail.getByRole("alert")).toHaveCount(0);
  await expect(detail.locator(".seed-row")).toContainText("123");
  checks.push(
    "Pack, shader and world directories fit both themes at 375/768/1440px; only corrupt level.dat shows the world error, with no invented settings for unavailable data.",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` });
  throw error;
} finally {
  await browser.close();
}
