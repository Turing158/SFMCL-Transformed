import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { launchDockFixture } from "./fixtures/launch-dock.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("evidence/footer-text");
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
  window.__textMotions = [];
  window.__iconMotions = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (frames, options) {
    const animation = animate.call(this, frames, options);
    if (options?.id?.startsWith("sfmcl-t-footer-text-")) {
      window.__textMotions.push({
        animation,
        slot: this.closest("[data-footer-text]").dataset.footerText,
      });
      animation.pause();
      animation.currentTime = 0;
    }
    if (options?.id?.startsWith("sfmcl-t-footer-icon-")) {
      window.__iconMotions.push(animation);
      animation.pause();
      animation.currentTime = 0;
    }
    return animation;
  };
});
const line = (slot) => page.locator(`[data-footer-text="${slot}"]`);
const nav = (name) =>
  name === "角色管理"
    ? page.locator(".sidebar .profile-button").click()
    : page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name, exact: true })
        .click();
const count = () => page.evaluate(() => window.__textMotions.length);
const iconCount = () => page.evaluate(() => window.__iconMotions.length);
const iconFrame = (time) =>
  page.evaluate((time) => {
    const host = document.querySelector(".footer-status-icon");
    if (time !== undefined) {
      for (const animation of window.__iconMotions) {
        if (animation.playState === "paused") animation.currentTime = time;
      }
    }
    const rect = host.getBoundingClientRect();
    const frame = (selector) => {
      const node = host.querySelector(selector);
      if (!node) return null;
      const style = getComputedStyle(node);
      return {
        opacity: Number(style.opacity),
        transform: style.transform,
        shape: node.querySelector("svg")?.getAttribute("class") || "dot",
      };
    };
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      incoming: frame(".footer-icon-current"),
      outgoing: frame(".footer-icon-outgoing"),
      durations: window.__iconMotions
        .filter((a) => a.playState === "paused")
        .map((a) => a.effect.getTiming().duration),
    };
  }, time);
