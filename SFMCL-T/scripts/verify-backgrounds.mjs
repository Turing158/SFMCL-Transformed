import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { waitForAutoSave } from "./lib/auto-save.mjs";

const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/";
const evidence = process.env.SFMCL_T_TEST_ARTIFACT_DIR;
if (evidence) await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1120, height: 740 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const image = process.env.SFMCL_T_TEST_BACKGROUND
    ? `data:image/png;base64,${(await readFile(process.env.SFMCL_T_TEST_BACKGROUND)).toString("base64")}`
    : await page.evaluate(() => {
        // A valid, incompressible PNG exceeds Chromium's CSS variable limit.
        const canvas = document.createElement("canvas");
        canvas.width = 1024;
        canvas.height = 768;
        const context = canvas.getContext("2d");
        const pixels = context.createImageData(canvas.width, canvas.height);
        let seed = 123456789;
        for (let offset = 0; offset < pixels.data.length; offset += 4) {
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          pixels.data[offset] = seed & 255;
          pixels.data[offset + 1] = (seed >>> 8) & 255;
          pixels.data[offset + 2] = (seed >>> 16) & 255;
          pixels.data[offset + 3] = 255;
        }
        context.putImageData(pixels, 0, 0);
        return canvas.toDataURL("image/png");
      });
  expect(image.length).toBeGreaterThan(1024 * 1024);
  await page.addInitScript(pixelAppFixture, { persistJavaLists: true });
  await page.addInitScript((image) => {
    const fixture = window.__pixelTest;
    if (!sessionStorage.getItem("pixel-test-java-settings")) {
      fixture.data.settings.backgroundType = "local";
      fixture.data.settings.background = "C:/Pixel-Test/background.png";
      fixture.data.settings.homeCleanMode = false;
    }
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "request" && args.operation === "image") return image;
      if (command === "request" && args.operation === "multiplayer.status") {
        return {
          state: "idle",
          sessionId: null,
          componentReady: false,
          componentVersion: "test",
          tunnelReady: false,
          tunnelVersion: "test",
          componentJobId: null,
          role: null,
          name: "",
          gameVersion: "",
          address: null,
          worldOpen: false,
          members: [],
          error: null,
        };
      }
      if (command === "request" && args.operation === "bootstrap") {
        const value = await invoke(command, args);
        value.backgroundPath =
          value.settings.backgroundType === "default"
            ? "C:/Pixel-Test/bg.png"
            : value.settings.backgroundType === "none"
              ? ""
              : value.settings.background;
        return value;
      }
      return invoke(command, args);
    };
  }, image);
  const main = page.locator("main.page");
  const background = page.locator(".workspace-content > .content-background");
  const imageLayer = background.locator(".content-background-image");
  const overlay = background.locator(".content-background-overlay");
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true })
      .click();
  const visibleImage = () =>
    imageLayer.evaluate(
      (element, image) =>
        getComputedStyle(element).backgroundImage.includes(image),
      image,
    );
  const scoped = async () => {
    const outside = await page
      .locator(
        ".app, .sidebar, .workspace, .topbar, .workspace-footer-region, .workspace-footer, .launch-status",
      )
      .evaluateAll((elements) =>
        elements.some((element) =>
          ["", "::before", "::after"].some((pseudo) =>
            getComputedStyle(element, pseudo || null).backgroundImage.includes(
              "url(",
            ),
          ),
        ),
      );
    expect(outside).toBe(false);
    expect(
      await page
        .locator("main[hidden]")
        .evaluateAll((elements) =>
          elements.some((element) => element.style.backgroundImage !== ""),
        ),
    ).toBe(false);
  };
  const shot = async (name) => {
    if (!evidence) return;
    await page.evaluate(() =>
      Promise.allSettled(
        document
          .getAnimations()
          .filter(
            (animation) => animation.effect.getTiming().iterations !== Infinity,
          )
          .map((animation) => animation.finished),
      ),
    );
    await page.screenshot({
      path: `${evidence}/background-${name}.png`,
      animations: "disabled",
    });
  };
  await page.goto(url);
  await page.waitForFunction(
    () => !document.documentElement.hasAttribute("data-startup"),
  );
  await expect.poll(visibleImage).toBe(true);
  const decoded = await page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  }, image);
  expect(decoded.width).toBeGreaterThan(0);
  await scoped();
  await shot("light");
  for (const name of ["版本管理", "联机", "资源中心", "设置"]) {
    await nav(name);
    await expect.poll(visibleImage).toBe(true);
    await scoped();
  }
  const card = page.getByRole("region", { name: "背景", exact: true });
  await expect(card).toBeVisible();
  await expect(
    card.getByRole("img", { name: "背景效果预览", exact: true }),
  ).toHaveCount(0);
  await expect(
    card.getByRole("combobox", { name: "背景来源", exact: true }),
  ).toHaveCount(1);
  const transparency = card.getByRole("slider", {
    name: "遮罩透明度",
    exact: true,
  });
  const blur = card.getByRole("slider", { name: "背景虚化程度", exact: true });
  await expect(transparency).toHaveValue("35");
  await expect(blur).toHaveValue("0");
  await transparency.focus();
  await transparency.press("End");
  await waitForAutoSave(page);
  await expect(overlay).toHaveCSS("opacity", "0");
  await transparency.press("Home");
  await waitForAutoSave(page);
  await expect(overlay).toHaveCSS("opacity", "1");
  for (let step = 0; step < 37; step++) await transparency.press("ArrowRight");
  await blur.focus();
  await blur.press("End");
  await waitForAutoSave(page);
  await expect(imageLayer).toHaveCSS("filter", "blur(30px)");
  await blur.press("Home");
  for (let step = 0; step < 12; step++) await blur.press("ArrowRight");
  await waitForAutoSave(page);
  await expect(overlay).toHaveCSS("opacity", "0.63");
  await expect(imageLayer).toHaveCSS("filter", "blur(12px)");
  await expect(main).toHaveCSS("filter", "none");
  expect(
    await page.evaluate(() => {
      const settings = window.__pixelTest.data.settings;
      return {
        opacity: settings.backgroundOverlayOpacity,
        blur: settings.backgroundBlur,
      };
    }),
  ).toEqual({ opacity: 63, blur: 12 });
  const beforeScroll = await background.boundingBox();
  await main.evaluate((element) => (element.scrollTop = 250));
  expect(await background.boundingBox()).toEqual(beforeScroll);
  await card.scrollIntoViewIfNeeded();
  await shot("settings-card");
  await page.locator(".theme-option.dark").click();
  await waitForAutoSave(page);
  await nav("开始游戏");
  await expect.poll(visibleImage).toBe(true);
  await shot("dark");
  await page.setViewportSize({ width: 780, height: 650 });
  await expect.poll(visibleImage).toBe(true);
  await scoped();
  await shot("narrow");
  await nav("设置");
  const source = page.getByRole("combobox", { name: "背景来源", exact: true });
  await card.scrollIntoViewIfNeeded();
  await shot("settings-narrow");
  await page.setViewportSize({ width: 375, height: 800 });
  expect(
    await card.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await card.scrollIntoViewIfNeeded();
  await shot("settings-compact");
  await page.setViewportSize({ width: 780, height: 650 });
  const select = async (name) => {
    await source.click();
    await page.getByRole("option", { name, exact: true }).click();
    await waitForAutoSave(page);
  };
  await select("纯色背景");
  await expect(imageLayer).toHaveCount(0);
  await expect(overlay).toHaveCSS("opacity", "0");
  await expect(transparency).toBeDisabled();
  await expect(blur).toBeDisabled();
  await select("配置目录中的 bg.png / bg.jpg");
  await expect.poll(visibleImage).toBe(true);
  await page.getByRole("button", { name: "刷新背景图片", exact: true }).click();
  await expect.poll(visibleImage).toBe(true);
  await scoped();
  await page.reload();
  await page.waitForFunction(
    () => !document.documentElement.hasAttribute("data-startup"),
  );
  await expect.poll(visibleImage).toBe(true);
  await nav("设置");
  await expect(transparency).toHaveValue("37");
  await expect(blur).toHaveValue("12");
  await card.getByRole("button", { name: "重置效果", exact: true }).click();
  await waitForAutoSave(page);
  await expect(transparency).toHaveValue("35");
  await expect(blur).toHaveValue("0");
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify(
      {
        passed: true,
        imageCharacters: image.length,
        decoded,
        checks: [
          "Large PNG displays after startup and page navigation",
          "Light/dark themes and narrow windows retain the image",
          "Image stays in content; inactive pages and chrome have no image",
          "Solid mode removes image/shade; default mode and refresh restore it",
          "Background card saves transparency/blur without a preview; content stays crisp",
          "Background remains fixed during scroll; effects persist after restart and reset",
        ],
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
