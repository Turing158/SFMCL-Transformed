import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { launchDockFixture } from "./fixtures/launch-dock.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("evidence/footer-settle");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const checks = [];
const errors = [];
const { PNG } = createRequire(import.meta.url)(
  "playwright-core/lib/utilsBundle",
);
const changedPixels = (before, after) => {
  const first = PNG.sync.read(before);
  const second = PNG.sync.read(after);
  expect([first.width, first.height]).toEqual([second.width, second.height]);
  let changes = 0;
  for (let i = 0; i < first.data.length; i += 4) {
    // Allow imperceptible channel rounding, but no displaced edge or glyph.
    if (
      [0, 1, 2, 3].some(
        (channel) =>
          Math.abs(first.data[i + channel] - second.data[i + channel]) > 2,
      )
    ) {
      changes++;
    }
  }
  return changes;
};

try {
  for (const width of [1120, 375]) {
    for (const scale of [1, 1.25, 2]) {
      const page = await browser.newPage({
        viewport: { width, height: 640 },
        deviceScaleFactor: scale,
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(pixelAppFixture);
      await page.addInitScript(launchDockFixture);
      await page.addInitScript(() => {
        window.__settlingMotions = [];
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (frames, options) {
          const animation = animate.call(this, frames, options);
          if (options?.id?.startsWith("sfmcl-t-footer-")) {
            window.__settlingMotions.push(animation);
            animation.pause();
            animation.currentTime = 0;
          }
          return animation;
        };
      });
      await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
      await page.waitForFunction(
        () => !document.documentElement.hasAttribute("data-startup"),
      );
      await page.locator(".launch-primary").waitFor();
      await page.evaluate(() => document.fonts.ready);

      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        for (const name of ["设置", "开始游戏"]) {
          await page
            .getByRole("navigation", { name: "主导航" })
            .getByRole("button", { name, exact: true })
            .click();
          await expect(
            page.locator(".workspace-footer-region"),
          ).toHaveAttribute("data-kind", name === "设置" ? "status" : "launch");
          const clip = await page
            .locator(".launch-status, .workspace-footer")
            .boundingBox();
          // Keep the page behind a fractional footer edge still while comparing
          // footer frames; the page has its own independent navigation motion.
          await page.evaluate(() => {
            for (const animation of document.getAnimations()) {
              if (animation.id.startsWith("sfmcl-t-navigation-")) animation.finish();
            }
          });
          const label = `${width}-${scale}-${theme}-${name === "设置" ? "leave" : "return"}`;
          const frames = [];
          for (const time of [240, 250, 259.99]) {
            await page.evaluate((time) => {
              for (const animation of window.__settlingMotions) {
                if (animation.playState === "paused")
                  animation.currentTime = time;
              }
            }, time);
            frames.push(
              await page.screenshot({
                clip,
                path: `${evidence}/${label}-${time}.png`,
              }),
            );
          }
          await page.evaluate(() => {
            for (const animation of window.__settlingMotions) {
              if (animation.playState === "paused") animation.finish();
            }
          });
          await expect(
            page.locator(".workspace-footer-region"),
          ).not.toHaveAttribute("data-resizing");
          const finished = await page.screenshot({
            clip,
            path: `${evidence}/${label}-finished.png`,
          });
          for (const frame of frames) {
            expect(
              changedPixels(frame, finished),
              `${label}: last frames match the settled pixels`,
            ).toBe(0);
          }
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          );
          const idle = await page.screenshot({ clip });
          expect(
            changedPixels(idle, finished),
            `${label}: idle frame remains unchanged`,
          ).toBe(0);
          checks.push({ width, scale, theme, direction: name, stable: true });
        }
      }
      await page.close();
    }
  }
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/report.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(
    `PASS ${checks.length} footer transitions: final animation frames and idle pixels match at desktop/narrow widths, light/dark themes, and 100%/125%/200% display scales.`,
  );
} finally {
  await browser.close();
}
