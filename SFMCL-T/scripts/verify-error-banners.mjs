import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";
import { installComponentsFixture } from "./fixtures/install-components.mjs";

const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/";
const evidence = process.env.SFMCL_T_TEST_ARTIFACT_DIR;
if (evidence) await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 740 } });
page.setDefaultTimeout(8000);
const errors = [],
  checks = [],
  motions = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(resourceCenterFixture);
await page.addInitScript(installComponentsFixture);
await page.addInitScript(() => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "request" && args.operation === "multiplayer.status")
      return {
        state: "idle",
        sessionId: null,
        componentReady: true,
        componentVersion: "2.6.4",
        tunnelReady: false,
        tunnelVersion: "2026.10.7",
        componentJobId: null,
        role: null,
        name: "",
        gameVersion: "",
        address: null,
        worldOpen: false,
        members: [],
        error: null,
      };
    return invoke(command, args);
  };
});
const message = "版本名称已存在，请选择其他名称";
const nav = (name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const report = (message) =>
  page.evaluate(
    (message) => window.__notificationTest.reportError(message),
    message,
  );
const clear = () => page.evaluate(() => window.__notificationTest.clearError());
const settle = (banner) =>
  banner.evaluate((element) =>
    Promise.allSettled(
      element.getAnimations().map((animation) => animation.finished),
    ),
  );
const sample = async (banner, opening) => {
  await expect(banner).toHaveAttribute("data-open", String(opening));
  const motion = await banner.evaluate((element) => {
    const animations = element
      .getAnimations()
      .filter((animation) => animation.effect.getTiming().duration > 0);
    const height = animations.find(
      (animation) => animation.transitionProperty === "grid-template-rows",
    );
    if (!height)
      throw new Error(
        "Missing error banner appearance/disappearance animation",
      );
    animations.forEach((animation) => animation.pause());
    const samples = [0, 0.5, 1].map((progress) => {
      animations.forEach((animation) => {
        animation.currentTime =
          animation.effect.getTiming().duration * progress;
      });
      const style = getComputedStyle(element);
      return {
        height: element.getBoundingClientRect().height,
        opacity: Number(style.opacity),
        y: new DOMMatrix(style.transform).m42,
      };
    });
    animations.forEach((animation) => animation.finish());
    return { duration: height.effect.getTiming().duration, samples };
  });
  expect(motion.duration).toBe(300);
  const [start, middle, end] = opening
    ? motion.samples
    : [...motion.samples].reverse();
  expect(start.height).toBeLessThanOrEqual(1);
  expect(middle.height).toBeGreaterThan(start.height);
  expect(middle.height).toBeLessThan(end.height);
  expect(start.opacity).toBe(0);
  expect(middle.opacity).toBeGreaterThan(0);
  expect(middle.opacity).toBeLessThan(1);
  expect(end.opacity).toBe(1);
  expect(start.y).toBe(-10);
  expect(middle.y).toBeGreaterThan(-10);
  expect(middle.y).toBeLessThan(0);
  expect(end.y).toBe(0);
  motions.push({ opening, ...motion });
  await settle(banner);
  await expect(banner).toBeVisible({ visible: opening });
  if (!opening) await expect(banner).toHaveAttribute("hidden", "");
};
const shot = async (name, target = page) => {
  if (evidence) await target.screenshot({ path: `${evidence}/${name}.png` });
};

try {
  await page.goto(new URL("scripts/fixtures/notifications.html", url).href);
  await page.waitForFunction(() => !!window.__notificationTest);
  await nav("资源中心");
  await page
    .getByRole("button", {
      name: "查看 Minecraft 1.20.1 安装配置",
      exact: true,
    })
    .click();
  const body = page.locator("main.page .resource-subpage-body");
  await expect(body).toBeVisible();
  const formOffset = () =>
    body.evaluate(
      (element) =>
        element.querySelector("form").getBoundingClientRect().top -
        element.getBoundingClientRect().top,
    );
  const baseline = await formOffset();
  await nav("联机");
  await page.getByRole("textbox", { name: "游戏端口", exact: true }).fill("");
  await page.getByRole("button", { name: "检查端口", exact: true }).click();
  const portError = "请输入 1–65535 之间的整数端口";
  await expect(
    page.locator(".notification-slot").first().getByRole("alert"),
  ).toHaveText(portError);
  await nav("资源中心");
  await expect(body).toBeVisible();
  await expect(body.locator(":scope > .error-banner")).toHaveCount(0);
  expect(await formOffset()).toBeCloseTo(baseline, 0);
  await shot("resource-after-port-check");
  checks.push(
    "An invalid multiplayer port remains a notification; returning to the retained Minecraft details adds no global error banner or layout space",
  );

  await page.evaluate(
    (message) => (window.__pixelTest.failures.install = message),
    message,
  );
  await page.getByRole("button", { name: "开始安装", exact: true }).click();
  await expect(
    page.locator(".notification-slot").first().getByRole("alert"),
  ).toContainText(message);
  await expect(body.locator(":scope > .error-banner")).toHaveCount(0);
  expect(await formOffset()).toBeCloseTo(baseline, 0);
  await shot("installation-error");
  checks.push(
    "Installation failures use the notification deck without inserting a global error banner into resource details",
  );
  await clear();

  await nav("版本管理");
  await report(message);
  await page
    .getByRole("button", { name: "管理 1.20.1-Fabric", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const dialogBanner = dialog.locator(".modal-body > .error-banner");
  const banner = dialogBanner;
  await sample(banner, true);
  await expect(banner.getByRole("alert")).toHaveText(message);
  await banner
    .getByRole("button", { name: "关闭错误提示", exact: true })
    .click();
  await sample(banner, false);
  await report(message);
  await sample(banner, true);
  await clear();
  await sample(banner, false);
  checks.push(
    "Dialog errors enter smoothly; click and programmatic clear retain the text during exit and remove all layout space afterward",
  );

  await report(message);
  await sample(banner, true);
  await clear();
  await expect(banner).toHaveAttribute("data-open", "false");
  const before = await banner.evaluate((element) => {
    element.getAnimations().forEach((animation) => {
      if (animation.effect.getTiming().duration > 0) {
        animation.pause();
        animation.currentTime = animation.effect.getTiming().duration * 0.25;
      }
    });
    return element.getBoundingClientRect().height;
  });
  await report("新的错误提示");
  await expect(banner).toHaveAttribute("data-open", "true");
  const reversal = await banner.evaluate((element) => {
    const animations = element.getAnimations();
    animations.forEach((animation) => {
      if (animation.effect.getTiming().duration > 0) {
        animation.pause();
        animation.currentTime = 0;
      }
    });
    const start = element.getBoundingClientRect().height;
    animations.forEach((animation) => animation.finish());
    return start;
  });
  expect(reversal).toBeCloseTo(before, 0);
  await settle(banner);
  await expect(banner.getByRole("alert")).toHaveText("新的错误提示");
  await clear();
  await sample(banner, false);
  checks.push(
    "A new error reverses an unfinished exit from its current frame; stale completion does not hide it",
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  await report(message);
  await sample(banner, true);
  await clear();
  await sample(banner, false);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  checks.push(
    "Reduced-motion preference retains the complete 300 ms height/translation and 220 ms fade animations",
  );

  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    for (const width of [375, 768, 1120]) {
      await page.setViewportSize({ width, height: 740 });
      await report("无法读取文件：C:/" + "Minecraft-资源目录/".repeat(12));
      await sample(dialogBanner, true);
      expect(
        await dialogBanner.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
      await shot(`dialog-${theme}-${width}`, dialogBanner);
      await clear();
      await sample(dialogBanner, false);
    }
  }
  await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  checks.push(
    "A dialog mounted with an existing error animates immediately; long errors wrap in light/dark themes at 375/768/1120 px and close normally",
  );

  await page.setViewportSize({ width: 1120, height: 740 });
  await page.evaluate(
    () =>
      (window.__pixelTest.failures["resources.local"] = "读取资源失败，请重试"),
  );
  await page
    .getByRole("button", { name: "查看 1.20.1-Fabric 本地资源", exact: true })
    .click();
  const retryBanner = page.locator("main.page .local-resources .error-banner");
  await sample(retryBanner, true);
  await page.evaluate(
    () => delete window.__pixelTest.failures["resources.local"],
  );
  await retryBanner.getByRole("button", { name: "重试", exact: true }).click();
  await sample(retryBanner, false);
  await expect(
    page.locator("main.page .local-resources .resource-list"),
  ).toBeVisible();
  checks.push(
    "Retry banners keep their exit animation while the resource list reloads and recovers",
  );
  expect(errors).toEqual([]);
  if (evidence)
    await writeFile(
      `${evidence}/results.json`,
      JSON.stringify({ checks, motions, errors }, null, 2),
    );
  console.log(
    JSON.stringify(
      { passed: true, checks, motionCount: motions.length, errors },
      null,
      2,
    ),
  );
} catch (error) {
  await shot("failure");
  throw error;
} finally {
  await browser.close();
}
