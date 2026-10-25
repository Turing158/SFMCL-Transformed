import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { launchDockFixture } from "./fixtures/launch-dock.mjs";
import { favoriteContextFixture } from "./fixtures/favorite-context-menu.mjs";
import { runtimePath } from "./lib/paths.mjs";

const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/";
const evidence = runtimePath("evidence/favorite-context-menu");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
});
const page = await browser.newPage({ viewport: { width: 1024, height: 720 } });
page.setDefaultTimeout(7000);
const errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript({
  content: `(${pixelAppFixture.toString()})();(${launchDockFixture.toString()})();(${favoriteContextFixture.toString()})();`,
});
const first = "C:/Pixel-Test/Minecraft",
  second = "D:/Other-Minecraft";
const favorite = (id, directory = first) =>
  page
    .locator(`.sidebar-favorite[data-directory="${directory}"]`)
    .filter({ hasText: id });
const root = page.locator(".pixel-context-menu:not(.pixel-context-submenu)");
const child = page.locator(".pixel-context-submenu");
const ready = async () => {
  await page.goto(url);
  await expect(page.locator("html")).not.toHaveAttribute("data-startup");
  await expect(page.locator(".sidebar-favorite")).toHaveCount(3);
};
const requests = (operation) =>
  page.evaluate(
    (operation) =>
      window.__pixelTest.requests.filter(
        (entry) => entry.operation === operation,
      ),
    operation,
  );
