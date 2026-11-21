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
    card.getByRole("combobox", { name: "背景", exact: true }),
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
  const source = card.getByRole("combobox", { name: "背景", exact: true });
  const options = card.locator(".background-settings-options");
  const imageField = card.locator(".background-settings-image");
  await card.scrollIntoViewIfNeeded();
  await shot("settings-narrow");
  await page.setViewportSize({ width: 375, height: 800 });
  expect(
    await card.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await card.scrollIntoViewIfNeeded();
  await shot("settings-compact");
  await page.setViewportSize({ width: 780, height: 650 });
  const motionChecks = [];
  const select = async (name, disclosure, opening) => {
    await source.click();
    await page.getByRole("option", { name, exact: true }).click();
    if (disclosure) {
      const motion = await disclosure.evaluate((element) => {
        const animations = element.getAnimations();
        const height = animations.find(
          (animation) => animation.transitionProperty === "grid-template-rows",
        );
        if (!height) throw new Error("Missing background disclosure animation");
        const moving = animations.filter(
          (animation) => animation.effect.getTiming().duration > 0,
        );
        const times = moving.map((animation) => animation.currentTime);
        // Inspect real intermediate geometry instead of merely checking CSS rules.
        moving.forEach((animation) => animation.pause());
        const samples = [0, 0.5, 1].map((progress) => {
          moving.forEach((animation) => {
            animation.currentTime =
              animation.effect.getTiming().duration * progress;
          });
          return {
            height: element.getBoundingClientRect().height,
            opacity: Number(getComputedStyle(element).opacity),
          };
        });
        moving.forEach((animation, index) => {
          animation.currentTime = times[index];
          animation.play();
        });
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
      motionChecks.push({ name, opening, ...motion });
      await disclosure.evaluate((element) =>
        Promise.allSettled(
          element.getAnimations().map((animation) => animation.finished),
        ),
      );
    }
    await waitForAutoSave(page);
  };
  await select("纯色背景", options, false);
  await expect(imageLayer).toHaveCount(0);
  await expect(overlay).toHaveCSS("opacity", "0");
  await expect(options).toBeHidden();
  await expect(options).toHaveCSS("height", "0px");
  await expect(options).toHaveAttribute("inert", "");
  await expect(card.getByRole("slider")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "刷新背景图片" })).toHaveCount(
    0,
  );
  await expect(card.getByRole("button", { name: "重置效果" })).toHaveCount(0);
  expect(
    await options.evaluate((element) => {
      element.querySelector("input").focus();
      return element.contains(document.activeElement);
    }),
  ).toBe(false);
  await shot("settings-solid");
  await page.reload();
  await page.waitForFunction(
    () => !document.documentElement.hasAttribute("data-startup"),
  );
  await nav("设置");
  await expect(options).toBeHidden();
  await expect(source).toContainText("纯色背景");
  await select("配置目录中的 bg.png / bg.jpg", options, true);
  await expect(transparency).toHaveValue("37");
  await expect(blur).toHaveValue("12");
  await expect(imageField).toBeHidden();
  await select("本地图片", imageField, true);
  await expect(
    card.getByRole("textbox", { name: "图片路径或 URL" }),
  ).toHaveValue("C:/Pixel-Test/background.png");
  await select("配置目录中的 bg.png / bg.jpg", imageField, false);
  await expect(imageField).toBeHidden();
  await select("网络图片", imageField, true);
  await expect(
    card.getByRole("textbox", { name: "图片路径或 URL" }),
  ).toHaveAttribute("placeholder", "https://…");
  await expect(card.getByRole("button", { name: "选择背景图片" })).toHaveCount(
    0,
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await select("纯色背景", options, false);
  await expect(options).toBeHidden();
  await select("配置目录中的 bg.png / bg.jpg", options, true);
  await page.emulateMedia({ reducedMotion: "no-preference" });
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
        motionChecks,
        checks: [
          "Large PNG displays after startup and page navigation",
          "Light/dark themes and narrow windows retain the image",
          "Image stays in content; inactive pages and chrome have no image",
          "Solid mode removes image/shade; default mode and refresh restore it",
          "Solid mode collapses all options and excludes them from keyboard focus; reload stays collapsed",
          "Options and image fields animate height and opacity in both directions, including reduced-motion mode",
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
