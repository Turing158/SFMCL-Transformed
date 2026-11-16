import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { waitForAutoSave } from "./lib/auto-save.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence =
  process.env.SFMCL_T_LAN_UI_EVIDENCE ||
  runtimePath("evidence", "offline-lan-ui");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(pixelAppFixture);
  await page.addInitScript(() => {
    const fixture = window.__pixelTest;
    fixture.versions.push(
      ...["Forge", "NeoForge", "Quilt", "OptiFine"].map((loader) => ({
        ...fixture.versions[0],
        id: `1.21.4-${loader}`,
        loader,
        path: `${fixture.data.settings.activeDir}/.minecraft/versions/1.21.4-${loader}`,
      })),
    );
    fixture.multiplayerStatus = {
      state: "idle",
      sessionId: null,
      componentReady: true,
      componentVersion: "2.6.4",
      componentJobId: null,
      role: null,
      name: "",
      gameVersion: "",
      address: null,
      worldOpen: false,
      members: [],
      error: null,
    };
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "request" && args.operation === "multiplayer.status") {
        return structuredClone(fixture.multiplayerStatus);
      }
      if (command === "request" && args.payload?.id === "RTWpcTBp") {
        const value = await original(command, args);
        if (args.operation === "resources.files") return [];
        if (args.operation !== "resources.detail") return value;
        return {
          ...value,
          id: "RTWpcTBp",
          title: "LAN World Plug-n-Play",
          description: "允许离线玩家加入局域网世界。",
          website: "https://modrinth.com/mod/mcwifipnp",
          body: "## 离线联机\n在对局域网开放中禁用正版验证。",
        };
      }
      return original(command, args);
    };
  });
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true })
      .click();
  const option = () =>
    page.getByRole("switch", {
      name: "允许离线账号加入局域网",
      exact: true,
    });
  await nav("联机");
  await expect(option()).toBeEnabled();
  await expect(option()).not.toBeChecked();
  await expect(page.locator(".multiplayer-offline-lan small")).toHaveCount(0);
  await expect(page.locator(".multiplayer-offline-lan")).not.toContainText(
    "重启游戏后生效",
  );
  await expect(option()).not.toHaveAttribute("title");
  await expect(
    page.locator(".toast.success").filter({ hasText: "重启游戏后生效" }),
  ).toHaveCount(0);
  await page
    .locator(".multiplayer-submit")
    .screenshot({ path: `${evidence}/create-row.png` });
  const position = await page.locator(".multiplayer-submit").evaluate((row) => {
    const button = row
      .querySelector('button[type="submit"]')
      .getBoundingClientRect();
    const option = row
      .querySelector(".multiplayer-offline-lan")
      .getBoundingClientRect();
    return {
      button: { right: button.right, y: button.y, height: button.height },
      option: { x: option.x, right: option.right, y: option.y },
      rowRight: row.getBoundingClientRect().right,
    };
  });
  expect(position.option.x).toBeGreaterThan(position.button.right);
  expect(Math.abs(position.option.y - position.button.y)).toBeLessThan(10);
  expect(Math.abs(position.option.right - position.rowRight)).toBeLessThan(2);
  expect(position.button.height).toBe(36);
  await option().hover();
  const tooltip = page.locator("#sfmcl-t-tooltip");
  await expect(tooltip).toHaveAttribute("data-open", "true");
  await expect(tooltip).toHaveText("允许离线账号加入局域网");
  await expect(option()).toHaveAttribute("aria-describedby", "sfmcl-t-tooltip");
  await tooltip.screenshot({ path: `${evidence}/offline-lan-tooltip.png` });
  await page.getByText("离线联机", { exact: true }).click();
  await waitForAutoSave(page);
  await expect(
    page.locator(".toast.success").filter({ hasText: "重启游戏后生效" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.offlineLan),
  ).toBe(true);
  await nav("设置");
  await nav("联机");
  await expect(option()).toBeEnabled();
  await expect(option()).toBeChecked();
  expect(
    await page.evaluate(() =>
      window.__pixelTest.requests.some(
        (call) => call.operation === "multiplayer.create",
      ),
    ),
  ).toBe(false);

  await nav("设置");
  await page.getByRole("tab", { name: "全局设置", exact: true }).click();
  await expect(option()).toHaveCount(0);
  await nav("版本管理");
  await page
    .getByRole("button", { name: "游戏设置 1.21.4", exact: true })
    .click();
  await expect(option()).toHaveCount(0);
  const independent = page.getByRole("switch", {
    name: "高级启动参数：独立设置",
    exact: true,
  });
  await independent.click();
  await waitForAutoSave(page);
  const before = await page.evaluate(
    () => window.__pixelTest.versionSettings["1.21.4"],
  );
  await nav("联机");
  await expect(option()).toBeEnabled();
  await expect(option()).toBeChecked();
  await option().click();
  await waitForAutoSave(page);
  const after = await page.evaluate(
    () => window.__pixelTest.versionSettings["1.21.4"],
  );
  expect(after).toEqual({
    ...before,
    settings: { ...before.settings, offlineLan: false },
  });
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.offlineLan),
  ).toBe(true);
  await nav("版本管理");
  await expect(independent).toBeChecked();
  await independent.click();
  await waitForAutoSave(page);
  await nav("联机");
  await expect(option()).toBeEnabled();
  await expect(option()).toBeChecked();

  await page.evaluate(() => {
    window.__pixelTest.failures["settings.save"] = "fixture failure";
  });
  await option().click();
  await expect(
    page.locator(".toast.error").filter({ hasText: "离线联机设置保存失败" }),
  ).toBeVisible();
  await expect(option()).toBeEnabled();
  await expect(option()).toBeChecked();
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.offlineLan),
  ).toBe(true);
  await page.evaluate(() => {
    delete window.__pixelTest.failures["settings.save"];
  });
  await nav("设置");
  await page.evaluate(() => {
    window.__pixelTest.failures["versions.settings.get"] = "fixture failure";
  });
  await nav("联机");
  await expect(option()).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "读取失败，重试" }),
  ).toBeVisible();
  await page.evaluate(() => {
    delete window.__pixelTest.failures["versions.settings.get"];
  });
  await page.getByRole("button", { name: "读取失败，重试" }).click();
  await expect(option()).toBeEnabled();

  await page.evaluate(() => {
    const fixture = window.__pixelTest;
    fixture.versionSettings["other-host"] = {
      useGlobal: false,
      independentGroups: { advanced: true },
      settings: {
        ...fixture.data.settings,
        offlineLan: false,
        jvmArgs: "preserve-host-args",
      },
    };
    fixture.tasks.jobs = [
      ["first", "1.21.4", fixture.data.settings.activeDir, false],
      ["second", "other-host", "E:/Other Minecraft", true],
    ].map(([id, versionId, directory, offlineLan]) => ({
      id,
      title: `启动 ${versionId}`,
      status: "running",
      currentStep: 0,
      steps: [{ name: "游戏运行", status: "running", detail: "" }],
      log: [],
      launch: {
        versionId,
        directory,
        offlineLan,
        gameVersion: "1.21.4",
        playerName: id,
        running: true,
      },
    }));
  });
  const host = page.getByRole("combobox", { name: "房主游戏", exact: true });
  await expect(host).toBeVisible();
  await expect(option()).toBeDisabled();
  await host.click();
  await page.getByRole("option", { name: /other-host/ }).click();
  await expect(option()).toBeEnabled();
  await expect(option()).not.toBeChecked();
  await expect(page.getByText(/^当前游戏：/)).toHaveCount(0);
  await option().click();
  await waitForAutoSave(page);
  await option().click();
  await waitForAutoSave(page);
  expect(
    await page.evaluate(
      () => window.__pixelTest.versionSettings["other-host"].settings.jvmArgs,
    ),
  ).toBe("preserve-host-args");
  const hostSave = await page.evaluate(
    () =>
      window.__pixelTest.requests
        .filter((call) => call.operation === "versions.settings.save")
        .at(-1).payload,
  );
  expect(hostSave.id).toBe("other-host");
  expect(hostSave.directory).toBe("E:/Other Minecraft");
  expect(hostSave.config.settings.offlineLan).toBe(false);
  await host.click();
  await page.getByRole("option", { name: /1\.21\.4 · first/ }).click();
  await expect(option()).toBeEnabled();
  await expect(option()).toBeChecked();

  for (const width of [900, 600, 420]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(option()).toBeVisible();
    const bounds = await page
      .locator(".multiplayer-submit")
      .evaluate((row) => ({
        row: row.getBoundingClientRect().toJSON(),
        control: row
          .querySelector(".multiplayer-offline-lan")
          .getBoundingClientRect()
          .toJSON(),
        overflow: document.documentElement.scrollWidth - innerWidth,
      }));
    expect(bounds.control.right).toBeLessThanOrEqual(bounds.row.right + 2);
    expect(bounds.control.left).toBeGreaterThanOrEqual(bounds.row.left - 2);
    expect(bounds.overflow).toBeLessThanOrEqual(1);
  }
  await page
    .locator('main[data-page="multiplayer"]')
    .screenshot({ path: `${evidence}/narrow.png` });
  await page.getByRole("tab", { name: "加入房间", exact: true }).click();
  await expect(option()).toHaveCount(0);
  expect(
    (
      await page
        .getByRole("button", { name: "查看房间", exact: true })
        .boundingBox()
    ).height,
  ).toBe(36);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await nav("联机");
  await expect(option()).not.toBeChecked();
  await option().click();
  await waitForAutoSave(page);

  const chooseVersion = async (id) => {
    await nav("版本管理");
    await page.getByRole("button", { name: `选择 ${id}`, exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => window.__pixelTest.data.settings.activeVersion),
      )
      .toBe(id);
    await nav("联机");
  };
  const guide = () =>
    page.getByRole("button", { name: "离线联机", exact: true });
  for (const [id, loader, gameVersion] of [
    ["1.20.1-Fabric", "fabric", "1.20.1"],
    ["1.21.4-Forge", "forge", "1.21.4"],
    ["1.21.4-NeoForge", "neoforge", "1.21.4"],
    ["1.21.4-Quilt", "quilt", "1.21.4"],
  ]) {
    await chooseVersion(id);
    await expect(option()).toHaveCount(0);
    await expect(guide()).toHaveAttribute("aria-haspopup", "dialog");
    expect(
      await page.evaluate(() => window.__pixelTest.data.settings.offlineLan),
    ).toBe(false);
    await guide().click();
    const dialog = page.getByRole("dialog", { name: "离线联机安装教程" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(id);
    await expect(dialog).toContainText("正版验证");
    await expect(dialog).toContainText("LAN World Plug-n-Play");
    if (loader === "forge") {
      await dialog.screenshot({ path: `${evidence}/forge-install-guide.png` });
      await page.setViewportSize({ width: 420, height: 760 });
      const bounds = await dialog.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(420);
      await dialog.screenshot({
        path: `${evidence}/forge-install-guide-narrow.png`,
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await dialog.getByRole("button", { name: "前往模组页面" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.locator('main[data-page="multiplayer"][data-view="resources"]'),
    ).toBeVisible();
    await expect(page.locator(".resource-subpage")).toHaveAttribute(
      "aria-label",
      "LAN World Plug-n-Play",
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__pixelTest.requests
              .filter(
                (call) =>
                  call.operation === "resources.files" &&
                  call.payload.id === "RTWpcTBp",
              )
              .at(-1)?.payload,
        ),
      )
      .toEqual({ source: "modrinth", id: "RTWpcTBp", gameVersion, loader });
    await page.getByRole("button", { name: "返回上一级", exact: true }).click();
    await expect(guide()).toBeVisible();
  }
  await chooseVersion("1.21.4");
  await expect(option()).not.toBeChecked();
  await option().click();
  await waitForAutoSave(page);
  await chooseVersion("1.21.4-OptiFine");
  await expect(option()).toBeChecked();
  await expect(guide()).toHaveCount(0);
  await chooseVersion("1.21.4");
  await expect(option()).toBeChecked();

  await page.evaluate(() => {
    Object.assign(window.__pixelTest.multiplayerStatus, {
      state: "preparing",
      sessionId: "component-job",
    });
  });
  await chooseVersion("1.21.4-Forge");
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.offlineLan),
  ).toBe(false);
  await page.evaluate(() => {
    Object.assign(window.__pixelTest.multiplayerStatus, {
      state: "idle",
      sessionId: null,
    });
  });
  await expect(guide()).toBeEnabled();
  await chooseVersion("1.21.4");

  await page.evaluate(() => {
    const fixture = window.__pixelTest;
    fixture.tasks.jobs = [
      {
        id: "forge-host",
        title: "启动 Forge",
        status: "running",
        currentStep: 0,
        steps: [{ name: "游戏运行", status: "running", detail: "" }],
        log: [],
        launch: {
          versionId: "1.21.4-Forge",
          directory: "E:/Other Minecraft",
          gameVersion: "1.21.4",
          playerName: "ForgeHost",
          running: true,
        },
      },
    ];
  });
  await expect(guide()).toBeVisible();
  await guide().click();
  await expect(page.getByRole("dialog")).toContainText("1.21.4-Forge");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(
    "Offline LAN UI: defaults, persistence, loader resets, Forge/NeoForge/Fabric/Quilt guides, filtered subpage navigation, OptiFine exemption, host metadata and narrow layout passed",
  );
} finally {
  await browser.close();
}
