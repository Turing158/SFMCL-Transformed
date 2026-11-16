import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { launchDockFixture } from "./fixtures/launch-dock.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence =
  process.env.SFMCL_T_FOOTER_TEXT_EVIDENCE ||
  runtimePath("evidence/footer-text");
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
          y:
            node.getBoundingClientRect().top - host.getBoundingClientRect().top,
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
  const primary = page.locator(".launch-primary");
  const dock = page.locator(".launch-dock");
  const checkLaunchFooter = async () => {
    await expect(
      dock.locator(
        '[data-footer-text="message"], [data-footer-text="step"], .footer-status-icon',
      ),
    ).toHaveCount(0);
    await expect(line("player")).toBeVisible();
  };
  await checkLaunchFooter();
  await expect(primary).toHaveAttribute("data-tooltip", "准备就绪");

  let caption = await line("player").textContent();
  await nav("角色管理");
  await expect(line("message")).toHaveText("准备就绪");
  await expect(page.locator(".footer-status-icon")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await transition(
    "home-to-players",
    "player",
    caption,
    await line("player").textContent(),
  );
  caption = await line("player").textContent();
  const sameKindIcons = await iconCount();
  await nav("版本管理");
  expect(await iconCount()).toBe(sameKindIcons);
  await transition(
    "players-to-versions",
    "player",
    caption,
    await line("player").textContent(),
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

  caption = await line("player").textContent();
  await nav("开始游戏");
  await checkLaunchFooter();
  await transition(
    "versions-to-home",
    "player",
    caption,
    await line("player").textContent(),
  );
  await nav("角色管理");
  const interrupted = await sample("player", 90);
  await nav("开始游戏");
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
  checks.push({ name: "rapid-player-caption-reversal", interrupted, resumed });

  const captionCount = await page.evaluate(
    () => window.__textMotions.filter((m) => m.slot === "player").length,
  );
  await primary.click();
  await expect(primary).toHaveAccessibleName("正在启动 0%");
  await expect(primary).toHaveAttribute("data-tooltip", /检查游戏与 Java/);
  await checkLaunchFooter();
  expect(
    await primary
      .locator(".launch-button-base > svg.spin")
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
  await page.evaluate(() => window.__pixelTest.advanceLaunch(1));
  await expect(primary).toHaveAccessibleName("正在启动 25%");
  await expect(primary).toHaveAttribute("data-tooltip", /第 2 \/ 4 步/);
  expect(
    await page.evaluate(
      () => window.__textMotions.filter((m) => m.slot === "player").length,
    ),
  ).toBe(captionCount);
  await nav("版本管理");
  await finish();
  await expect(line("message")).toHaveText("准备就绪");
  await page.evaluate(() => window.__pixelTest.downloadState("running"));
  await transition(
    "generic-download-status",
    "message",
    "准备就绪",
    "1 个下载正在进行",
  );
  await nav("开始游戏");
  await finish();
  await checkLaunchFooter();
  await page.evaluate(() => window.__pixelTest.downloadState("failed"));
  await expect(primary).toHaveAccessibleName("重试下载");
  await expect(primary).toHaveAttribute("data-tooltip", /资源服务器连接中断/);
  await checkLaunchFooter();
  checks.push({
    name: "launch-feedback-stays-in-button-with-independent-player-caption",
  });

  await page.setViewportSize({ width: 375, height: 640 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await nav("设置");
  await finish();
  caption = await line("player").textContent();
  await nav("开始游戏");
  await transition(
    "narrow-player-caption",
    "player",
    caption,
    await line("player").textContent(),
  );
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
    "PASS Player captions retain their motion through navigation and rapid reversals; generic download feedback and button-only launch status work at desktop and narrow widths.",
  );
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` });
  throw error;
} finally {
  await browser.close();
}
