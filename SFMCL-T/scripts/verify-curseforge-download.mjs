import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { runtimePath } from "./lib/paths.mjs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";

const evidence = runtimePath("evidence/curseforge-download");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(8000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(resourceCenterFixture);
await page.addInitScript(() => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    const result = await invoke(command, args);
    if (command !== "request" || args.operation !== "resources.files")
      return result;
    return [
      {
        ...result[0],
        id: "1234567",
        name: "缺少 API 直链的版本",
        file: {
          ...result[0].file,
          url: "https://www.curseforge.com/api/v1/mods/306612/files/1234567/download",
        },
      },
      { ...result[0], id: "missing", name: "缺少文件信息的版本", file: null },
    ];
  };
});

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "资源中心", exact: true })
    .click();
  await page.getByRole("tab", { name: "模组", exact: true }).click();
  await page.getByRole("combobox", { name: "资源来源", exact: true }).click();
  await page.getByRole("option", { name: "CurseForge", exact: true }).click();
  await page.locator(".catalog-project-info").first().click();
  await page.getByRole("tab", { name: /^可下载版本/ }).click();
  const item = page.getByRole("button", {
    name: "选择 缺少 API 直链的版本 的下载位置",
    exact: true,
  });
  await expect(item).toBeEnabled();
  await expect(item).toContainText("2.0 KB");
  await expect(page.getByText("作者未开放下载")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /缺少文件信息的版本，暂时无法下载/ }),
  ).toBeDisabled();
  await item.click();
  const dialog = page.getByRole("dialog", { name: "下载 Sodium", exact: true });
  await page.evaluate(() => {
    window.__pixelTest.delays["resources.download"] = 1000;
    window.__pixelTest.failures["resources.download"] =
      "获取 CurseForge 下载地址超时，请到项目官网下载";
  });
  await dialog.getByRole("button", { name: "开始下载", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "正在准备下载…", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "取消", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: `${evidence}/preparing.png`,
    animations: "disabled",
  });
  await expect(
    dialog.getByRole("button", { name: "开始下载", exact: true }),
  ).toBeEnabled();
  await expect(dialog.getByRole("alert")).toContainText(
    "获取 CurseForge 下载地址超时",
  );
  await expect(dialog).toBeVisible();

  await page.evaluate(() => {
    delete window.__pixelTest.failures["resources.download"];
    window.__pixelTest.resources.selectedDirectory = "C:/Pixel-Test/Downloads";
  });
  await dialog.getByRole("tab", { name: "下载到文件夹", exact: true }).click();
  await dialog.getByRole("button", { name: "选择文件夹", exact: true }).click();
  await dialog.getByRole("button", { name: "开始下载", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const requests = await page.evaluate(() =>
    window.__pixelTest.requests.filter(
      (request) => request.operation === "resources.download",
    ),
  );
  expect(requests).toHaveLength(2);
  expect(requests[0].payload.versionId).toBeTruthy();
  expect(requests[1].payload.directory).toBe("C:/Pixel-Test/Downloads");
  expect(requests[1].payload.file.url).toBe(
    "https://www.curseforge.com/api/v1/mods/306612/files/1234567/download",
  );
  await expect(item).toBeFocused();
  expect(errors).toEqual([]);
  const report = {
    checks: [
      "fallback version selectable with file size",
      "missing metadata label",
      "preparing and duplicate-submit prevention",
      "failure keeps dialog retryable",
      "retry to selected folder",
      "original website entry preserved",
      "focus restored",
    ],
    errors,
  };
  await writeFile(`${evidence}/checks.json`, JSON.stringify(report, null, 2));
  console.log(`Passed ${report.checks.length} CurseForge fallback UI checks.`);
} finally {
  await browser.close();
}
