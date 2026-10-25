import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { runtimePath } from "./lib/paths.mjs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";

const evidence = runtimePath("evidence/modpacks");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
const errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(resourceCenterFixture);
await page.addInitScript(() => {
  const base = window.__TAURI_INTERNALS__.invoke;
  const state = window.__pixelTest;
  state.packFail = false;
  state.data.settings.downloadTaskDisplay = "always";
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "request" && args.operation === "downloads.files") {
      return [
        {
          spec: {
            url: "https://example.com/mod.jar",
            path: "versions/Pack/mods/mod.jar",
            size: 12,
            sha1: "0123456789012345678901234567890123456789",
          },
          status: "failed",
          downloaded: 0,
          total: 12,
          attempts: 3,
          error: "作者限制下载",
        },
      ];
    }
    if (command === "request" && args.operation.startsWith("modpacks.")) {
      state.requests.push(structuredClone(args));
      if (args.operation === "modpacks.inspect") {
        if (state.packFail)
          throw new Error("这是服务端整合包，请使用客户端导出包");
        return {
          token: "pack-preview",
          format: "Modrinth",
          name: "探索整合包",
          version: "1.0",
          minecraft: "1.20.1",
          loader: { kind: "Fabric", version: "0.16.9" },
          optionalFiles: ["mods/optional.jar"],
          fileCount: 2,
        };
      }
      return args.operation === "modpacks.install" ? "pack-job" : true;
    }
    return base(command, args);
  };
});
const nav = async (name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const last = async (operation) =>
  page.evaluate(
    (operation) =>
      window.__pixelTest.requests.findLast(
        (request) => request.operation === operation,
      )?.payload,
    operation,
  );
const dialog = () => page.getByRole("dialog");
const settleDialog = async () => {
  await expect(dialog()).toBeVisible();
  await dialog().evaluate(async (element) => {
    await Promise.allSettled(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
};
try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await nav("资源中心");
  await page.getByRole("tab", { name: "整合包", exact: true }).click();
  await expect(
    page.locator(".resource-center").getByRole("button", {
      name: "导入整合包",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect
    .poll(async () => (await last("resources.search"))?.kind)
    .toBe("modpack");
  checks.push("The resource-center modpack toolbar omits local import.");
  await nav("版本管理");
  await page.getByRole("button", { name: "导入整合包", exact: true }).click();
  await expect(dialog().getByLabel("整合包文件", { exact: true })).toHaveText(
    "选择压缩包或客户端目录",
  );
  await expect(
    dialog().getByRole("textbox", { name: "整合包文件" }),
  ).toHaveCount(0);
  await expect(
    dialog().getByRole("button", { name: "开始安装" }),
  ).toBeDisabled();
  await page.evaluate(() => {
    window.__pixelTest.resources.selectedDirectory = "C:/Packs/example.mrpack";
  });
  await dialog().getByRole("button", { name: "选择压缩包" }).click();
  await expect(dialog().getByLabel("整合包文件", { exact: true })).toHaveText(
    "C:/Packs/example.mrpack",
  );
  await expect(dialog().getByText("Modrinth", { exact: true })).toBeVisible();
  await expect(
    dialog().getByRole("textbox", { name: "整合包游戏名称" }),
  ).toHaveValue("探索整合包 1.0");
  await dialog()
    .getByRole("textbox", { name: "整合包游戏名称" })
    .fill("../bad");
  await expect(
    dialog().getByRole("button", { name: "开始安装" }),
  ).toBeDisabled();
  await dialog()
    .getByRole("textbox", { name: "整合包游戏名称" })
    .fill("探索整合包 1.0");
  await dialog()
    .getByRole("checkbox", { name: "安装附加模组和材质包等等（1 个）" })
    .check();
  await settleDialog();
  await page.screenshot({ path: `${evidence}/local-import.png` });
  await dialog().getByRole("button", { name: "开始安装" }).click();
  await expect(dialog()).toHaveCount(0);
  expect(await last("modpacks.install")).toMatchObject({
    token: "pack-preview",
    name: "探索整合包 1.0",
    includeOptional: true,
  });
  checks.push(
    "Local import previews format and dependencies, validates names and submits optional-file selection.",
  );

  await nav("资源中心");
  await page
    .getByRole("button", { name: "查看 Sodium 详情", exact: true })
    .click();
  await page.getByRole("tab", { name: /可下载版本/ }).click();
  await page
    .getByRole("button", {
      name: "选择 兼容文件 1.20.1 的下载位置",
      exact: true,
    })
    .click();
  await expect(dialog().getByRole("tab", { name: "安装新实例" })).toBeVisible();
  await expect(
    dialog().getByRole("combobox", { name: "本地游戏版本" }),
  ).toHaveCount(0);
  await dialog()
    .getByRole("textbox", { name: "整合包游戏名称" })
    .fill("在线整合包");
  await settleDialog();
  await page.screenshot({ path: `${evidence}/online-install.png` });
  await dialog().getByRole("button", { name: "开始安装" }).click();
  await expect(dialog()).toHaveCount(0);
  expect(await last("modpacks.install")).toMatchObject({
    name: "在线整合包",
    file: { path: "test-0.zip" },
    includeOptional: false,
  });
  checks.push(
    "Online packs create a new instance rather than selecting an existing game version.",
  );
  await page
    .getByRole("button", {
      name: "选择 兼容文件 1.20.1 的下载位置",
      exact: true,
    })
    .click();
  await dialog().getByRole("tab", { name: "下载到文件夹" }).click();
  await page.evaluate(() => {
    window.__pixelTest.resources.selectedDirectory = "C:/Packs/Downloads";
  });
  await dialog().getByRole("button", { name: "选择文件夹" }).click();
  await dialog().getByRole("button", { name: "开始下载" }).click();
  await expect(dialog()).toHaveCount(0);
  expect(await last("resources.download")).toMatchObject({
    kind: "modpack",
    directory: "C:/Packs/Downloads",
    file: { path: "test-0.zip" },
  });
  checks.push(
    "Download-only preserves the original archive and selected destination.",
  );

  await nav("版本管理");
  await page.getByRole("button", { name: "导入整合包", exact: true }).click();
  await page.evaluate(() => {
    window.__pixelTest.resources.selectedDirectory = "C:/Packs/Client";
  });
  await dialog().getByRole("button", { name: "选择客户端目录" }).click();
  await expect(dialog().getByLabel("整合包文件", { exact: true })).toHaveText(
    "C:/Packs/Client",
  );
  await dialog().getByRole("button", { name: "取消", exact: true }).click();
  await expect
    .poll(async () => (await last("modpacks.discard"))?.token)
    .toBe("pack-preview");
  checks.push(
    "Version management exposes local directory import and releases previews when closed.",
  );
  await page.getByRole("button", { name: "导入整合包", exact: true }).click();
  await page.evaluate(() => {
    window.__pixelTest.packFail = true;
  });
  await dialog().getByRole("button", { name: "选择压缩包" }).click();
  await expect(
    dialog().getByRole("button", { name: "开始安装" }),
  ).toBeDisabled();
  await expect(dialog().getByText(/这是服务端整合包/)).toBeVisible();
  await dialog().getByRole("button", { name: "取消", exact: true }).click();
  checks.push(
    "Unsupported/server exports report the reason without allowing installation.",
  );
  await page.evaluate(() => {
    window.__pixelTest.data.settings.downloadTaskDisplay = "always";
    window.__pixelTest.tasks.jobs = [
      {
        id: "pack-job",
        title: "安装整合包 Pack",
        status: "failed",
        currentStep: 8,
        steps: [
          { name: "下载整合包内容", status: "failed", detail: "等待文件" },
        ],
        downloadId: "pack-download",
        log: [],
      },
    ];
    window.__pixelTest.tasks.downloads = [
      {
        id: "pack-download",
        title: "Pack · 整合包内容",
        status: "failed",
        downloaded: 0,
        total: 12,
        unknownSize: false,
        completed: 0,
        failed: 1,
        fileCount: 1,
        speed: 0,
        workers: 0,
        steps: [],
        error: "作者限制下载",
      },
    ];
    window.__pixelTest.resources.selectedDirectory = "C:/Downloads/mod.jar";
  });
  await nav("资源中心");
  await page
    .getByRole("button", { name: /下载中心/, exact: false })
    .first()
    .click();
  await page.getByRole("button", { name: "查看文件", exact: true }).click();
  await dialog()
    .getByRole("button", { name: "补选已下载文件", exact: true })
    .click();
  await expect
    .poll(async () => (await last("modpacks.supplyFile"))?.source)
    .toBe("C:/Downloads/mod.jar");
  expect(await last("modpacks.supplyFile")).toMatchObject({
    id: "pack-download",
    path: "versions/Pack/mods/mod.jar",
  });
  await dialog().getByRole("button", { name: "关闭对话框" }).click();
  checks.push(
    "Blocked pack dependencies expose manual-file selection with the recorded file path.",
  );
  await page.evaluate(() => {
    window.__pixelTest.packFail = false;
  });

  await page.setViewportSize({ width: 850, height: 600 });
  await nav("资源中心");
  await page
    .getByRole("navigation", { name: "页面路径" })
    .getByRole("button", { name: "返回上一级", exact: true })
    .click();
  await page.getByRole("tab", { name: "整合包", exact: true }).click();
  await expect(
    page.locator(".resource-center").getByRole("button", {
      name: "导入整合包",
      exact: true,
    }),
  ).toHaveCount(0);
  await nav("版本管理");
  await page.getByRole("button", { name: "导入整合包", exact: true }).click();
  const longPath =
    "C:/Packs/" + "很长的整合包目录".repeat(20) + "/example.mrpack";
  await page.evaluate((path) => {
    window.__pixelTest.resources.selectedDirectory = path;
  }, longPath);
  await dialog().getByRole("button", { name: "选择压缩包" }).click();
  await expect(dialog().getByLabel("整合包文件", { exact: true })).toHaveText(
    longPath,
  );
  expect(
    await dialog()
      .getByLabel("整合包文件", { exact: true })
      .evaluate(
        (element) =>
          element.tagName === "P" &&
          element.scrollWidth <= element.clientWidth + 1 &&
          getComputedStyle(element).userSelect === "text",
      ),
  ).toBe(true);
  await settleDialog();
  await page.screenshot({ path: `${evidence}/compact-import.png` });
  expect(
    await dialog()
      .getByRole("button", { name: "开始安装" })
      .evaluate((button) => {
        const rect = button.getBoundingClientRect();
        return rect.bottom <= innerHeight - 24;
      }),
  ).toBe(true);
  expect(
    await dialog().evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  checks.push(
    "The import dialog fits the minimum 850 × 600 viewport without horizontal overflow.",
  );
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
