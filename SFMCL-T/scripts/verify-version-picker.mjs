import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { runtimePath } from "./lib/paths.mjs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { launchDockFixture } from "./fixtures/launch-dock.mjs";

const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/";
const evidence = runtimePath("evidence/version-picker");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage();
page.setDefaultTimeout(8000);
await page.addInitScript({
  content: `(${pixelAppFixture.toString()})({ components: true }); (${launchDockFixture.toString()})();`,
});
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
const trigger = page.locator(".launch-switch");
// Keep the DOM locator during exit, when the dialog is already aria-hidden/inert.
const popup = page.locator(".launch-version-picker");
const search = popup.getByRole("searchbox", { name: "搜索本地版本" });
const settle = () =>
  popup.evaluate((node) =>
    Promise.allSettled(
      node.getAnimations().map((animation) => animation.finished),
    ),
  );
const geometry = () =>
  popup.evaluate((node) => {
    const anchor = document
      .querySelector(".launch-switch")
      .getBoundingClientRect();
    const panel = node.getBoundingClientRect();
    return {
      placement: node.dataset.placement,
      gap:
        node.dataset.placement === "top"
          ? anchor.top - panel.bottom
          : panel.top - anchor.bottom,
      left: panel.left,
      right: panel.right,
      top: panel.top,
      bottom: panel.bottom,
      endGap: panel.right - anchor.right,
      width: innerWidth,
      height: innerHeight,
      topLayer: node.matches(":popover-open"),
    };
  });
const attachedGap = async () => {
  await expect
    .poll(async () => Math.abs((await geometry()).gap - 6))
    .toBeLessThan(0.5);
  const bounds = await geometry();
  expect(bounds.left).toBeGreaterThanOrEqual(8);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width - 8);
  expect(bounds.top).toBeGreaterThanOrEqual(48);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height - 8);
  expect(bounds.topLayer).toBe(true);
  return bounds;
};
const close = async () => {
  await search.press("Escape");
  await expect(popup).toHaveCount(0);
};

