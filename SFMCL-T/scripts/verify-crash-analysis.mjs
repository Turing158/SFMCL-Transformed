import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("evidence/crash-analysis");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
});
const page = await browser.newPage({ viewport: { width: 1120, height: 720 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(8000);
await page.addInitScript(pixelAppFixture);
await page.addInitScript(() => {
  const test = window.__pixelTest;
  test.data.settings.downloadTaskDisplay = "always";
  const invoke = window.__TAURI_INTERNALS__.invoke;
  test.acknowledged = [];
  test.openedLogs = [];
  test.failLogOpen = false;
  test.fail = (id, status = "failed", acknowledged = false) => {
    const job = {
      id,
      title: `启动 ${id}`,
      createdAt: Date.now() / 1000,
      status,
      steps: [{ name: "游戏运行", detail: "Minecraft", status }],
      currentStep: 0,
      log: ["fixture log"],
      error: status === "failed" ? "Java 进程退出，错误码 1" : undefined,
      launch: {
        versionId: id,
        gameVersion: "1.20.1",
        directory: "C:/Pixel-Test/Minecraft",
        playerName: "Alex",
        running: false,
      },
      crashReport: {
        category: "missing-dependency",
        title: "缺少前置模组 Fabric API",
        description:
          "Continuity 需要 Fabric API 才能运行，但当前实例未安装该依赖。",
        suggestions: [
          "安装适用于当前 Minecraft 版本和加载器的 Fabric API。",
          "将模组放入当前实例的 mods 文件夹，然后重新启动游戏。",
        ],
        exitCode: 1,
        logPath: "C:/Pixel-Test/latest.log",
        acknowledged,
      },
    };
    test.tasks.jobs.unshift(job);
  };
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "request" && args.operation === "crash.openLog") {
      if (test.failLogOpen)
        throw new Error("本次日志已不存在，无法打开所在位置");
      test.openedLogs.push(args.payload.id);
      return true;
    }
    if (command === "request" && args.operation === "crash.acknowledge") {
      test.acknowledged.push(args.payload.id);
      const job = test.tasks.jobs.find((job) => job.id === args.payload.id);
      if (job) job.crashReport.acknowledged = true;
      return true;
    }
    return invoke(command, args);
  };
});
const dialog = page.getByRole("dialog", { name: "崩溃原因分析", exact: true });
try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1421/");
  await expect(page.locator(".app")).toBeVisible();
  await page.evaluate(() => {
    window.__pixelTest.fail("normal", "completed");
    window.__pixelTest.fail("cancelled", "cancelled");
    window.__pixelTest.fail("acknowledged", "failed", true);
  });
  await page.waitForTimeout(1000);
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => window.__pixelTest.fail("我的生存世界"));
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/has-surface modal/);
  await expect(dialog.locator(":scope > .surface-frame")).toHaveCount(1);
  await expect(
    dialog.getByRole("heading", { name: "缺少前置模组 Fabric API" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "确认", exact: true }),
  ).toBeFocused();
  await expect(dialog.locator("details, pre")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "复制报告", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "前往资源下载", exact: true }),
  ).toHaveCount(0);
  await expect(dialog.locator(".dialog-actions button")).toHaveCount(2);
  await dialog
    .getByRole("button", { name: "前往日志所在位置", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__pixelTest.openedLogs))
    .toEqual(["我的生存世界"]);
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: `${evidence}/light.png` });
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await page.screenshot({ path: `${evidence}/dark.png` });
  await page.evaluate(() => (window.__pixelTest.failLogOpen = true));
  await dialog
    .getByRole("button", { name: "前往日志所在位置", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("本次日志已不存在");
  await page.evaluate(() => window.__pixelTest.fail("第二个游戏"));
  await expect(dialog).toHaveCount(1);
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__pixelTest.acknowledged))
    .toContain("我的生存世界");
  await expect(dialog.locator(".crash-analysis-meta")).toContainText(
    "第二个游戏",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.waitForTimeout(1000);
  await expect(dialog).toHaveCount(0);
  // A crash arriving while another existing Modal is open must wait its turn.
  await page.evaluate(async () => {
    void (await import("/src/confirmation.ts")).confirmAction(
      "保留当前确认操作",
    );
  });
  const confirmation = page.getByRole("dialog", {
    name: "确认操作",
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  await page.evaluate(() => window.__pixelTest.fail("等待确认关闭的游戏"));
  await page.waitForTimeout(800);
  await expect(dialog).toHaveCount(0);
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(async () => {
    window.__pixelTest.failLogOpen = false;
  });
  await page.getByRole("button", { name: /^下载中心：/ }).click();
  await page
    .getByRole("button", {
      name: "查看 启动 我的生存世界 崩溃分析",
      exact: true,
    })
    .click();
  await expect(dialog).toBeVisible();
  await page.setViewportSize({ width: 600, height: 600 });
  const fits = await dialog.evaluate(
    (element) =>
      element.scrollWidth <= element.clientWidth &&
      element.getBoundingClientRect().right <= innerWidth,
  );
  expect(fits).toBe(true);
  await page.screenshot({ path: `${evidence}/compact.png` });
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/result.json`,
    JSON.stringify(
      {
        passed: true,
        errors,
        checks: [
          "existing Modal and PixelFrame",
          "confirmed body and two actions",
          "normal/cancelled/acknowledged suppression",
          "log location and local error",
          "queue and existing dialog coordination",
          "confirm/Escape dismissal",
          "reopen from tasks",
          "light/dark/compact",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS crash analysis UI, lifecycle, log actions and existing Modal reuse",
  );
} finally {
  await browser.close();
}
