import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { runtimePath } from "./lib/paths.mjs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";

const evidence = runtimePath("evidence/mod-dependencies");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.emulateMedia({ reducedMotion: "reduce" });
await page.addInitScript(pixelAppFixture);
await page.addInitScript(resourceCenterFixture);
await page.addInitScript(() => {
  window.__modInstallTest = {
    mode: "normal",
    delay: 0,
    plans: 0,
    installed: [],
    discarded: [],
  };
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command !== "request") return invoke(command, args);
    const { operation, payload } = args;
    const state = window.__modInstallTest;
    if (operation === "resources.installPlan") {
      const mode = state.mode;
      const token = `plan-${++state.plans}`;
      if (state.delay)
        await new Promise((resolve) => setTimeout(resolve, state.delay));
      if (mode === "network")
        throw new Error("无法确认本地资源身份，请重试依赖检查");
      if (mode === "conflict")
        return {
          token: null,
          items: [],
          issues: ["已有前置 Fabric API 的版本不满足要求，请先处理版本冲突"],
          warnings: [],
        };
      return {
        token,
        issues: [],
        warnings: [],
        items: [
          {
            projectId: payload.projectId,
            versionId: payload.fileId,
            name: "Sodium",
            version: "0.5.13",
            kind: "mod",
            status: "install",
            path: "mods/sodium.jar",
            main: true,
          },
          {
            projectId: "project-1",
            versionId: "api-version",
            name: "Fabric API",
            version: "0.92.2",
            kind: "mod",
            status: mode === "disabled" ? "disabled" : "installed",
            path:
              mode === "disabled"
                ? "mods/.disabled/fabric-api.jar"
                : "mods/renamed-api.jar",
            main: false,
          },
          {
            projectId: "project-2",
            versionId: "nested-version",
            name: "递归前置",
            version: "1.0",
            kind: "mod",
            status: "install",
            path: "mods/nested.jar",
            main: false,
          },
        ],
      };
    }
    if (operation === "resources.install") {
      state.installed.push(structuredClone(payload));
      if (state.mode === "stale") {
        state.mode = "normal";
        throw new Error("本地模组或资源已变化，请重新检查前置依赖");
      }
      return "installation-job";
    }
    if (operation === "resources.discardInstallPlan") {
      state.discarded.push(payload.token);
      return true;
    }
    return invoke(command, args);
  };
});

const dialog = page.getByRole("dialog", { name: "下载 Sodium", exact: true });
const install = dialog.getByRole("button", { name: "开始安装", exact: true });
const automatic = dialog.getByRole("checkbox", {
  name: "自动安装必需前置依赖",
});
const open = async (mode = "normal", delay = 0) => {
  await page.evaluate(
    ({ mode, delay }) =>
      Object.assign(window.__modInstallTest, { mode, delay }),
    { mode, delay },
  );
  await page.locator("button.project-file").first().click();
  await expect(dialog).toBeVisible();
};
const close = async () => {
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
};
try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "资源中心", exact: true })
    .click();
  await page.getByRole("tab", { name: "模组", exact: true }).click();
  await page
    .getByRole("button", { name: "查看 Sodium 详情", exact: true })
    .click();
  await page.getByRole("tab", { name: /^下载/ }).click();

  await open("normal", 450);
  await expect(automatic).toBeChecked();
  await expect(install).toBeDisabled();
  await expect(dialog.getByRole("status")).toContainText("正在检查前置");
  await expect(dialog).toContainText("已安装，跳过下载");
  await expect(dialog).toContainText("递归前置");
  await expect(install).toBeEnabled();
  await automatic.uncheck();
  await expect(dialog).toContainText("仅下载主模组");
  await expect(
    dialog.getByRole("button", { name: "开始下载", exact: true }),
  ).toBeEnabled();
  await automatic.check();
  await expect(install).toBeEnabled();
  await close();
  expect(
    await page.evaluate(() => window.__modInstallTest.discarded.length),
  ).toBeGreaterThan(0);

  await open("disabled");
  const enable = dialog.getByRole("checkbox", { name: "启用已有 Fabric API" });
  await expect(enable).not.toBeChecked();
  await expect(install).toBeDisabled();
  await enable.check();
  await expect(install).toBeEnabled();
  await enable.uncheck();
  await expect(install).toBeDisabled();
  await enable.check();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 960 });
      await expect
        .poll(() =>
          dialog.evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
        )
        .toBe(true);
      await dialog.screenshot({
        path: `${evidence}/plan-${theme}-${width}.png`,
        animations: "disabled",
      });
    }
  }
  await close();

  await open("conflict");
  await expect(dialog.getByRole("alert")).toContainText("版本不满足要求");
  await expect(install).toBeDisabled();
  await page.evaluate(() => {
    window.__modInstallTest.mode = "normal";
  });
  await dialog.getByRole("button", { name: "重新检查前置" }).click();
  await expect(install).toBeEnabled();
  await close();

  await open("network");
  await expect(dialog.getByRole("alert")).toContainText("无法确认本地资源身份");
  await expect(install).toBeDisabled();
  await page.evaluate(() => {
    window.__modInstallTest.mode = "normal";
  });
  await dialog.getByRole("button", { name: "重新检查前置" }).click();
  await expect(install).toBeEnabled();
  await close();

  await open("stale");
  await expect(install).toBeEnabled();
  const previous = await page.evaluate(() => window.__modInstallTest.plans);
  await install.click();
  await expect(dialog.getByRole("alert")).toContainText("本地模组或资源已变化");
  await expect
    .poll(() => page.evaluate(() => window.__modInstallTest.plans))
    .toBeGreaterThan(previous);
  await expect(install).toBeEnabled();
  await close();

  await open("normal", 600);
  await dialog.getByRole("tab", { name: "下载到文件夹", exact: true }).click();
  await expect(
    dialog.getByRole("region", { name: "模组安装清单" }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.__pixelTest.resources.selectedDirectory =
      "C:/Pixel-Test/mod-downloads";
  });
  await dialog.getByRole("button", { name: "选择文件夹", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "开始下载", exact: true }),
  ).toBeEnabled();
  await close();

  await open("disabled");
  await dialog.getByRole("checkbox", { name: "启用已有 Fabric API" }).check();
  await install.click();
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(() => window.__modInstallTest.installed.at(-1)),
  ).toMatchObject({
    versionId: "1.20.1-Fabric",
    enablePaths: ["mods/.disabled/fabric-api.jar"],
  });
  await expect(
    page.getByRole("status").filter({ hasText: "模组与前置已加入安装队列" }),
  ).toBeVisible();
  await expect(page.locator("button.project-file").first()).toBeEnabled();
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify(
      {
        checks: [
          "default on and loading",
          "existing dependency skip",
          "disabled explicit enable",
          "conflict and retry",
          "network error and retry",
          "stale plan refresh",
          "folder download and stale response",
          "single grouped install",
          "light/dark narrow layout",
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log(`Mod dependency UI verified; evidence: ${evidence}`);
} finally {
  await browser.close();
}