try {
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width === 375 ? 568 : 720 });
    await page.goto(`${url}?dock-test=many`);
    await expect(trigger).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "你好，Alex", exact: true }),
    ).toBeVisible();
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      await trigger.click();
      await settle();
      expect((await attachedGap()).placement).toBe("top");
      await search.fill("1.21.4");
      await expect(popup.getByRole("option")).toHaveCount(1);
      await attachedGap();
      await search.fill("");
      await expect(popup.getByRole("option")).toHaveCount(26);
      await attachedGap();
      await page.screenshot({ path: `${evidence}/${width}-${theme}.png` });
      await close();
      await expect(trigger).toBeFocused();
      checks.push(
        `${width}px ${theme}: 6px anchored gap, viewport fit and filtering resize`,
      );
    }
  }

  await trigger.click();
  await settle();
  await page.setViewportSize({ width: 375, height: 568 });
  await attachedGap();
  await page.setViewportSize({ width: 1440, height: 900 });
  await attachedGap();

  // Exercise button movement independent of element size, as during footer motion.
  await page
    .locator(".launch-actions")
    .evaluate(
      (node) =>
        node.animate(
          [{ transform: "translateY(0)" }, { transform: "translateY(-70px)" }],
          { duration: 300, fill: "forwards" },
        ).finished,
    );
  await attachedGap();
  await page
    .locator(".launch-actions")
    .evaluate((node) =>
      node.getAnimations().forEach((animation) => animation.cancel()),
    );
  await attachedGap();
  await close();
  checks.push(
    "An open popup follows responsive layout changes and animated button movement",
  );

  // Move only the trigger to cover downward placement and horizontal edge clamping.
  await trigger.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    node.closest(".launch-actions").style.transform =
      `translate(${12 - rect.left}px, ${90 - rect.top}px)`;
  });
  // The test deliberately moves the button beyond the launch card's clip.
  await trigger.evaluate((button) => button.click());
  await settle();
  expect((await attachedGap()).placement).toBe("bottom");
  await page.screenshot({ path: `${evidence}/downward.png` });
  await close();
  await page
    .locator(".launch-actions")
    .evaluate((node) => node.removeAttribute("style"));
  checks.push(
    "A button near the top opens downward and a button near the left stays on screen",
  );

  for (const preference of ["no-preference", "reduce"]) {
    await page.emulateMedia({ reducedMotion: preference });
    const frames = await trigger.evaluate(async (button) => {
      const sample = () => {
        const node = document.querySelector(".launch-version-picker");
        const style = getComputedStyle(node);
        return {
          opacity: Number(style.opacity),
          transform: style.transform,
          clip: style.clipPath,
          filter: style.filter,
        };
      };
      const nextFrame = () =>
        new Promise((resolve) => requestAnimationFrame(resolve));
      button.click();
      await nextFrame();
      await nextFrame();
      const node = document.querySelector(".launch-version-picker");
      const opening = node
        .getAnimations()
        .find((animation) => animation.id === "sfmcl-t-version-picker");
      opening.pause();
      opening.currentTime = 0;
      const initialShadow = sample().filter;
      opening.currentTime = 100;
      const openingFrame = sample();
      opening.currentTime = 240;
      const expandedShadow = sample().filter;
      opening.currentTime = 100;
      button.click();
      await nextFrame();
      const closing = node
        .getAnimations()
        .find((animation) => animation.id === "sfmcl-t-version-picker");
      closing.pause();
      closing.currentTime = 0;
      const reversal = sample();
      closing.currentTime = 60;
      const closingFrame = sample();
      button.click();
      await nextFrame();
      const reopening = node
        .getAnimations()
        .find((animation) => animation.id === "sfmcl-t-version-picker");
      reopening.pause();
      reopening.currentTime = 0;
      const reopenedFrame = sample();
      reopening.currentTime = 240;
      const reopenedShadow = sample().filter;
      reopening.finish();
      return {
        initialShadow,
        expandedShadow,
        reopenedShadow,
        openingFrame,
        reversal,
        closingFrame,
        reopenedFrame,
        durations: [opening, closing, reopening].map(
          (animation) => animation.effect.getTiming().duration,
        ),
        sameNode: node === document.querySelector(".launch-version-picker"),
      };
    });
    expect(frames.durations).toEqual([240, 180, 240]);
    expect(frames.sameNode).toBe(true);
    expect(frames.openingFrame.opacity).toBeGreaterThan(0);
    expect(frames.openingFrame.opacity).toBeLessThan(1);
    expect(
      Math.abs(frames.openingFrame.opacity - frames.reversal.opacity),
    ).toBeLessThan(0.001);
    expect(frames.closingFrame.opacity).toBeLessThan(frames.reversal.opacity);
    expect(
      Math.abs(frames.closingFrame.opacity - frames.reopenedFrame.opacity),
    ).toBeLessThan(0.001);
    expect(frames.openingFrame.transform).toBe(frames.reversal.transform);
    expect(frames.closingFrame.transform).toBe(frames.reopenedFrame.transform);
    expect(frames.openingFrame.filter).not.toBe(frames.initialShadow);
    expect(frames.openingFrame.filter).not.toBe(frames.expandedShadow);
    expect(frames.openingFrame.filter).toBe(frames.reversal.filter);
    expect(frames.closingFrame.filter).not.toBe(frames.reversal.filter);
    expect(frames.closingFrame.filter).toBe(frames.reopenedFrame.filter);
    expect(frames.reopenedShadow).toBe(frames.expandedShadow);
    for (const frame of [
      frames.openingFrame,
      frames.reversal,
      frames.closingFrame,
      frames.reopenedFrame,
    ]) {
      expect(frame.clip).toBe("none");
    }
    await expect(search).toBeFocused();
    await attachedGap();
    await close();
    checks.push(
      `${preference}: full enter/exit motion, unclipped interpolated shadows and continuous rapid reversals`,
    );
  }

  await trigger.click();
  await settle();
  const dismissal = await page.evaluate(async () => {
    document
      .querySelector("main h1")
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const node = document.querySelector(".launch-version-picker");
    return { retained: !!node, state: node?.dataset.state, inert: node?.inert };
  });
  expect(dismissal).toEqual({ retained: true, state: "closed", inert: true });
  await expect(popup).toHaveCount(0);
  await trigger.click();
  await search.fill("fabric");
  await search.press("Enter");
  await expect(popup).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.locator(".launch-version h3")).toHaveText("1.20.1-Fabric");
  checks.push(
    "Outside dismissal retains an inert panel through exit; selecting a version closes and restores focus",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/verification.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` });
  throw error;
} finally {
  await browser.close();
}
