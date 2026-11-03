import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("evidence/updates");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 720 } });
page.setDefaultTimeout(8000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(() => {
  window.__updateTest = { calls: 0, opened: [], openError: "" };
  const base = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    const test = window.__updateTest;
    if (command === "request" && args.operation === "updates") {
      test.calls++;
      return new Promise((resolve, reject) => {
        test.finish = (result, error) =>
          error ? reject(error) : resolve(result);
      });
    }
    if (command === "plugin:opener|open_url") {
      if (test.openError) throw new Error(test.openError);
      test.opened.push(args.url);
      return;
    }
    return base(command, args);
  };
});

const button = page.locator(".update-check-button");
const state = page.locator(".update-check");
const finish = (result, error) =>
  page.evaluate(
    ({ result, error }) => window.__updateTest.finish(result, error),
    { result, error },
  );
const shot = async (name) => {
  await expect(state.locator("p")).toHaveCount(0);
  await page.locator(".about-card").scrollIntoViewIfNeeded();
  await page
    .locator(".about-card")
    .screenshot({ path: `${evidence}/${name}.png`, animations: "disabled" });
};
const available = {
  status: "available",
  currentVersion: "0.1.0",
  latestVersion: "0.2.0",
  htmlUrl: "https://github.com/Turing158/SFMCL-Transformed/releases/tag/v0.2.0",
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await page.getByRole("tab", { name: "关于", exact: true }).click();
  await expect(button).toHaveText("检测更新");
  await expect(button).toBeEnabled();
  await shot("idle-light");

  await button.click();
  await expect(button).toHaveText("检测中…");
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute("aria-busy", "true");
  await expect(button.locator("svg")).toHaveClass(/spin/);
  await button.evaluate((element) => element.click());
  expect(await page.evaluate(() => window.__updateTest.calls)).toBe(1);
  await shot("checking-light");

  // A result survives switching tabs while the request is pending.
  await page.getByRole("tab", { name: "启动器设置", exact: true }).click();
  await finish(available);
  await page.getByRole("tab", { name: "关于", exact: true }).click();
  await expect(button).toHaveText("下载更新 v0.2.0");
  await expect(button).toBeEnabled();
  await expect(button).toHaveClass(/primary/);
  await shot("available-light");
  await button.click();
  await expect
    .poll(() => page.evaluate(() => window.__updateTest.opened))
    .toEqual([available.htmlUrl]);
  expect(await page.evaluate(() => window.__updateTest.calls)).toBe(1);

  await page.evaluate(() => {
    window.__updateTest.openError = "测试浏览器打开失败";
  });
  await button.click();
  await expect(button).toHaveText("打开失败，重试");
  await expect(button).toHaveClass(/danger/);
  await expect(button).toBeEnabled();
  await expect(state).toHaveAttribute("data-update-state", "available");
  await page.evaluate(() => {
    window.__updateTest.openError = "";
  });
  await button.click();
  await expect
    .poll(() => page.evaluate(() => window.__updateTest.opened.length))
    .toBe(2);
  await expect(button).toHaveText("下载更新 v0.2.0");

  await state.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(button).toBeDisabled();
  await finish({
    status: "latest",
    currentVersion: "0.1.0",
    latestVersion: "0.1.0",
  });
  await expect(button).toHaveText("已是最新版本");
  await expect(button).toBeDisabled();
  await shot("latest-light");

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await shot("latest-dark");

  await state.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(state).toHaveAttribute("data-update-state", "checking");
  await finish({ status: "unpublished", currentVersion: "0.1.0" });
  await expect(button).toHaveText("暂无发布");
  await expect(button).toBeDisabled();
  await shot("unpublished-dark");

  await state.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(state).toHaveAttribute("data-update-state", "checking");
  await finish(null, "检测更新超时，请稍后重试");
  await expect(button).toHaveText("检测失败，重试");
  await expect(button).toBeEnabled();
  await expect(button).toHaveClass(/danger/);
  await expect(button).toHaveAttribute(
    "aria-description",
    "检测更新超时，请稍后重试",
  );
  await shot("failed-dark");

  await button.click();
  await expect(state).toHaveAttribute("data-update-state", "checking");
  await finish(available);
  await expect(button).toHaveText("下载更新 v0.2.0");
  await shot("available-dark");
  expect(await page.evaluate(() => window.__updateTest.calls)).toBe(5);
  expect(errors).toEqual([]);
  console.log(
    "Update button checks passed: states, duplicate clicks, tab retention, release link, open failure, and retry.",
  );
  console.log(`Screenshots: ${evidence}`);
} finally {
  await browser.close();
}
