import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { runtimePath } from "./lib/paths.mjs";

// All persistence goes to the test browser's sessionStorage, never real settings.
const evidence = runtimePath("evidence/java-list");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(8000);
await page.addInitScript(pixelAppFixture, { persistJavaLists: true });
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
const j21 = "C:/Java/jdk-21/bin/javaw.exe";
const j17 =
  "C:/Very Long Java Installation Directory/Custom Minecraft Runtime/jdk-17/bin/javaw.exe";
const j8 = "C:/Java/jdk-8/bin/java.exe";
const manual = "C:/Manual/jdk-17/bin/javaw.exe";
const nav = (name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const trigger = () =>
  page.getByRole("combobox", { name: "Java 运行环境", exact: true });
const grid = () =>
  page.getByRole("grid", { name: "Java 运行环境", exact: true });
const choice = (path) =>
  grid().locator(".pixel-select-option").filter({ hasText: path });
const remove = (path) =>
  grid().getByRole("button", { name: `从列表删除 ${path}`, exact: true });
const saved = () => page.evaluate(() => window.__pixelTest.data.settings);
const save = () =>
  page.getByRole("button", { name: "保存设置", exact: true }).first();
const title = () =>
  page.getByRole("textbox", { name: "窗口标题", exact: true });
const scope = (name) =>
  page.getByRole("switch", { name: `${name}：独立设置`, exact: true });
const openGlobal = async () => {
  await nav("设置");
  await page.getByRole("tab", { name: "全局设置", exact: true }).click();
  await expect(trigger()).toBeVisible();
};
const openMenu = async () => {
  if ((await trigger().getAttribute("aria-expanded")) !== "true")
    await trigger().click();
  await expect(grid()).toBeVisible();
};
const closeMenu = async () => {
  await trigger().focus();
  await page.keyboard.press("Escape");
  await expect(grid()).toHaveCount(0);
};
const scan = async () => {
  await page.getByRole("button", { name: "扫描", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "扫描", exact: true }),
  ).toBeEnabled();
};
const commit = async () => {
  await save().click();
  await expect(save()).toHaveCount(0);
};
const openVersion = async (id) => {
  await nav("版本管理");
  await page
    .getByRole("button", { name: `游戏设置 ${id}`, exact: true })
    .click();
  await expect(scope("Java 运行环境")).toBeVisible();
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await openGlobal();
  await title().fill("Unsaved global title");
  await scan();
  await expect
    .poll(async () => (await saved()).javaPaths)
    .toEqual([j21, j17, j8]);
  await expect(title()).toHaveValue("Unsaved global title");
  expect((await saved()).windowTitle).toBe("");
  expect(
    await page.evaluate(() =>
      window.__pixelTest.requests.filter(
        (r) => r.operation === "settings.save",
      ),
    ),
  ).toHaveLength(0);
  await expect(save()).toBeEnabled();
  await page.getByRole("button", { name: "撤销修改", exact: true }).click();
  await nav("开始游戏");
  await openGlobal();
  await openMenu();
  await expect(grid().getByRole("row")).toHaveCount(4);
  await expect(choice(j21)).toContainText("21.0.1");
  await closeMenu();
  await page.reload();
  await openGlobal();
  await openMenu();
  await expect(grid().getByRole("row")).toHaveCount(4);
  expect(
    await page.evaluate(() =>
      window.__pixelTest.requests.filter(
        (r) => r.operation === "java.discover",
      ),
    ),
  ).toHaveLength(0);
  checks.push(
    "Scans save the list immediately without committing unrelated drafts; navigation and reload restore it without discovery.",
  );

  await remove(j17).click();
  await expect.poll(async () => (await saved()).javaPaths).toEqual([j21, j8]);
  await openMenu();
  await expect(choice(j17)).toHaveCount(0);
  await expect(choice(j8)).not.toHaveClass(/is-active/);
  await page.mouse.move(0, 0);
  await expect(choice(j8)).not.toHaveClass(/is-active/);
  await expect(trigger()).not.toHaveAttribute("aria-activedescendant");
  await trigger().press("ArrowUp");
  await expect(choice(j8)).toHaveClass(/is-active/);
  checks.push(
    "Pointer deletion leaves no active border on the replacement row; keyboard navigation can resume from the last option.",
  );
  await page.evaluate(() => {
    window.__pixelTest.failures["java.paths.save"] = "模拟 Java 列表保存失败";
  });
  await remove(j8).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "模拟 Java 列表保存失败" }),
  ).toBeVisible();
  expect((await saved()).javaPaths).toEqual([j21, j8]);
  await openMenu();
  await expect(choice(j8)).toBeVisible();
  await page.evaluate(() => {
    delete window.__pixelTest.failures["java.paths.save"];
  });
  await choice(j21).click();
  await commit();
  await openMenu();
  await trigger().focus();
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await saved()).javaPath).toBe("");
  await expect.poll(async () => (await saved()).javaPaths).toEqual([j8]);
  await expect(trigger()).toContainText("自动选择适合游戏的 Java");
  await closeMenu();
  await page.reload();
  await openGlobal();
  await openMenu();
  await expect(grid().getByRole("row")).toHaveCount(2);
  await expect(grid().getByRole("button")).toHaveCount(1);
  await trigger().focus();
  await page.keyboard.press("Delete");
  expect((await saved()).javaPaths).toEqual([j8]);
  await closeMenu();
  checks.push(
    "Deleting entries persists across reload; removing the selected runtime switches to automatic, automatic cannot be deleted, and failed persistence keeps the entry.",
  );

  await page.evaluate(() => {
    window.__pixelTest.pickedDirectory = "C:/wrong.exe";
  });
  await page.getByRole("button", { name: "手动添加", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: /java\.exe.*javaw\.exe/ }),
  ).toBeVisible();
  expect((await saved()).javaPaths).toEqual([j8]);
  await page.evaluate((path) => {
    window.__pixelTest.pickedDirectory = path;
  }, manual);
  await page.getByRole("button", { name: "手动添加", exact: true }).click();
  await expect
    .poll(async () => (await saved()).javaPaths)
    .toEqual([j8, manual]);
  await expect(trigger()).toContainText(manual);
  await page.evaluate((path) => {
    window.__pixelTest.pickedDirectory = path
      .replaceAll("/", "\\")
      .toUpperCase();
  }, manual);
  await page.getByRole("button", { name: "手动添加", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "手动添加", exact: true }),
  ).toBeEnabled();
  await expect(trigger()).toContainText(manual);
  expect((await saved()).javaPaths).toEqual([j8, manual]);
  await page.getByRole("button", { name: "撤销修改", exact: true }).click();
  await expect(trigger()).toContainText("自动选择适合游戏的 Java");
  expect((await saved()).javaPaths).toEqual([j8, manual]);
  await openMenu();
  await trigger().focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  const actionId = await trigger().getAttribute("aria-activedescendant");
  expect(actionId).toMatch(/-remove$/);
  expect(
    await page.evaluate(
      (id) =>
        document
          .getElementById(id)
          ?.querySelector("button")
          ?.getAttribute("aria-label"),
      actionId,
    ),
  ).toBe(`从列表删除 ${j8}`);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await saved()).javaPaths).toEqual([manual]);
  await openMenu();
  await trigger().focus();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Tab");
  await expect(grid()).toHaveCount(0);
  expect((await saved()).javaPaths).toEqual([manual]);
  await openMenu();
  await remove(manual).click();
  await expect.poll(async () => (await saved()).javaPaths).toEqual([]);
  await page.reload();
  await openGlobal();
  await openMenu();
  await expect(grid().getByRole("row")).toHaveCount(1);
  await expect(grid().getByRole("button")).toHaveCount(0);
  await closeMenu();
  await scan();
  await expect
    .poll(async () => (await saved()).javaPaths)
    .toEqual([j21, j17, j8]);
  checks.push(
    "Manual addition validates filenames and persists the list; keyboard arrows/Enter/Delete work, Tab never deletes, an empty list persists, and explicit scans rediscover installed runtimes.",
  );

  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await openMenu();
      const bounds = await grid().evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          viewport: window.innerWidth,
          overflow: el.scrollWidth > el.clientWidth,
        };
      });
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
      expect(bounds.overflow).toBe(false);
      await expect(remove(j17)).toBeVisible();
      await page.screenshot({
        path: `${evidence}/java-${theme}-${width}.png`,
        animations: "disabled",
      });
      await closeMenu();
    }
  }
  checks.push(
    "Light/dark dropdowns fit narrow and desktop widths, including long paths and delete controls.",
  );

  await openVersion("1.21.4");
  await expect(trigger()).toBeDisabled();
  await scope("Java 运行环境").click();
  await scope("游戏窗口").click();
  await title().fill("Unsaved version title");
  await scan();
  const versionSaved = () =>
    page.evaluate(() => window.__pixelTest.versionSettings["1.21.4"]);
  await expect
    .poll(async () => (await versionSaved())?.settings.javaPaths)
    .toEqual([j21, j17, j8]);
  expect((await versionSaved()).settings.windowTitle).toBe("");
  expect((await versionSaved()).useGlobal).toBe(true);
  await expect(title()).toHaveValue("Unsaved version title");
  await openMenu();
  await choice(j21).click();
  await commit();
  await title().fill("Another unsaved title");
  await openMenu();
  await remove(j21).click();
  await expect
    .poll(async () => (await versionSaved()).settings.javaPaths)
    .toEqual([j17, j8]);
  expect((await versionSaved()).settings.javaPath).toBe("");
  expect((await versionSaved()).settings.windowTitle).toBe(
    "Unsaved version title",
  );
  await expect(title()).toHaveValue("Another unsaved title");
  expect((await saved()).javaPaths).toEqual([j21, j17, j8]);
  await closeMenu();
  await page.getByRole("button", { name: "撤销修改", exact: true }).click();
  await page.getByRole("button", { name: "返回上一级", exact: true }).click();
  await openVersion("1.21.4");
  await openMenu();
  await expect(choice(j21)).toHaveCount(0);
  await closeMenu();
  await scope("Java 运行环境").click();
  await expect(trigger()).toBeDisabled();
  await page.getByRole("button", { name: "撤销修改", exact: true }).click();
  await page.getByRole("button", { name: "返回上一级", exact: true }).click();
  await openVersion("1.20.1-Fabric");
  await scope("Java 运行环境").click();
  await openMenu();
  await expect(choice(j21)).toBeVisible();
  checks.push(
    "Independent version lists persist separately from global and other versions; automatic list writes preserve unsaved titles and scope switches.",
  );

  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors, evidence }, null, 2));
} catch (error) {
  await page.screenshot({
    path: `${evidence}/failure.png`,
    animations: "disabled",
  });
  throw error;
} finally {
  await browser.close();
}
