import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { runtimePath } from "./lib/paths.mjs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { waitForAutoSave } from "./lib/auto-save.mjs";

const evidence = runtimePath("evidence/launch-settings");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
const nav = (name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const select = async (name, option) => {
  const combo = page.getByRole("combobox", { name, exact: true });
  await combo.focus();
  await page.keyboard.press("ArrowDown");
  const choices = await page.getByRole("option").allTextContents();
  const index = choices.findIndex((text) => text.trim() === option);
  expect(index).toBeGreaterThanOrEqual(0);
  await page.keyboard.press("Home");
  for (let step = 0; step < index; step++)
    await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
};
const scope = (name) =>
  page.getByRole("switch", { name: `${name}：独立设置`, exact: true });
const openVersion = async (id) => {
  await page
    .getByRole("button", { name: `游戏设置 ${id}`, exact: true })
    .click();
  await expect(scope("游戏窗口")).toBeVisible();
};
try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await nav("设置");
  await page.getByRole("tab", { name: "全局设置", exact: true }).click();
  await expect(page.locator(".settings-card-heading h2")).toHaveText([
    "Java 运行环境",
    "内存与游戏目录",
    "游戏窗口",
    "启动行为",
    "高级启动参数",
  ]);
  await expect(
    page.getByRole("textbox", { name: "服务器地址", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "快速进入的存档", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.__pixelTest.requests.some(
        (request) => request.operation === "game.launch-options",
      ),
    ),
  ).toBe(false);
  const windowCard = page.locator(".settings-section:visible").filter({
    has: page.getByRole("heading", { name: "游戏窗口", exact: true }),
  });
  await expect(
    windowCard.getByRole("textbox", { name: "窗口标题", exact: true }),
  ).toBeVisible();
  await expect(
    windowCard.getByRole("combobox", { name: "窗口位置", exact: true }),
  ).toBeVisible();
  await expect(windowCard.locator(":scope > .surface-frame")).toHaveCount(1);
  await expect(windowCard.locator("p.helper")).toHaveCount(0);
  await windowCard.screenshot({
    path: evidence + "/window-default-1100.png",
    animations: "disabled",
  });
  await select("窗口位置", "自定义位置");
  await page.getByRole("spinbutton", { name: "窗口横向位置" }).fill("120");
  await page.getByRole("spinbutton", { name: "窗口纵向位置" }).fill("80");
  await select("游戏显示器", "显示器 2 · 2560 × 1440");
  await select("游戏启动后启动器行为", "隐藏到系统托盘");
  await select("游戏进程优先级", "高于正常");
  await waitForAutoSave(page);
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings),
  ).toMatchObject({
    windowMode: "custom",
    windowMonitor: "display-2",
    windowX: 120,
    windowY: 80,
    launcherAction: "tray",
    processPriority: "aboveNormal",
    serverEnabled: false,
    serverHost: "",
    quickPlayEnabled: false,
    quickPlayWorld: "",
  });
  await nav("版本管理");
  await openVersion("1.21.4");
  const directEntryCard = page.locator(
    '[data-setting-card="direct-entry"]:visible',
  );
  const host = () =>
    page.getByRole("textbox", { name: "服务器地址", exact: true });
  const port = () =>
    page.getByRole("spinbutton", { name: "服务器端口", exact: true });
  const world = () =>
    page.getByRole("combobox", { name: "快速进入的存档", exact: true });
  await expect(directEntryCard.getByRole("switch")).toHaveCount(0);
  await expect(directEntryCard.locator(":scope > .surface-frame")).toHaveCount(
    1,
  );
  await expect(directEntryCard.locator("p.helper, .setting-row p")).toHaveCount(
    0,
  );
  await expect(host()).toBeEnabled();
  await expect(world()).toBeEnabled();
  await expect(host()).toHaveValue("");
  await expect(port()).toHaveValue("");
  await expect(
    page.locator(".settings-card-heading .pixel-switch-labeled"),
  ).toHaveCount(5);
  const windowFields = page.locator('[data-setting-group="window"]:visible');
  const launcherFields = page.locator(
    '[data-setting-group="launcher"]:visible',
  );
  await expect(
    windowFields.locator(".settings-card-heading .pixel-switch-labeled"),
  ).toHaveCount(1);
  await expect(
    launcherFields.locator(".settings-card-heading .pixel-switch-labeled"),
  ).toHaveCount(1);
  await expect(
    windowFields.getByRole("combobox", { name: "窗口位置", exact: true }),
  ).toBeDisabled();
  await expect(
    launcherFields.getByRole("combobox", {
      name: "游戏进程优先级",
      exact: true,
    }),
  ).toBeDisabled();
  await port().fill("25566");
  await waitForAutoSave(page);
  await expect(port()).toHaveValue("25566");
  await port().fill("");
  await waitForAutoSave(page);
  await expect(port()).toHaveValue("");
  await host().fill("version.example.com");
  await waitForAutoSave(page);
  expect(
    await page.evaluate(
      () => window.__pixelTest.versionSettings["1.21.4"].settings,
    ),
  ).toMatchObject({ serverEnabled: true, serverPort: 25565 });
  await host().fill("");
  await port().fill("25566");
  await waitForAutoSave(page);
  expect(
    await page.evaluate(() => window.__pixelTest.versionSettings["1.21.4"]),
  ).toMatchObject({
    useGlobal: true,
    settings: { serverPort: 25566, serverEnabled: false },
  });

  // Filling and clearing a target automatically activates and releases its version scope.
  await host().fill("version.example.com");
  await port().fill("25566");
  await waitForAutoSave(page);
  expect(
    await page.evaluate(() => window.__pixelTest.versionSettings["1.21.4"]),
  ).toMatchObject({
    useGlobal: false,
    independentGroups: { server: true, world: false, memory: false },
    settings: {
      serverEnabled: true,
      serverHost: "version.example.com",
      serverPort: 25566,
      quickPlayEnabled: false,
    },
  });
  await host().fill("");
  await waitForAutoSave(page);
  expect(
    await page.evaluate(() => window.__pixelTest.versionSettings["1.21.4"]),
  ).toMatchObject({
    useGlobal: true,
    independentGroups: { server: false, world: false },
    settings: {
      serverEnabled: false,
      serverHost: "",
      quickPlayEnabled: false,
      quickPlayWorld: "",
    },
  });
  await host().fill("version.example.com");
  await port().fill("0");
  await waitForAutoSave(page);
  expect(
    await page.evaluate(
      () => window.__pixelTest.versionSettings["1.21.4"].settings.serverPort,
    ),
  ).toBe(25566);
  await port().fill("25566");
  await host().fill("invalid.example:25565");
  await waitForAutoSave(page);
  expect(
    await page.evaluate(
      () => window.__pixelTest.versionSettings["1.21.4"].settings.serverHost,
    ),
  ).toBe("version.example.com");
  await host().fill("version.example.com");
  for (const name of ["游戏窗口", "启动行为"]) await scope(name).click();
  await expect(
    windowFields.getByRole("spinbutton", { name: "宽度", exact: true }),
  ).toBeEnabled();
  await expect(
    windowFields.getByRole("combobox", { name: "窗口位置", exact: true }),
  ).toBeEnabled();
  await expect(
    windowFields.getByRole("textbox", { name: "窗口标题", exact: true }),
  ).toBeEnabled();
  await expect(
    launcherFields.getByRole("combobox", {
      name: "游戏进程优先级",
      exact: true,
    }),
  ).toBeEnabled();
  await select("窗口位置", "记住上次窗口位置");
  await select("游戏启动后启动器行为", "最小化到任务栏");
  await select("游戏进程优先级", "低于正常");
  await waitForAutoSave(page);

  await page.getByRole("button", { name: "返回上一级", exact: true }).click();
  await openVersion("1.20.1-Fabric");
  await expect(host()).toHaveValue("");
  await expect(world()).toHaveText(/不进入存档/);
  await select("快速进入的存档", "创造测试 · Creative");
  await waitForAutoSave(page);
  expect(
    await page.evaluate(
      () => window.__pixelTest.versionSettings["1.20.1-Fabric"],
    ),
  ).toMatchObject({
    useGlobal: false,
    independentGroups: { server: false, world: true },
    settings: {
      serverEnabled: false,
      serverHost: "",
      quickPlayEnabled: true,
      quickPlayWorld: "Creative",
    },
  });
  await select("快速进入的存档", "不进入存档");
  await waitForAutoSave(page);
  expect(
    await page.evaluate(
      () => window.__pixelTest.versionSettings["1.20.1-Fabric"],
    ),
  ).toMatchObject({
    useGlobal: true,
    settings: {
      serverEnabled: false,
      quickPlayEnabled: false,
      quickPlayWorld: "",
    },
  });
  await select("快速进入的存档", "创造测试 · Creative");
  await host().fill("fabric.example.com");
  await expect(world()).toHaveText(/不进入存档/);
  await waitForAutoSave(page);
  expect(
    await page.evaluate(
      () => window.__pixelTest.versionSettings["1.20.1-Fabric"].settings,
    ),
  ).toMatchObject({
    serverEnabled: true,
    serverHost: "fabric.example.com",
    quickPlayEnabled: false,
    quickPlayWorld: "",
  });
  await select("快速进入的存档", "创造测试 · Creative");
  await expect(host()).toHaveValue("");
  await waitForAutoSave(page);
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings),
  ).toMatchObject({
    serverEnabled: false,
    serverHost: "",
    quickPlayEnabled: false,
    quickPlayWorld: "",
  });
  expect(
    await page.evaluate(
      () => window.__pixelTest.versionSettings["1.21.4"].settings.serverHost,
    ),
  ).toBe("version.example.com");

  await page.getByRole("button", { name: "返回上一级", exact: true }).click();
  await openVersion("1.21.4");
  await expect(host()).toHaveValue("version.example.com");
  await expect(page.getByRole("combobox", { name: "窗口位置" })).toHaveText(
    /记住上次窗口位置/,
  );
  await scope("启动行为").click();
  await expect(
    launcherFields.getByRole("combobox", {
      name: "游戏进程优先级",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "游戏启动后启动器行为" }),
  ).toHaveText(/隐藏到系统托盘/);
  await scope("启动行为").click();
  await expect(
    launcherFields.getByRole("combobox", {
      name: "游戏进程优先级",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    page.getByRole("combobox", { name: "游戏启动后启动器行为" }),
  ).toHaveText(/最小化到任务栏/);
  await waitForAutoSave(page);
  for (const width of [375, 864, 1100]) {
    await page.setViewportSize({ width, height: 760 });
    for (const group of ["window", "launcher", "direct-entry"]) {
      const card =
        group === "direct-entry"
          ? directEntryCard
          : page
              .locator('[data-setting-group="' + group + '"]:visible')
              .locator(
                "xpath=ancestor-or-self::section[contains(concat(' ', normalize-space(@class), ' '), ' settings-section ')][1]",
              );
      await card.scrollIntoViewIfNeeded();
      const bounds = await page.locator("main.page").evaluate((element) => ({
        width: element.clientWidth,
        content: element.scrollWidth,
      }));
      expect(bounds.content).toBeLessThanOrEqual(bounds.width + 1);
      await card.screenshot({
        path: evidence + "/" + group + "-" + width + ".png",
        animations: "disabled",
      });
    }
  }
  await page.evaluate(() =>
    window.__pixelTest.versions.push({
      ...window.__pixelTest.versions[0],
      id: "1.19.4",
      version: "1.19.4",
      path:
        window.__pixelTest.data.settings.activeDir +
        "/.minecraft/versions/1.19.4",
    }),
  );
  await page.getByRole("button", { name: "返回上一级", exact: true }).click();
  await page.getByRole("button", { name: "刷新版本", exact: true }).click();
  await openVersion("1.19.4");
  await expect(world()).toBeDisabled();
  await page.evaluate(() => {
    window.__pixelTest.versionSettings["1.19.4"] = {
      useGlobal: false,
      independentGroups: {
        java: false,
        memory: false,
        window: false,
        advanced: false,
        world: true,
      },
      settings: {
        ...window.__pixelTest.data.settings,
        serverEnabled: false,
        serverHost: "",
        quickPlayEnabled: true,
        quickPlayWorld: "My World",
      },
    };
  });
  await page.getByRole("button", { name: "返回上一级", exact: true }).click();
  await openVersion("1.19.4");
  await select("快速进入的存档", "不进入存档");
  await waitForAutoSave(page);
  await expect(world()).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        window.__pixelTest.versionSettings["1.19.4"].settings.quickPlayEnabled,
    ),
  ).toBe(false);
  await host().fill("legacy.example.com");
  await waitForAutoSave(page);
  expect(
    await page.evaluate(() => window.__pixelTest.versionSettings["1.19.4"]),
  ).toMatchObject({
    independentGroups: { server: true, world: false },
    settings: {
      serverEnabled: true,
      serverHost: "legacy.example.com",
      quickPlayEnabled: false,
    },
  });
  expect(errors).toEqual([]);
  const checks = [
    "Window size, title, position and monitor share one card without helper text",
    "Each merged window and launch card uses one scope switch for all its fields",
    "Direct-entry card exists only in version settings and contains no switches",
    "Filling and clearing targets automatically enables and disables version-only direct entry",
    "Selecting a world and entering a server clear the other target",
    "Invalid server addresses and ports do not overwrite saved valid values",
    "The port defaults to a blank field and uses 25565 when left empty",
    "Other versions and global settings retain their values",
    "Unsupported Quick Play versions can still use server direct entry",
    "No horizontal overflow at 375, 864 and 1100 pixels",
  ];
  await writeFile(
    evidence + "/checks.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      await page.evaluate(() => ({
        saving: [...document.querySelectorAll('[data-saving="true"]')].map(
          (element) => element.className,
        ),
        alerts: [...document.querySelectorAll('[role="alert"]')].map(
          (element) => element.textContent,
        ),
        requests: window.__pixelTest.requests.slice(-12),
        global: window.__pixelTest.data.settings,
        versions: window.__pixelTest.versionSettings,
      })),
      null,
      2,
    ),
  );
  await page.screenshot({
    path: `${evidence}/failure.png`,
    animations: "disabled",
  });
  throw error;
} finally {
  await browser.close();
}
