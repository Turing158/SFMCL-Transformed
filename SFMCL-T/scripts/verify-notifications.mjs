import { runtimePath } from "./lib/paths.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";

const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/";
const evidence = runtimePath("evidence/notifications");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
const cards = page.locator(".notification-slot");
const deck = page.getByRole("region", { name: "通知", exact: true });
const notify = (messages) =>
  page.evaluate((items) => {
    items.forEach((message) => window.__notificationTest.notify(message));
  }, messages);
const advance = async (ms) => {
  await page.clock.runFor(ms);
  // Let React commit passive effects before advancing a subsequent timer.
  await page.evaluate(() => new Promise((resolve) => queueMicrotask(resolve)));
};
const settle = async () => {
  // Browser CSS transitions use wall time, independently of Playwright's JS clock.
  for (let pass = 0; pass < 2; pass++) {
    await deck.evaluate((element) =>
      Promise.allSettled(
        element
          .getAnimations({ subtree: true })
          .filter(
            (animation) => animation.animationName !== "notification-countdown",
          )
          .map((animation) => animation.finished),
      ),
    );
  }
};
const ready = async () => {
  await page.mouse.move(20, 20);
  await page.goto(new URL("scripts/fixtures/notifications.html", url).href);
  await expect(
    page.getByRole("heading", { name: "你好，Alex", exact: true }),
  ).toBeVisible();
  await page.waitForFunction(() => !!window.__notificationTest);
  const time = new Date("2026-10-17T04:00:00Z");
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  await advance(300);
  if (await cards.count()) await settle();
};
const shot = (name) => page.screenshot({ path: `${evidence}/${name}.png` });

