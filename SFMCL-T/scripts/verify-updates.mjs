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
const currentContent = button.locator(
  '.update-check-content > span:not([aria-hidden="true"])',
);
const expectSwapMotion = async () => {
  await expect(currentContent).toHaveClass(/animated-swap-in/);
  await expect(currentContent).toHaveCSS("animation-name", "swap-in");
  await expect(currentContent).toHaveCSS("animation-duration", "0.22s");
};
const finish = (result, error) =>
  page.evaluate(
    ({ result, error }) => window.__updateTest.finish(result, error),
    { result, error },
  );
const shot = async (name) => {
  await expect(state.locator("p")).toHaveCount(0);
  await expect(state.getByRole("button")).toHaveCount(1);
  await page.locator(".about-card").scrollIntoViewIfNeeded();
  await page
    .locator(".about-card")
    .screenshot({ path: `${evidence}/${name}.png`, animations: "disabled" });
};
const available = {
  status: "available",
  currentVersion: "1.0.4",
  latestVersion: "1.1.0",
  htmlUrl: "https://github.com/Turing158/SFMCL-Transformed/releases/tag/v1.1.0",
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await page.getByRole("tab", { name: "关于", exact: true }).click();
  await expect(button).toHaveAccessibleName("检测更新");
  await expect(button).toBeEnabled();
  await shot("idle-light");

  await button.click();
  await expect(button).toHaveAccessibleName("检测中…");
  await expectSwapMotion();
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute("aria-busy", "true");
  await expect(currentContent.locator("svg")).toHaveClass(/spin/);
  await button.evaluate((element) => element.click());
  expect(await page.evaluate(() => window.__updateTest.calls)).toBe(1);
  await shot("checking-light");

  // A result survives switching tabs while the request is pending.
  await page.getByRole("tab", { name: "启动器设置", exact: true }).click();
  await finish({
    status: "latest",
    currentVersion: "1.0.4",
    latestVersion: "1.0.4",
  });
  await page.getByRole("tab", { name: "关于", exact: true }).click();
  await expect(button).toHaveAccessibleName("无需更新");
  await expect(button).toBeEnabled();
  await shot("latest-light");
  const restingBounds = await button.boundingBox();
  await button.hover();
  await expect(button).toHaveAccessibleName("重新检测");
  expect(await button.boundingBox()).toEqual(restingBounds);
  await shot("latest-hover-light");

  // Keep hovering through completion: the result must be readable before retry.
  await button.click();
  await expect(state).toHaveAttribute("data-update-state", "checking");
  await finish({
    status: "latest",
    currentVersion: "1.0.4",
    latestVersion: "1.0.4",
  });
  await expect(state).toHaveAttribute("data-update-state", "latest");
  await expect(button).toHaveAccessibleName("无需更新");
  await expectSwapMotion();
  await page.waitForTimeout(650);
  await expect(button).toHaveAccessibleName("无需更新");
  expect(await button.boundingBox()).toEqual(restingBounds);
  await shot("latest-hover-result-light");
  await expect(button).toHaveAccessibleName("重新检测");
  await expectSwapMotion();
  expect(await button.boundingBox()).toEqual(restingBounds);
  await page.mouse.move(0, 0);
  await expect(button).toHaveAccessibleName("无需更新");
  await expectSwapMotion();

  // This control keeps its full animation even with a reduced-motion preference.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await button.hover();
  await expect(button).toHaveAccessibleName("重新检测");
  await expectSwapMotion();
  await page.mouse.move(0, 0);
  await expect(button).toHaveAccessibleName("无需更新");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // Keyboard users get the same retry action, without a second button.
  await page.getByRole("tab", { name: "关于", exact: true }).focus();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    if (await button.evaluate((element) => document.activeElement === element))
      break;
  }
  await expect(button).toBeFocused();
  await expect(button).toHaveAccessibleName("重新检测");
  await page.keyboard.press("Enter");
  await expect(state).toHaveAttribute("data-update-state", "checking");
  await expect(button).toBeDisabled();
  await finish({
    status: "latest",
    currentVersion: "1.0.4",
    latestVersion: "1.0.4",
  });
  await page.getByRole("tab", { name: "关于", exact: true }).focus();
  await expect(button).toHaveAccessibleName("无需更新");

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await shot("latest-dark");

  await button.hover();
  await expect(button).toHaveAccessibleName("重新检测");
  await button.click();
  await expect(state).toHaveAttribute("data-update-state", "checking");
  await finish({ status: "unpublished", currentVersion: "1.0.4" });
  await expect(button).toHaveAccessibleName("暂无发布");
  await expectSwapMotion();
  await page.mouse.move(0, 0);
  await expect(button).toHaveAccessibleName("暂无发布");
  await expect(button).toBeEnabled();
  await shot("unpublished-dark");

  await button.hover();
  await expect(button).toHaveAccessibleName("重新检测");
  await button.click();
  await expect(state).toHaveAttribute("data-update-state", "checking");
  await finish(null, "检测更新超时，请稍后重试");
  await expect(button).toHaveAccessibleName("检测失败，重试");
  await expectSwapMotion();
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
  await expect(button).toHaveAccessibleName("下载更新 v1.1.0");
  await expectSwapMotion();
  await expect(button).toBeEnabled();
  await expect(button).toHaveClass(/primary/);
  await shot("available-dark");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await shot("available-light");
  await button.click();
  await expect
    .poll(() => page.evaluate(() => window.__updateTest.opened))
    .toEqual([available.htmlUrl]);
  await page.evaluate(() => {
    window.__updateTest.openError = "测试浏览器打开失败";
  });
  await button.click();
  await expect(button).toHaveAccessibleName("打开失败，重试");
  await expectSwapMotion();
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
  await expect(button).toHaveAccessibleName("下载更新 v1.1.0");
  expect(await page.evaluate(() => window.__updateTest.calls)).toBe(6);
  expect(errors).toEqual([]);
  console.log(
    "Update button checks passed: readable result before hovered retry, full state animations, single control, hover/focus labels without layout shift, keyboard retry, states, duplicate clicks, tab retention, release link, and open failure.",
  );
  console.log(`Screenshots: ${evidence}`);
} finally {
  await browser.close();
}
