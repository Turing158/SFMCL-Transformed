import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { launchDockFixture } from "./fixtures/launch-dock.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("evidence/footer-motion");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 640 } });
page.setDefaultTimeout(8000);
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(launchDockFixture);
await page.addInitScript(() => {
  window.__footerMotions = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (frames, options) {
    const animation = animate.call(this, frames, options);
    if (options?.id === "sfmcl-t-footer-height") {
      window.__footerMotions.push(animation);
      animation.pause();
      animation.currentTime = 0;
    }
    return animation;
  };
});
const region = page.locator(".workspace-footer-region");
const nav = (name) =>
  name === "角色管理"
    ? page.locator(".sidebar .profile-button").click()
    : page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name, exact: true })
        .click();
const count = () => page.evaluate(() => window.__footerMotions.length);
const sample = (time) =>
  page.evaluate((time) => {
    const animation = window.__footerMotions.at(-1);
    animation.currentTime = time;
    const host = animation.effect.target.getBoundingClientRect();
    const inner = document
      .querySelector(".workspace-footer-content")
      .getBoundingClientRect();
    const main = document.querySelector("main").getBoundingClientRect();
    return {
      height: host.height,
      bottom: host.bottom,
      top: host.top,
      mainBottom: main.bottom,
      contentBottom: inner.bottom,
      target: inner.height,
      overflow: document.body.scrollWidth > innerWidth,
    };
  }, time);
const finish = async () => {
  await page.evaluate(() => window.__footerMotions.at(-1)?.finish());
  await expect(region).not.toHaveAttribute("data-resizing");
};
const checkTransition = async (name, direction) => {
  const start = await sample(0);
  const middle = await sample(110);
  const end = await sample(259.99);
  expect((middle.height - start.height) * direction).toBeGreaterThan(0);
  expect((end.height - middle.height) * direction).toBeGreaterThan(0);
  expect(end.height).toBeCloseTo(end.target, 1);
  for (const frame of [start, middle, end]) {
    expect(frame.bottom).toBe(640);
    expect(frame.contentBottom).toBe(640);
    expect(frame.mainBottom).toBe(frame.top);
    expect(frame.overflow).toBe(false);
  }
  await sample(110);
  await page.screenshot({ path: `${evidence}/${name}.png` });
  await finish();
  checks.push({ name, start, middle, end });
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page.waitForFunction(
    () => !document.documentElement.hasAttribute("data-startup"),
  );
  expect(await count()).toBe(0);
  await nav("开始游戏");
  expect(await count()).toBe(0);

  await nav("角色管理");
  await expect(region).toHaveAttribute("data-kind", "status");
  await checkTransition("home-to-players", -1);
  const beforeSameKind = await count();
  await nav("版本管理");
  expect(await count()).toBe(beforeSameKind);
  await nav("开始游戏");
  await checkTransition("versions-to-home", 1);

  await nav("角色管理");
  const interrupted = await sample(90);
  await nav("开始游戏");
  const resumed = await sample(0);
  expect(resumed.height).toBeCloseTo(interrupted.height, 1);
  expect(
    await page.evaluate(() => window.__footerMotions.at(-2).playState),
  ).toBe("idle");
  await finish();
  checks.push({ name: "rapid-reversal", interrupted, resumed });

  // Keyboard users can open the picker while the dock is still expanding.
  await nav("角色管理");
  await finish();
  await nav("开始游戏");
  await page.locator(".launch-switch").focus();
  await page.keyboard.press("Enter");
  const picker = page.getByRole("dialog", {
    name: "选择游戏版本",
    exact: true,
  });
  await expect(picker).toBeVisible();
  await expect(region).toHaveCSS("overflow-y", "visible");
  await finish();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();

  await nav("角色管理");
  await finish();
  await nav("开始游戏");
  const beforeResize = await sample(80);
  const beforeResizeCount = await count();
  await page.setViewportSize({ width: 375, height: 640 });
  await expect.poll(count).toBe(beforeResizeCount + 1);
  const afterResize = await sample(0);
  expect(afterResize.height).toBeCloseTo(beforeResize.height, 1);
  await checkTransition("resize-during-expansion", 1);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await nav("设置");
  await checkTransition("narrow-collapse-full-motion", -1);
  await nav("开始游戏");
  await checkTransition("narrow-expand-full-motion", 1);
  await page.locator(".launch-switch").click();
  await expect(picker).toBeVisible();
  const bounds = await picker.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(375);
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/report.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(
    "PASS Footer height and page layout animate together in both directions; initial render and same-kind navigation stay still, rapid reversals and viewport changes remain continuous, and the version picker stays usable.",
  );
} finally {
  await browser.close();
}
