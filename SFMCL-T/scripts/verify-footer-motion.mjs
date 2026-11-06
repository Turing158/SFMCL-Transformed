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
    const main = document.querySelector("main.page").getBoundingClientRect();
    const status = document.querySelector(".launch-status, .workspace-footer");
    const statusBounds = status.getBoundingClientRect();
    const statusHeight = parseFloat(
      getComputedStyle(status, "::before").height,
    );
    const card = document.querySelector(".launch-dock-main");
    const cardBounds = card.getBoundingClientRect();
    const cardStyle = getComputedStyle(card);
    return {
      height: host.height,
      bottom: host.bottom,
      top: host.top,
      mainBottom: main.bottom,
      contentBottom: inner.bottom,
      target:
        animation.effect.target.dataset.kind === "launch"
          ? inner.height
          : statusBounds.height,
      cardTop: cardBounds.top,
      cardBottom: cardBounds.bottom,
      cardHeight: cardBounds.height,
      cardLayoutHeight: card.offsetHeight,
      cardOpacity: Number(cardStyle.opacity),
      leftGap: cardBounds.left - host.left,
      rightGap: host.right - cardBounds.right,
      radii: [
        cardStyle.borderTopLeftRadius,
        cardStyle.borderTopRightRadius,
        cardStyle.borderBottomLeftRadius,
        cardStyle.borderBottomRightRadius,
      ],
      statusHeight,
      statusTop: statusBounds.bottom - statusHeight,
      statusBottom: statusBounds.bottom,
      statusTarget: statusBounds.height,
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
  expect((start.cardTop - middle.cardTop) * direction).toBeGreaterThan(0);
  expect((middle.cardTop - end.cardTop) * direction).toBeGreaterThan(0);
  expect((middle.cardOpacity - start.cardOpacity) * direction).toBeGreaterThan(
    0,
  );
  expect(end.cardOpacity).toBe(direction === 1 ? 1 : 0);
  expect(end.height).toBeCloseTo(end.target, 1);
  expect(end.statusHeight).toBeCloseTo(end.statusTarget, 1);
  for (const frame of [start, middle, end]) {
    expect(frame.bottom).toBe(640);
    expect(frame.contentBottom).toBe(640);
    expect(frame.mainBottom).toBeCloseTo(frame.statusTop, 1);
    expect(frame.overflow).toBe(false);
    expect(frame.statusBottom).toBe(640);
    expect(frame.statusTop).toBeGreaterThanOrEqual(605);
    expect(frame.statusHeight).toBeGreaterThanOrEqual(28);
    expect(frame.statusHeight).toBeLessThanOrEqual(35);
    expect(frame.cardHeight).toBeCloseTo(start.cardHeight, 3);
    expect(frame.leftGap).toBeCloseTo(frame.rightGap, 3);
    expect(frame.leftGap).toBeGreaterThanOrEqual(10);
    expect(frame.radii).toEqual(["12px", "12px", "0px", "0px"]);
  }
  expect(direction === 1 ? end.cardBottom : end.cardTop).toBeCloseTo(
    end.statusTop +
      (direction === 1 ? 0 : end.cardLayoutHeight - end.cardHeight),
    1,
  );
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
  expect(resumed.statusHeight).toBeCloseTo(interrupted.statusHeight, 1);
  expect(resumed.cardTop).toBeCloseTo(interrupted.cardTop, 1);
  expect(resumed.cardOpacity).toBeCloseTo(interrupted.cardOpacity, 3);
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
  await expect(page.locator(".workspace-footer-clip")).toHaveCSS(
    "overflow-y",
    "visible",
  );
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
  expect(afterResize.statusHeight).toBeCloseTo(beforeResize.statusHeight, 1);
  expect(afterResize.cardTop).toBeCloseTo(beforeResize.cardTop, 1);
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
    "PASS Inset launch card slides up/down with square bottom corners; card and page motion remain continuous through reversals and resizing, the bottom status strip stays anchored, and keyboard version selection remains usable.",
  );
} finally {
  await browser.close();
}
