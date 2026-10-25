import { runtimePath } from "./lib/paths.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { playersFixture } from "./fixtures/players.mjs";

const evidence = runtimePath("players-implementation/motion");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const results = [];
const errors = [];
try {
  for (const fallback of [false, true]) {
    for (const width of [1440, 768, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(pixelAppFixture);
      await page.addInitScript(playersFixture);
      await page.addInitScript((fallback) => {
        window.__playerMotions = [];
        if (fallback) document.startViewTransition = undefined;
        else {
          const start = document.startViewTransition.bind(document);
          document.startViewTransition = (...args) => {
            const transition = start(...args);
            window.__playerMotions.push(transition);
            return transition;
          };
        }
      }, fallback);
      await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
      await page.locator(".sidebar .profile-button").click();
      const ui = page.locator(".players-page");
      const toggle = ui.locator(".players-view-switch");
      await expect(ui.locator(".players-identity h2")).toHaveText("Steve");
      await page.evaluate(() => document.fonts.ready);
      await page.emulateMedia({ reducedMotion: "reduce" });

      for (const view of ["gallery", "grove"]) {
        await toggle.click();
        await expect(ui).toHaveAttribute("data-view", view);
        const motion = await page.evaluate(async (fallback) => {
          if (!fallback) await window.__playerMotions.at(-1).ready;
          const isMotion = (animation) =>
            fallback
              ? animation.effect?.target?.matches?.(
                  ".player-preview, .players-collection",
                )
              : animation.animationName?.includes("view-transition");
          const animations = document.getAnimations().filter(isMotion);
          animations.forEach((animation) => animation.pause());
          const sample = (time) => {
            animations.forEach((animation) => {
              animation.currentTime = time;
            });
            return ["preview", "collection"].map((part) => {
              if (fallback) {
                const rect = document
                  .querySelector(
                    part === "preview"
                      ? ".player-preview"
                      : ".players-collection",
                  )
                  .getBoundingClientRect();
                return {
                  width: rect.width,
                  height: rect.height,
                  x: rect.x,
                  y: rect.y,
                };
              }
              const style = getComputedStyle(
                document.documentElement,
                `::view-transition-group(sfmcl-t-player-${part})`,
              );
              const matrix = new DOMMatrix(style.transform);
              return {
                width: parseFloat(style.width),
                height: parseFloat(style.height),
                x: matrix.m41,
                y: matrix.m42,
              };
            });
          };
          const start = sample(0);
          const end = sample(420);
          const middle = sample(150);
          return { count: animations.length, start, middle, end };
        }, fallback);
        expect(motion.count).toBeGreaterThanOrEqual(2);
        for (let part = 0; part < 2; part++) {
          let changing = 0;
          for (const property of ["width", "height", "x", "y"]) {
            const first = motion.start[part][property];
            const last = motion.end[part][property];
            if (Math.abs(first - last) <= 1) continue;
            changing++;
            expect(motion.middle[part][property]).toBeGreaterThan(
              Math.min(first, last),
            );
            expect(motion.middle[part][property]).toBeLessThan(
              Math.max(first, last),
            );
          }
          expect(changing).toBeGreaterThan(0);
        }
        const mode = fallback ? "fallback" : "native";
        await page.screenshot({
          path: `${evidence}/${mode}-${view}-${width}-middle.png`,
        });
        await page.evaluate(async (fallback) => {
          const animations = document
            .getAnimations()
            .filter((animation) =>
              fallback
                ? animation.effect?.target?.matches?.(
                    ".player-preview, .players-collection",
                  )
                : animation.animationName?.includes("view-transition"),
            );
          animations.forEach((animation) => animation.finish());
          if (!fallback) await window.__playerMotions.at(-1).finished;
        }, fallback);
        await expect(ui.locator(".players-identity h2")).toHaveText("Steve");
        results.push({ mode, width, view, ...motion });
      }

      // Two fast clicks must end on the original view, without stale overlays.
      await toggle.evaluate((button) => {
        button.click();
        button.click();
      });
      await expect(ui).toHaveAttribute("data-view", "grove");
      await page.evaluate(async () => {
        await Promise.allSettled(
          window.__playerMotions.map((transition) => transition.finished),
        );
        await Promise.allSettled(
          document
            .querySelector(".players-page")
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished),
        );
      });
      await expect(page.locator("html")).not.toHaveAttribute(
        "data-player-view-transition",
      );
      expect(
        await page.evaluate(
          () =>
            window.__pixelTest.requests.filter(
              (request) => request.operation === "players.select",
            ).length,
        ),
      ).toBe(0);

      await toggle.click();
      if (!fallback)
        await page.evaluate(() => window.__playerMotions.at(-1).ready);
      await page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name: "开始游戏", exact: true })
        .click();
      await expect(ui).toBeHidden();
      await expect(page.locator("html")).not.toHaveAttribute(
        "data-player-view-transition",
      );
      await page.close();
    }
  }
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/report.json`,
    JSON.stringify({ results, errors }, null, 2),
  );
  console.log(
    `PASS ${results.length} animated layouts: both directions at 1440/768/375px, native and fallback; rapid toggles, page exit, preserved selection and always-on motion.`,
  );
} finally {
  await browser.close();
}