try {
  await ready();
  await notify(["设置已保存", "已加入下载队列", "已切换到 1.21.4"]);
  await expect(cards).toHaveCount(3);
  await advance(300);
  if (await cards.count()) await settle();
  await expect(deck).toHaveAttribute("data-expanded", "false");
  await expect(cards.first()).toHaveText("已切换到 1.21.4");
  const collapsed = await cards.evaluateAll((items) =>
    items.map((item) => ({
      y: item.getBoundingClientRect().y,
      z: Number(getComputedStyle(item).zIndex),
      inert: item.inert,
    })),
  );
  expect(collapsed[0].y - collapsed[1].y).toBeCloseTo(8, 0);
  expect(collapsed[1].y - collapsed[2].y).toBeCloseTo(8, 0);
  expect(collapsed[0].z).toBeGreaterThan(collapsed[1].z);
  expect(collapsed[1].inert).toBe(true);
  await shot("collapsed-light");
  await cards.first().locator("button").hover();
  await advance(300);
  if (await cards.count()) await settle();
  await expect(deck).toHaveAttribute("data-expanded", "true");
  const expanded = await cards.evaluateAll((items) =>
    items.map((item) => {
      const rect = item.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        inert: item.inert,
      };
    }),
  );
  for (let i = 1; i < expanded.length; i++) {
    expect(expanded[i - 1].top - expanded[i].bottom).toBeGreaterThanOrEqual(7);
    expect(expanded[i].inert).toBe(false);
  }
  expect(expanded[0].width).toBeGreaterThanOrEqual(240);
  expect(expanded[0].width).toBeLessThanOrEqual(320);
  await shot("expanded-light");
  await cards.nth(1).locator("button").click();
  await expect(cards.nth(1).locator(".notification-motion")).toHaveAttribute(
    "data-state",
    "click",
  );
  await advance(230);
  await expect(cards).toHaveCount(2);
  expect(await page.locator(".notification-message").allTextContents()).toEqual(
    ["已切换到 1.21.4", "设置已保存"],
  );
  await page.mouse.move(20, 20);
  await advance(300);
  if (await cards.count()) await settle();
  await expect(deck).toHaveAttribute("data-expanded", "false");
  checks.push(
    "Newest-first collapsed deck, hover expansion, individual click exit and animated reflow",
  );

  await ready();
  await notify(["独立计时 A", "独立计时 B"]);
  await advance(300);
  if (await cards.count()) await settle();
  await cards.first().locator("button").hover();
  await expect(cards.first().locator("button")).toHaveAttribute(
    "data-paused",
    "true",
  );
  await advance(5000);
  await advance(230);
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("独立计时 B");
  await advance(6000);
  await expect(cards).toHaveCount(1);
  await page.mouse.move(20, 20);
  await expect(cards.first().locator("button")).toHaveAttribute(
    "data-paused",
    "false",
  );
  await advance(4700);
  await expect(cards).toHaveCount(1);
  // Hover again just before expiry: the old timeout must be cancelled.
  await cards.first().locator("button").hover();
  await advance(800);
  await expect(cards).toHaveCount(1);
  await page.mouse.move(20, 20);
  await advance(4990);
  await expect(cards.first().locator(".notification-motion")).toHaveAttribute(
    "data-state",
    "visible",
  );
  await advance(20);
  await expect(cards.first().locator(".notification-motion")).toHaveAttribute(
    "data-state",
    "timeout",
  );
  await advance(230);
  await expect(cards).toHaveCount(0);
  await expect(deck).toBeHidden();
  checks.push(
    "Only hovered card pauses; repeated hover cancels stale timers and every leave restarts a full 5000 ms",
  );

  await ready();
  await notify(["相同的提醒", "相同的提醒", ""]);
  await page.evaluate(() =>
    window.__notificationTest.run(async () => {
      throw new Error("文件无法写入，请检查目录权限");
    }),
  );
  await notify(["新的成功提醒"]);
  await expect(cards).toHaveCount(4);
  await expect(page.locator(".toast.error")).toHaveCount(1);
  const ids = await cards.evaluateAll((items) =>
    items.map((item) => item.dataset.notificationId),
  );
  expect(new Set(ids).size).toBe(4);
  await advance(5010);
  await advance(230);
  await expect(cards).toHaveCount(0);
  checks.push(
    "Duplicate messages receive separate IDs; success and error coexist, and all expire independently",
  );

  await ready();
  await notify(["键盘关闭第一条", "键盘关闭第二条"]);
  await advance(300);
  if (await cards.count()) await settle();
  // Begin keyboard navigation at the end of the document, without a mouse hover.
  await page.keyboard.press("Shift+Tab");
  await expect(cards.first().locator("button")).toBeFocused();
  await expect(deck).toHaveAttribute("data-expanded", "true");
  await advance(5400);
  await advance(230);
  await expect(cards).toHaveCount(1);
  await page.keyboard.press("Enter");
  await advance(230);
  await expect(cards).toHaveCount(0);
  checks.push(
    "Keyboard focus expands the deck and pauses its card; Enter dismisses it",
  );

  await ready();
  await page.evaluate(() => {
    window.__pixelTest.failures.tasks = "临时网络错误";
  });
  await advance(2000);
  await expect(page.locator(".toast.error")).toHaveCount(1);
  await page.evaluate(() => {
    delete window.__pixelTest.failures.tasks;
  });
  await advance(600);
  await page.evaluate(() => {
    window.__pixelTest.failures.tasks = "临时网络错误";
  });
  await advance(600);
  await expect(page.locator(".toast.error")).toHaveCount(2);
  checks.push(
    "Polling reports an outage once, and reports a new outage after recovery",
  );

  for (const theme of ["light", "dark"]) {
    for (const accent of ["forest", "puce", "ebony"]) {
      await ready();
      await page.evaluate(
        ({ theme, accent }) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.accent = accent;
        },
        { theme, accent },
      );
      await notify(["已加入下载队列", "设置已保存"]);
      await page.evaluate(() =>
        window.__notificationTest.run(async () => {
          throw new Error("无法连接下载服务器，请稍后重试。");
        }),
      );
      await advance(300);
      if (await cards.count()) await settle();
      await cards.first().locator("button").hover();
      await advance(300);
      if (await cards.count()) await settle();
      await shot(`expanded-${theme}-${accent}`);
      const bounds = await deck.boundingBox();
      const dock = await page.locator(".launch-dock").boundingBox();
      expect(bounds.y + bounds.height).toBeLessThan(dock.y);
      const geometry = await cards
        .first()
        .locator(".surface-frame")
        .first()
        .evaluate((frame) => ({
          outer: getComputedStyle(frame).clipPath,
          inner: getComputedStyle(frame, "::after").clipPath,
        }));
      expect(geometry.outer).toContain("polygon");
      expect(geometry.inner).toContain("polygon");
      expect(geometry.inner).not.toBe(geometry.outer);
    }
  }
  checks.push(
    "All six theme combinations use the shared pixel outer and eroded inner corners, above the launch dock",
  );

  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await ready();
    await notify([
      "短消息",
      "长路径：C:/" + "Minecraft-资源包目录/".repeat(25),
      ...Array.from({ length: 8 }, (_, i) => `连续通知 ${i + 1}`),
    ]);
    await advance(300);
    if (await cards.count()) await settle();
    await cards.first().locator("button").hover();
    await advance(300);
    if (await cards.count()) await settle();
    const rect = await deck.boundingBox();
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(width);
    expect(rect.y).toBeGreaterThanOrEqual(40);
    const dimensions = await cards
      .first()
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(dimensions).toBeGreaterThanOrEqual(240);
    expect(dimensions).toBeLessThanOrEqual(320);
    const viewport = page.locator(".notification-viewport");
    expect(
      await viewport.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true);
    await viewport.evaluate((element) => {
      element.scrollTop = -element.scrollHeight;
    });
    await advance(300);
    if (await cards.count()) await settle();
    await expect(cards.last()).toBeInViewport();
    await shot(`overflow-${width}`);
  }
  checks.push(
    "375/768/1024/1440 px: bounded card widths, wrapped long messages and scrollable overflow with every card reachable",
  );

  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(checks.map((check) => `PASS ${check}`).join("\n"));
} catch (error) {
  await shot("failure");
  throw error;
} finally {
  await browser.close();
}
