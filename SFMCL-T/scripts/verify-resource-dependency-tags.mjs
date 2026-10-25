import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { runtimePath } from "./lib/paths.mjs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";

const evidence = runtimePath("evidence/resource-dependency-tags");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.emulateMedia({ reducedMotion: "reduce" });
const errors = [],
  measurements = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(resourceCenterFixture);
await page.addInitScript(() => {
  const state = (window.__dependencyTagTest = {
    holdRequest: false,
    holdWidth: false,
    finishRequest: null,
    widths: [],
    animations: [],
    requests: 0,
  });
  const getAnimations = Element.prototype.getAnimations;
  Element.prototype.getAnimations = function (...args) {
    const animations = getAnimations.apply(this, args);
    if (this.matches(".resource-dependency-loading")) {
      for (const animation of animations) {
        if (!state.animations.includes(animation))
          state.animations.push(animation);
        if (state.holdWidth && animation.playState !== "finished")
          animation.pause();
        if (
          animation.transitionProperty === "width" &&
          !state.widths.includes(animation)
        )
          state.widths.push(animation);
      }
    }
    return animations;
  };
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (
      command === "request" &&
      args.operation === "resources.detail" &&
      args.payload.id === "project-1"
    ) {
      state.requests++;
      if (state.holdRequest)
        await new Promise((resolve, reject) => {
          state.finishRequest = (failure) => {
            state.finishRequest = null;
            if (failure) reject(new Error("测试前置资源加载失败"));
            else resolve();
          };
        });
    }
    const result = await invoke(command, args);
    if (command !== "request" || args.operation !== "resources.files")
      return result;
    return result.map((file) => ({
      ...file,
      dependencies: [
        { projectId: "project-1", name: "Fabric API", kind: "mod" },
        { projectId: "project-2", name: "Searchables", kind: "mod" },
        { projectId: "project-3", name: "Faithful", kind: "resourcepack" },
        { projectId: null, name: "local-library.jar", kind: "unknown" },
      ],
    }));
  };
});

const dialog = page.getByRole("dialog", { name: "下载 Sodium", exact: true });
const dependencies = dialog.getByRole("region", { name: "前置资源" });
const tag = dependencies.getByRole("button", {
  name: "查看 Fabric API 资源页面",
  exact: true,
});
const indicator = tag.locator(".resource-dependency-loading");
const openDialog = () => page.locator("button.project-file").first().click();
const sampleWidth = async () =>
  tag.evaluate((element) => {
    const loading = element.querySelector(".resource-dependency-loading");
    const motions = loading.getAnimations();
    motions.forEach((animation) => animation.pause());
    const width = motions.find(
      (animation) => animation.transitionProperty === "width",
    );
    if (!width) throw new Error("Missing loading width transition");
    const duration = width.effect.getTiming().duration;
    return [0, duration / 2, duration - 0.01].map((time) => {
      motions.forEach((animation) => {
        animation.currentTime = time;
      });
      return {
        width: element.getBoundingClientRect().width,
        loadingWidth: loading.getBoundingClientRect().width,
        opacity: Number(getComputedStyle(loading).opacity),
      };
    });
  });
const finishWidth = () =>
  indicator.evaluate((element) => {
    window.__dependencyTagTest.animations
      .filter((animation) => animation.effect.target === element)
      .forEach((animation) => animation.finish());
  });