const open = async (id = "1.21.4", directory = first) => {
  await favorite(id, directory).click({ button: "right" });
  await expect(root).toBeVisible();
};
const management = page.getByRole("dialog", {
  name: "管理 1.21.4",
  exact: true,
});
const more = async () => {
  const item = root.getByRole("menuitem", { name: "更多", exact: true });
  await expect(item).toHaveAttribute("aria-haspopup", "dialog");
  await item.hover();
  await expect(child).toHaveCount(0);
  await item.click();
  await expect(management).toBeVisible();
  await expect(root).toHaveCount(0);
};
const manageAction = async (name) => {
  await more();
  await management.getByRole("button", { name, exact: true }).click();
};
try {
  await ready();
  await open();
  expect(await root.getByRole("menuitem").allTextContents()).toEqual([
    "启动版本",
    "切换版本",
    "查看资源",
    "版本设置",
    "取消收藏",
    "更多",
  ]);
  expect(await requests("versions.select")).toHaveLength(0);
  expect(await requests("launch")).toHaveLength(0);
  await root.getByRole("menuitem", { name: "切换版本", exact: true }).click();
  expect(await requests("launch")).toHaveLength(0);
  await open("1.20.1-Fabric");
  await root.getByRole("menuitem", { name: "切换版本", exact: true }).click();
  await expect(favorite("1.20.1-Fabric")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await requests("launch")).toHaveLength(0);
  checks.push(
    "Six items in order; right click has no selection side effects; switch never launches",
  );

  await ready();
  await open("1.21.4", second);
  await root.getByRole("menuitem", { name: "启动版本", exact: true }).click();
  await expect.poll(async () => (await requests("launch")).length).toBe(1);
  expect((await requests("launch"))[0].payload).toEqual({
    id: "1.21.4",
    directory: second,
  });
  expect((await requests("versions.select"))[0].payload).toEqual({
    id: "1.21.4",
    directory: second,
  });
  checks.push("Launch selects and launches the correct same-name version once");

  for (const [label, operation] of [
    ["查看资源", "resources.local"],
    ["版本设置", "versions.settings.get"],
  ]) {
    await ready();
    await open("1.21.4", second);
    await root.getByRole("menuitem", { name: label, exact: true }).click();
    await expect
      .poll(async () => (await requests(operation)).length)
      .toBeGreaterThan(0);
    expect((await requests(operation)).at(-1).payload.directory).toBe(second);
    expect(
      await page.evaluate(() => window.__pixelTest.data.settings.activeDir),
    ).toBe(first);
    expect(await requests("versions.select")).toHaveLength(0);
  }
  await ready();
  await open("1.21.4", second);
  await root.getByRole("menuitem", { name: "取消收藏", exact: true }).click();
  await expect(favorite("1.21.4", second)).toHaveCount(0);
  await expect(favorite("1.21.4", first)).toHaveCount(1);
  expect((await requests("versions.favorite"))[0].payload).toEqual({
    id: "1.21.4",
    directory: second,
    favorite: false,
  });
  checks.push(
    "Resources, settings and unfavorite target their directory without changing selection",
  );

  for (const [label, suffix] of [
    ["打开版本目录", ""],
    ["打开 native 目录", "/natives"],
  ]) {
    await ready();
    await open("1.21.4", second);
    await manageAction(label);
    await expect.poll(async () => (await requests("path.open")).length).toBe(1);
    expect((await requests("path.open"))[0].payload.path).toBe(
      `${second}/.minecraft/versions/1.21.4${suffix}`,
    );
  }
  await ready();
  await open("1.21.4", second);
  await more();
  const dialog = page.getByRole("dialog", { name: "管理 1.21.4", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox").fill("renamed-world");
  await dialog.getByRole("button", { name: "重命名", exact: true }).click();
  await expect(favorite("renamed-world", second)).toHaveCount(1);
  await expect(favorite("1.21.4", first)).toHaveCount(1);
  expect((await requests("versions.rename"))[0].payload).toEqual({
    id: "1.21.4",
    directory: second,
    name: "renamed-world",
  });
  for (const label of ["更换图标", "恢复默认图标", "补全资源文件"]) {
    await ready();
    await open("1.21.4", second);
    await manageAction(label);
    const operation =
      label === "补全资源文件" ? "versions.repair" : "versions.icon";
    await expect.poll(async () => (await requests(operation)).length).toBe(1);
    expect((await requests(operation))[0].payload.directory).toBe(second);
  }
  checks.push(
    "Shared management actions: rename, folders, custom/default icon and repair",
  );

  await ready();
  await open("1.21.4", second);
  await manageAction("删除版本");
  const confirm = page.getByRole("dialog", { name: "确认操作", exact: true });
  await expect(confirm).toBeVisible();
  expect(await requests("versions.delete")).toHaveLength(0);
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirm).not.toBeVisible();
  expect(await requests("versions.delete")).toHaveLength(0);
  await management
    .getByRole("button", { name: "删除版本", exact: true })
    .click();
  await confirm.getByRole("button", { name: "确认", exact: true }).click();
  await expect(favorite("1.21.4", second)).toHaveCount(0);
  await expect(favorite("1.21.4", first)).toHaveCount(1);
  checks.push(
    "Delete confirmation can cancel; confirmation deletes only the selected directory",
  );

  await ready();
  await favorite("1.21.4").focus();
  await page.keyboard.press("Shift+F10");
  await expect(root).toBeVisible();
  await expect(
    root.getByRole("menuitem", { name: "启动版本", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    root.getByRole("menuitem", { name: "更多", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(child).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(management).toBeVisible();
  await expect(root).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(management).not.toBeVisible();
  await favorite("1.21.4").focus();
  await page.keyboard.press("Shift+F10");
  await page.keyboard.press("Escape");
  await expect(root).toHaveCount(0);
  await expect(favorite("1.21.4")).toBeFocused();
  for (const theme of ["light", "dark"])
    for (const accent of ["forest", "puce", "ebony"]) {
      await page.evaluate(
        ({ theme, accent }) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.accent = accent;
        },
        { theme, accent },
      );
      await open();
      await page.screenshot({ path: `${evidence}/${theme}-${accent}.png` });
      await page.keyboard.press("Escape");
      await expect(root).toHaveCount(0);
    }
  for (const width of [375, 650, 864]) {
    await page.setViewportSize({ width, height: 591 });
    await open();
    await expect(root.locator(".pixel-context-heading")).toHaveCount(0);
    const box = await root.boundingBox();
    expect(box.width).toBeLessThanOrEqual(128);
    expect(box.x).toBeGreaterThanOrEqual(11);
    expect(box.x + box.width).toBeLessThanOrEqual(width - 11);
    expect(box.y + box.height).toBeLessThanOrEqual(580);
    await more();
    await expect(child).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(management).not.toBeVisible();
    await open();
    await page.keyboard.press("Escape");
    if (await root.count()) await page.keyboard.press("Escape");
    await expect(root).toHaveCount(0);
  }
  checks.push(
    "Compact menu has no heading or submenu; More opens the dialog; keyboard, six themes and viewport bounds",
  );
  expect(errors).toEqual([]);
  console.log(
    `PASS ${checks.length} favorite context menu behavior groups; no page errors.`,
  );
} catch (error) {
  process.exitCode = 1;
  console.error(error);
  await page.screenshot({ path: `${evidence}/failure.png` }).catch(() => {});
} finally {
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  await browser.close();
}
