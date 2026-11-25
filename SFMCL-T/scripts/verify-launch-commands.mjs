import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { runtimePath } from "./lib/paths.mjs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { waitForAutoSave } from "./lib/auto-save.mjs";

const evidence = runtimePath("evidence/launch-commands");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript({
  content: `(${pixelAppFixture.toString()})({ components: true });`,
});
const nav = (name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const saved = () => page.evaluate(() => window.__pixelTest.data.settings);
const local = () =>
  page.evaluate(() => window.__pixelTest.versionSettings["1.21.4"]);
const scope = () =>
  page.getByRole("switch", { name: "执行命令：独立设置", exact: true });
const advanced = page.getByRole("button", { name: "高级设置", exact: true });
const select = async (name, text) => {
  await page.getByRole("combobox", { name, exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  const options = await page.getByRole("option").allTextContents();
  const index = options.findIndex((option) => option.trim() === text);
  expect(index).toBeGreaterThanOrEqual(0);
  await page.keyboard.press("Home");
  for (let i = 0; i < index; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
};
try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await nav("设置");
  await page.getByRole("tab", { name: "全局设置", exact: true }).click();
  await advanced.click();
  const pre = () =>
    page.getByRole("textbox", { name: "启动前命令内容", exact: true });
  const post = () =>
    page.getByRole("textbox", { name: "退出后命令内容", exact: true });
  await expect(
    page.getByRole("switch", { name: "启用启动前命令" }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("spinbutton", { name: "退出后命令超时时间" }),
  ).toHaveValue("300");
  await page.getByRole("switch", { name: "启用启动前命令" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "请填写命令内容" }),
  ).toBeVisible();
  await waitForAutoSave(page);
  expect((await saved()).preLaunchCommand.enabled).toBe(false);
  await pre().fill("echo ready\necho 中文命令");
  await select("启动前命令执行方式", "PowerShell");
  await select("启动前命令失败处理", "记录警告并继续启动");
  await page
    .getByRole("spinbutton", { name: "启动前命令超时时间" })
    .fill("120");
  await page
    .getByRole("textbox", { name: "启动前命令工作目录" })
    .fill("脚本 目录");
  await post().fill("Write-Output $env:SFMCL_EXIT_REASON");
  await select("退出后命令执行方式", "PowerShell");
  await page.getByRole("switch", { name: "启用退出后命令" }).click();
  await waitForAutoSave(page);
  expect(await saved()).toMatchObject({
    preLaunchCommand: {
      enabled: true,
      shell: "powershell",
      command: "echo ready\necho 中文命令",
      timeoutSeconds: 120,
      workingDirectory: "脚本 目录",
      continueOnFailure: true,
    },
    postExitCommand: { enabled: true, timeoutSeconds: 300 },
  });
  await page.getByRole("spinbutton", { name: "启动前命令超时时间" }).fill("0");
  await waitForAutoSave(page);
  expect((await saved()).preLaunchCommand.timeoutSeconds).toBe(120);
  await advanced.click();
  await expect(pre()).toHaveCount(0);
  await advanced.click();
  await expect(
    page.getByRole("alert").filter({ hasText: "超时时间必须" }),
  ).toBeVisible();
  await page
    .getByRole("spinbutton", { name: "启动前命令超时时间" })
    .fill("120");
  await waitForAutoSave(page);
  await page.setViewportSize({ width: 1100, height: 1600 });
  await page.locator('[data-setting-group="commands"]:visible').screenshot({
    path: evidence + "/global-1100.png",
    animations: "disabled",
  });
  await nav("版本管理");
  await page
    .getByRole("button", { name: "游戏设置 1.21.4", exact: true })
    .click();
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  await advanced.click();
  await expect(scope()).not.toBeChecked();
  await expect(pre()).toBeDisabled();
  await expect(pre()).toHaveValue("echo ready\necho 中文命令");
  await scope().click();
  await expect(pre()).toBeEnabled();
  await pre().fill("echo version only");
  await page.getByRole("switch", { name: "启用启动前命令" }).click();
  await waitForAutoSave(page);
  expect(await local()).toMatchObject({
    independentGroups: { commands: true },
    settings: {
      preLaunchCommand: { enabled: false, command: "echo version only" },
    },
  });
  expect((await saved()).preLaunchCommand.enabled).toBe(true);
  await scope().click();
  await waitForAutoSave(page);
  await expect(pre()).toHaveValue("echo ready\necho 中文命令");
  await scope().click();
  await waitForAutoSave(page);
  await expect(pre()).toHaveValue("echo version only");
  await expect(
    page.getByRole("switch", { name: "启用启动前命令" }),
  ).not.toBeChecked();
  await page.setViewportSize({ width: 800, height: 1600 });
  await page.locator('[data-setting-group="commands"]:visible').screenshot({
    path: evidence + "/version-800.png",
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.evaluate(() => {
    window.__pixelTest.tasks.jobs = [
      {
        id: "cleanup-job",
        title: "启动 1.21.4",
        status: "running",
        currentStep: 6,
        log: [],
        steps: [
          "检查游戏与 Java",
          "检查资源索引",
          "补全游戏文件",
          "准备运行环境",
          "启动前命令",
          "游戏运行",
          "退出后命令",
        ].map((name, index) => ({
          name,
          status: index === 6 ? "running" : "completed",
          detail: "",
        })),
        launch: {
          versionId: "1.21.4",
          gameVersion: "1.21.4",
          playerName: "Alex",
          directory: "C:/Pixel-Test/Minecraft",
          running: false,
        },
        gameExit: { code: 0, reason: "normal" },
        commandRuns: {
          preLaunch: {
            status: "completed",
            exitCode: 0,
            durationMs: 100,
            error: null,
          },
          postExit: {
            status: "running",
            exitCode: null,
            durationMs: 0,
            error: null,
          },
        },
      },
    ];
  });
  await nav("开始游戏");
  await expect(
    page.getByRole("button", { name: "停止命令", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: /^下载中心：/ }).click();
  const stop = page.getByRole("button", {
    name: "停止命令 启动 1.21.4",
    exact: true,
  });
  await expect(stop).toBeVisible();
  await stop.click();
  expect(
    await page.evaluate(() =>
      window.__pixelTest.requests.some(
        (request) =>
          request.operation === "jobs.cancel" &&
          request.payload.id === "cleanup-job",
      ),
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await writeFile(
    evidence + "/result.json",
    JSON.stringify(
      {
        status: "passed",
        checks: [
          "default disabled",
          "incomplete input",
          "auto-save",
          "multiline",
          "shell selection",
          "timeout validation",
          "global inheritance",
          "independent disable",
          "dormant override",
          "responsive layout",
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log("Launch command settings UI checks passed.");
} finally {
  await browser.close();
}