const checkIcon = async (name, before, oldShape, newShape) => {
  const start = await iconFrame(0);
  const middle = await iconFrame(90);
  const end = await iconFrame(259.9);
  expect(start.x).toBeCloseTo(before.x, 3);
  expect(start.y).toBeCloseTo(before.y, 3);
  expect(start.outgoing.shape).toContain(oldShape);
  expect(start.incoming.shape).toContain(newShape);
  expect(start.incoming.opacity).toBe(0);
  expect(middle.incoming.opacity).toBeGreaterThan(0);
  expect(middle.incoming.opacity).toBeLessThan(1);
  expect(middle.outgoing.opacity).toBeLessThan(start.outgoing.opacity);
  expect(middle.incoming.transform).not.toBe(start.incoming.transform);
  expect(end.incoming.opacity).toBeCloseTo(1, 3);
  expect(end.outgoing.opacity).toBeCloseTo(0, 3);
  expect(start.durations).toEqual([260, 260, 260]);
  await expect(page.locator(".footer-status-icon")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await iconFrame(90);
  await page.screenshot({ path: `${evidence}/${name}.png` });
  checks.push({ name, start, middle, end });
};
const positionCount = () =>
  page.evaluate(
    () =>
      window.__textMotions.filter(
        ({ animation }) => animation.id === "sfmcl-t-footer-text-position",
      ).length,
  );
const position = (time) =>
  page.evaluate((time) => {
    const host = document.querySelector('[data-footer-text="message"]');
    const motion = window.__textMotions.findLast(
      ({ animation }) =>
        animation.id === "sfmcl-t-footer-text-position" &&
        animation.playState === "paused",
    );
    if (time !== undefined) {
      if (!motion) throw new Error("Expected a status position animation");
      motion.animation.currentTime = time;
    }
    const rect = host.getBoundingClientRect();
    return { x: rect.x, y: rect.y, text: host.textContent };
  }, time);
const checkPosition = async (name, before) => {
  const start = await position(0);
  const middle = await position(90);
  const end = await position(259.9);
  expect(start.x).toBeCloseTo(before.x, 3);
  expect(start.y).toBeCloseTo(before.y, 3);
  expect(Math.abs(end.x - start.x) + Math.abs(end.y - start.y)).toBeGreaterThan(
    1,
  );
  for (const axis of ["x", "y"]) {
    expect(middle[axis]).toBeGreaterThan(Math.min(start[axis], end[axis]));
    expect(middle[axis]).toBeLessThan(Math.max(start[axis], end[axis]));
  }
  const destination = await line("message").evaluate((host) => {
    const rect = host.getBoundingClientRect();
    const transform = new DOMMatrixReadOnly(getComputedStyle(host).transform);
    return { x: rect.x - transform.m41, y: rect.y - transform.m42 };
  });
  expect(end.x).toBeCloseTo(destination.x, 3);
  expect(end.y).toBeCloseTo(destination.y, 3);
  checks.push({ name, start, middle, end });
};
const finish = async () => {
  await page.evaluate(() => {
    for (const { animation } of window.__textMotions) {
      if (animation.playState === "paused") animation.finish();
    }
    for (const animation of window.__iconMotions) {
      if (animation.playState === "paused") animation.finish();
    }
  });
  await expect(page.locator(".footer-text-outgoing")).toHaveCount(0);
  await expect(line("message")).toHaveCSS("transform", "none");
  await expect(page.locator(".footer-icon-outgoing")).toHaveCount(0);
  await expect(page.locator(".footer-status-icon")).toHaveCSS(
    "transform",
    "none",
  );
};
const sample = (slot, time) =>
  page.evaluate(
    ({ slot, time }) => {
      const host = document.querySelector(`[data-footer-text="${slot}"]`);
      const motions = window.__textMotions.filter(
        (motion) =>
          motion.slot === slot && motion.animation.playState === "paused",
      );
      for (const { animation } of motions) animation.currentTime = time;
      const frame = (selector) => {
        const node = host.querySelector(selector);
        const style = getComputedStyle(node);
        return {
          text: node.dataset.text || node.textContent,
          opacity: Number(style.opacity),
          y: new DOMMatrixReadOnly(style.transform).m42,
        };
      };
      return {
        incoming: frame(".footer-text-current"),
        outgoing: frame(".footer-text-outgoing"),
        duration: motions[0].animation.effect.getTiming().duration,
      };
    },
    { slot, time },
  );
const transition = async (name, slot, oldText, newText) => {
  await expect(line(slot)).toHaveText(newText);
  await expect(line(slot).locator(".footer-text-outgoing")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  const start = await sample(slot, 0);
  const middle = await sample(slot, 90);
  const end = await sample(slot, 259.9);
  expect(start.outgoing.text).toBe(oldText);
  expect(start.incoming.opacity).toBe(0);
  expect(start.incoming.y).toBe(6);
  expect(middle.incoming.opacity).toBeGreaterThan(0);
  expect(middle.incoming.opacity).toBeLessThan(1);
  expect(middle.incoming.y).toBeGreaterThan(0);
  expect(middle.incoming.y).toBeLessThan(6);
  expect(middle.outgoing.opacity).toBeLessThan(start.outgoing.opacity);
  expect(middle.outgoing.y).toBeLessThan(start.outgoing.y);
  expect(end.incoming.opacity).toBeCloseTo(1, 3);
  expect(end.outgoing.opacity).toBeCloseTo(0, 3);
  expect(start.duration).toBe(260);
  await sample(slot, 90);
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
  expect(await iconCount()).toBe(0);
  const homePosition = await position();
  const homeIcon = await iconFrame();
  await nav("角色管理");
  await checkIcon("ready-icon-to-dot", homeIcon, "lucide-circle-check", "dot");
  await expect(line("message")).toHaveText("准备就绪");
  await checkPosition("same-status-home-to-players", homePosition);
  await expect(line("message").locator(".footer-text-current")).toHaveCSS(
    "opacity",
    "1",
  );
  await transition(
    "home-to-players",
    "player",
    "Alex 砍下了第一颗木头",
    "Alex 挖到了第一颗煤炭",
  );
  const beforeSameKind = await positionCount();
  const sameKindIcons = await iconCount();
  await nav("版本管理");
  expect(await positionCount()).toBe(beforeSameKind);
  expect(await iconCount()).toBe(sameKindIcons);
  await transition(
    "players-to-versions",
    "player",
    "Alex 挖到了第一颗煤炭",
    "Alex 做出了第一把木镐",
  );
  const stable = await count();
  await nav("版本管理");
  const polls = await page.evaluate(
    () =>
      window.__pixelTest.requests.filter((r) => r.operation === "tasks").length,
  );
  await page.waitForFunction(
    (polls) =>
      window.__pixelTest.requests.filter((r) => r.operation === "tasks")
        .length >
      polls + 1,
    polls,
  );
  expect(await count()).toBe(stable);
  expect(await iconCount()).toBe(sameKindIcons);
  const genericPosition = await position();
  const genericIcon = await iconFrame();
  await nav("开始游戏");
  await checkIcon(
    "dot-to-ready-icon",
    genericIcon,
    "dot",
    "lucide-circle-check",
  );
  await checkPosition("same-status-versions-to-home", genericPosition);
  await transition(
    "versions-to-home",
    "player",
    "Alex 做出了第一把木镐",
    "Alex 用火把点亮了矿洞",
  );

  await nav("角色管理");
  const interruptedIcon = await iconFrame(90);
  const interruptedPosition = await position(90);
  const interrupted = await sample("player", 90);
  await nav("开始游戏");
  const resumedIcon = await iconFrame(0);
  expect(resumedIcon.x).toBeCloseTo(interruptedIcon.x, 3);
  expect(resumedIcon.y).toBeCloseTo(interruptedIcon.y, 3);
  expect(resumedIcon.outgoing.opacity).toBeCloseTo(
    interruptedIcon.incoming.opacity,
    4,
  );
  expect(resumedIcon.outgoing.transform).toBe(
    interruptedIcon.incoming.transform,
  );
  expect(await page.locator(".footer-icon-outgoing").count()).toBe(1);
  expect(
    await page.evaluate(
      () =>
        window.__iconMotions.filter(
          (animation) =>
            animation.playState === "paused" &&
            !animation.effect.target.isConnected,
        ).length,
    ),
  ).toBe(0);
  const resumedPosition = await position(0);
  expect(resumedPosition.x).toBeCloseTo(interruptedPosition.x, 3);
  expect(resumedPosition.y).toBeCloseTo(interruptedPosition.y, 3);
  const resumed = await sample("player", 0);
  expect(resumed.outgoing.text).toBe(interrupted.incoming.text);
  expect(resumed.outgoing.opacity).toBeCloseTo(interrupted.incoming.opacity, 4);
  expect(resumed.outgoing.y).toBeCloseTo(interrupted.incoming.y, 4);
  expect(await line("player").locator(".footer-text-outgoing").count()).toBe(1);
  expect(
    await page.evaluate(
      () =>
        window.__textMotions.filter(
          ({ animation }) =>
            animation.playState === "paused" &&
            !animation.effect.target.isConnected,
        ).length,
    ),
  ).toBe(0);
  await finish();
  checks.push({
    name: "rapid-footer-reversal",
    interrupted,
    resumed,
    interruptedPosition,
    resumedPosition,
    interruptedIcon,
    resumedIcon,
  });

  const beforeLaunchIcon = await iconFrame();
  await page.locator(".launch-primary").click();
  await expect(line("message")).toHaveText("检查游戏与 Java");
  await checkIcon(
    "ready-to-loading-icon",
    beforeLaunchIcon,
    "lucide-circle-check",
    "lucide-loader-circle",
  );
  expect(
    await page
      .locator(".footer-icon-current > svg.spin")
      .evaluate((icon) =>
        icon
          .getAnimations()
          .some(
            (animation) =>
              animation.playState === "running" &&
              animation.effect.getTiming().iterations === Infinity,
          ),
      ),
  ).toBe(true);
  await finish();
  const captionCount = await page.evaluate(
    () => window.__textMotions.filter((m) => m.slot === "player").length,
  );
  await page.evaluate(() => window.__pixelTest.advanceLaunch(1));
  await transition(
    "launch-progress",
    "message",
    "检查游戏与 Java",
    "检查资源索引",
  );
  await expect(line("step")).toHaveText("第 2 / 4 步");
  expect(
    await page.evaluate(
      () => window.__textMotions.filter((m) => m.slot === "player").length,
    ),
  ).toBe(captionCount);
  const launchPosition = await position();
  const launchIcon = await iconFrame();
  await nav("版本管理");
  await checkIcon(
    "loading-icon-to-dot",
    launchIcon,
    "lucide-loader-circle",
    "dot",
  );
  await expect(page.locator(".footer-icon-outgoing .spin")).toHaveCount(0);
  await checkPosition("different-status-home-to-versions", launchPosition);
  await transition(
    "launch-to-generic-status",
    "message",
    "检查资源索引",
    "准备就绪",
  );
  await page.evaluate(() => window.__pixelTest.downloadState("running"));
  await transition(
    "download-status",
    "message",
    "准备就绪",
    "1 个下载正在进行",
  );
  await nav("开始游戏");
  await sample("message", 90);
  await iconFrame(90);
  const beforeErrorIcon = await iconFrame();
  const beforeLiveUpdate = await position();
  await page.evaluate(() => window.__pixelTest.downloadState("failed"));
  await expect(line("message")).toHaveText("资源服务器连接中断");
  await checkIcon(
    "loading-to-error-icon",
    beforeErrorIcon,
    "lucide-loader-circle",
    "lucide-circle-alert",
  );
  const afterLiveUpdate = await position(0);
  expect(afterLiveUpdate.x).toBeCloseTo(beforeLiveUpdate.x, 3);
  expect(afterLiveUpdate.y).toBeCloseTo(beforeLiveUpdate.y, 3);
  checks.push({
    name: "status-update-during-position-animation",
    beforeLiveUpdate,
    afterLiveUpdate,
  });
  await transition(
    "launch-error",
    "message",
    "补全游戏文件 · 5 / 10 个文件",
    "资源服务器连接中断",
  );
  await expect(
    page.locator(".launch-status-detail .footer-icon-current > svg"),
  ).toHaveClass(/lucide-circle-alert/);

  await page.setViewportSize({ width: 375, height: 640 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await nav("设置");
  await finish();
  const oldCaption = await line("player").textContent();
  const narrowPosition = await position();
  const narrowIcon = await iconFrame();
  await nav("开始游戏");
  await checkIcon(
    "narrow-icon-full-motion",
    narrowIcon,
    "dot",
    "lucide-circle-alert",
  );
  await checkPosition("narrow-status-position", narrowPosition);
  const newCaption = await line("player").textContent();
  await transition("narrow-full-motion", "player", oldCaption, newCaption);
  await expect(page.locator(".launch-status-player")).toBeVisible();
  expect(
    await page.evaluate(() => document.body.scrollWidth > innerWidth),
  ).toBe(false);
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/report.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(
    "PASS Footer text and icons animate across both footer types; position changes, rapid reversals, live state updates and independent loading spinners work at desktop and narrow widths.",
  );
} finally {
  await browser.close();
}
