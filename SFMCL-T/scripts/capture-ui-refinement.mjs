import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { runtimePath } from "./lib/paths.mjs";

// Render the real application with the same in-memory data for both captures.
const phase = process.argv[2] || "after";
const output = path.resolve(
  process.argv[3] || runtimePath("evidence/ui-refinement"),
);
const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const errors = [];
const captures = [];

try {
  for (const scene of [
    { id: "home", page: "开始游戏", theme: "light", width: 1280 },
    { id: "versions", page: "版本管理", theme: "light", width: 1280 },
    { id: "settings", page: "设置", theme: "light", width: 1280 },
    { id: "home-dark", page: "开始游戏", theme: "dark", width: 1280 },
    { id: "versions-dark", page: "版本管理", theme: "dark", width: 1280 },
    { id: "home-narrow", page: "开始游戏", theme: "light", width: 375 },
  ]) {
    const page = await browser.newPage({
      viewport: { width: scene.width, height: 800 },
      deviceScaleFactor: 1,
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(pixelAppFixture, { components: true });
    await page.addInitScript((theme) => {
      window.__pixelTest.data.settings.theme = theme;
    }, scene.theme);
    await page.goto(url);
    await page.waitForFunction(
      () => !document.documentElement.hasAttribute("data-startup"),
    );
    if (scene.page !== "开始游戏") {
      await page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name: scene.page, exact: true })
        .click();
    }
    await expect(page.locator(".page-heading:visible h1")).toBeVisible();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.allSettled(
        document
          .getAnimations()
          .filter(
            (animation) => animation.effect.getTiming().iterations !== Infinity,
          )
          .map((animation) => animation.finished),
      );
    });
    await page.mouse.move(scene.width - 20, 400);
    await page.screenshot({
      path: path.join(output, `${phase}-${scene.id}.png`),
      animations: "disabled",
    });
    captures.push({
      ...scene,
      layout: await page.evaluate(() => ({
        titlebarFont: getComputedStyle(document.querySelector(".topbar"))
          .fontSize,
        footerFont: getComputedStyle(
          document.querySelector(".launch-status, .workspace-footer"),
        ).fontSize,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      })),
    });
    await page.close();
  }
  expect(errors).toEqual([]);
  expect(captures.every((capture) => !capture.layout.horizontalOverflow)).toBe(
    true,
  );
  await writeFile(
    path.join(output, `${phase}-report.json`),
    JSON.stringify({ captures, errors }, null, 2),
  );
  console.log(
    `Captured ${captures.length} ${phase} scenes in ${output}; no page errors or horizontal overflow.`,
  );
} finally {
  await browser.close();
}