const beginRequest = async () => {
  await page.evaluate(() => {
    window.__dependencyTagTest.holdRequest = true;
    window.__dependencyTagTest.holdWidth = true;
  });
  await tag.click();
  await expect(tag).toHaveAttribute("aria-busy", "true");
  await expect(tag).toBeDisabled();
  await expect(tag).toHaveText("Fabric API");
  const expanding = await sampleWidth();
  expect(expanding[0].loadingWidth).toBe(0);
  expect(expanding[1].width).toBeGreaterThan(expanding[0].width);
  expect(expanding[1].width).toBeLessThan(expanding[2].width);
  expect(expanding[2].width - expanding[0].width).toBeCloseTo(20, 1);
  expect(expanding[2].opacity).toBeCloseTo(1, 2);
  await finishWidth();
  await expect(indicator.locator("svg")).toHaveCSS(
    "animation-play-state",
    "running",
  );
  return expanding;
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
  await page.getByRole("tab", { name: /^可下载版本/ }).click();
  await openDialog();
  await expect(
    dependencies.getByRole("list", { name: "前置模组" }).getByRole("button"),
  ).toHaveCount(2);
  await expect(dependencies.getByText("前置模组", { exact: true })).toHaveCount(
    1,
  );
  await expect(dependencies.getByText("查看资源", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    dependencies.getByRole("button", {
      name: "查看 local-library.jar 资源页面",
    }),
  ).toBeDisabled();

  await tag.hover();
  const hover = await tag.evaluate((element) => {
    const motion = element
      .getAnimations()
      .find((animation) => animation.transitionProperty === "translate");
    if (!motion) throw new Error("Missing tag hover transition");
    motion.pause();
    const duration = motion.effect.getTiming().duration;
    const frames = [0, duration / 2, duration - 0.01].map((time) => {
      motion.currentTime = time;
      return getComputedStyle(element).translate;
    });
    motion.finish();
    return frames;
  });
  expect(hover[0]).toBe("0px");
  expect(hover[1]).not.toBe(hover[2]);
  expect(hover[2]).toBe("0px -2px");

  const initialWidth = (await tag.boundingBox()).width;
  const expanding = await beginRequest();
  await tag.evaluate((element) => {
    element.click();
    element.click();
  });
  expect(await page.evaluate(() => window.__dependencyTagTest.requests)).toBe(
    1,
  );
  await dialog.screenshot({
    path: `${evidence}/loading.png`,
    animations: "allow",
  });
  await page.evaluate(() => window.__dependencyTagTest.finishRequest(true));
  await expect(tag).toHaveAttribute("aria-busy", "false");
  const collapsing = await sampleWidth();
  expect(collapsing[0].loadingWidth).toBe(20);
  expect(collapsing[1].width).toBeLessThan(collapsing[0].width);
  expect(collapsing[1].width).toBeGreaterThan(collapsing[2].width);
  expect(collapsing[2].width).toBeCloseTo(initialWidth, 1);
  await finishWidth();
  await expect(dialog.getByRole("alert")).toContainText("测试前置资源加载失败");
  await expect(tag).toBeEnabled();
  await expect(indicator.locator("svg")).toHaveCSS(
    "animation-play-state",
    "paused",
  );

  await beginRequest();
  await page.evaluate(() => window.__dependencyTagTest.finishRequest(false));
  await expect(tag).toHaveAttribute("aria-busy", "false");
  await expect(dialog).toBeVisible();
  const successCollapse = await sampleWidth();
  expect(successCollapse[0].loadingWidth).toBe(20);
  expect(successCollapse[2].loadingWidth).toBe(0);
  await finishWidth();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".resource-subpage-header h1")).toHaveText(
    "Fabric API",
  );
  const back = page.getByRole("button", { name: "返回上一级", exact: true });
  await expect(back).toHaveAttribute("data-tooltip", "返回Sodium");
  await back.click();
  await expect(page.locator(".resource-subpage-header h1")).toHaveText(
    "Sodium",
  );
  await openDialog();

  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      await expect
        .poll(() =>
          dialog.evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
        )
        .toBe(true);
      await dialog.screenshot({
        path: `${evidence}/tags-${theme}-${width}.png`,
        animations: "disabled",
      });
    }
  }
  await dependencies
    .getByRole("button", { name: "查看 Searchables 资源页面" })
    .evaluate((element) => {
      element.querySelector(".resource-dependency-label").textContent =
        "VeryLongDependencyName".repeat(30);
    });
  await page.setViewportSize({ width: 375, height: 960 });
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await expect(indicator).toHaveCSS("transition-duration", "0.22s, 0.18s");
  await expect(indicator.locator("svg")).toHaveCSS("animation-name", "spin");
  await page.evaluate(() => {
    window.__dependencyTagTest.holdRequest = false;
    window.__dependencyTagTest.holdWidth = false;
  });
  await tag.focus();
  await tag.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".resource-subpage-header h1")).toHaveText(
    "Fabric API",
  );
  expect(errors).toEqual([]);
  measurements.push({ hover, expanding, collapsing, successCollapse });
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ measurements, errors }, null, 2),
  );
  console.log(
    "Passed grouped dependency tags, hover motion, spinner presence, gradual expansion and collapse, duplicate prevention, failure/retry, navigation after collapse, long names, light/dark layouts and keyboard navigation with animations preserved under the system reduced-motion preference.",
  );
} catch (error) {
  await page.screenshot({
    path: `${evidence}/failure.png`,
    animations: "disabled",
  });
  throw error;
} finally {
  await browser.close();
}
