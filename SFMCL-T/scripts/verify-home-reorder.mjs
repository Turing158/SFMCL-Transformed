import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("evidence/home-reorder");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const errors = [];
const checks = [];
const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/";
const preference = "sfmcl-t.home.notice-order";
const fixture = () => {
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__pixelTest.data.settings.homeCleanMode = false;
  window.__pixelTest.data.settings.homeNoticeLayout =
    new URLSearchParams(location.search).get("layout") || "masonry";
  const state = (window.__homeReorder = {
    hidden: JSON.parse(localStorage.getItem("test-reorder-hidden") || "[]"),
    items: Array.from({ length: 8 }, (_, index) => ({
      id: `reorder:${index}`,
      preset: true,
      title: `排序公告 ${index + 1}`,
      category: "测试公告",
      date: "2026-11-03",
      icon: "/assets/DefaultGameIcon/Minecraft.png",
      content:
        index === 0
          ? Array.from(
              { length: 8 },
              () => "较长的公告正文，拖动时应保持卡片高度与展开状态。",
            ).join("\n\n")
          : "简短公告正文。 [查看链接](https://example.com)",
    })),
    motions: [],
  });
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (frames, options) {
    const animation = animate.call(this, frames, options);
    if (options?.id?.startsWith("sfmcl-t-notice-"))
      state.motions.push({
        id: options.id,
        duration: options.duration,
        key: this.dataset.noticeKey,
        frames,
      });
    return animation;
  };
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "request") {
      if (args.operation === "notices.list")
        return structuredClone(state.items);
      if (args.operation === "notices.refresh")
        return { items: structuredClone(state.items), error: "" };
      if (args.operation === "notices.hidden") return [...state.hidden];
      if (args.operation === "notices.visibility") {
        state.hidden = state.hidden.filter((id) => id !== args.payload.id);
        if (args.payload.hidden) state.hidden.push(args.payload.id);
        localStorage.setItem(
          "test-reorder-hidden",
          JSON.stringify(state.hidden),
        );
        return [...state.hidden];
      }
    }
    return invoke(command, args);
  };
};
const createPage = async (touch = false) => {
  const context = await browser.newContext({
    viewport: { width: 1120, height: 800 },
    hasTouch: touch,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript(pixelAppFixture);
  await page.addInitScript(fixture);
  await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
  return page;
};
const list = (page) => page.locator(".notice-home-list");
const row = (page, id) =>
  list(page).locator(`[data-notice-key="notice:reorder:${id}"]`);
const order = (page) =>
  list(page)
    .locator(".notice-list-item")
    .evaluateAll((rows) => rows.map((row) => row.dataset.noticeKey));
const point = async (locator) => {
  const bounds = await locator.boundingBox();
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
};
const hold = async (page, id) => {
  await expect(page.locator("html")).not.toHaveAttribute("data-startup");
  const control = row(page, id).locator(".notice-toggle");
  await control.scrollIntoViewIfNeeded();
  const from = await point(control);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.waitForTimeout(470);
  if (!(await row(page, id).getAttribute("data-notice-placeholder"))) {
    await page.screenshot({ path: `${evidence}/failed-hold.png` });
  }
  await expect(row(page, id)).toHaveAttribute(
    "data-notice-placeholder",
    "true",
  );
  await expect(page.locator(".notice-drag-overlay")).toHaveCount(1);
  return from;
};
const release = async (page) => {
  await page.mouse.up();
  await expect(page.locator(".notice-drag-overlay")).toHaveCount(0);
  await expect(list(page).locator("[data-notice-placeholder]")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveAttribute(
    "data-notice-dragging",
  );
};
const ready = async (page, layout = "masonry") => {
  await page.goto(`${url}?layout=${layout}`);
  await expect(page.locator("html")).not.toHaveAttribute("data-startup");
  await expect(list(page).locator(".notice-toggle")).toHaveCount(8);
  await expect(list(page).locator('[data-notice-phase="stable"]')).toHaveCount(
    8,
  );
  await page.waitForTimeout(400);
};
try {
  const page = await createPage();
  await ready(page);
  // Normal click and an early movement must not become a long press.
  await row(page, 1).locator(".notice-toggle").click();
  await expect(row(page, 1).locator(".notice-toggle")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await row(page, 1).locator(".notice-toggle").click();
  const early = await point(row(page, 1).locator(".notice-toggle"));
  await page.mouse.move(early.x, early.y);
  await page.mouse.down();
  await page.mouse.move(early.x + 24, early.y + 12);
  await page.waitForTimeout(470);
  await expect(page.locator(".notice-drag-overlay")).toHaveCount(0);
  await page.mouse.up();
  await row(page, 1)
    .locator(".notice-toggle")
    .evaluate((node) => {
      if (node.getAttribute("aria-expanded") === "true") node.click();
    });
  checks.push(
    "A short click expands the card; movement before the long-press threshold cancels sorting.",
  );

  for (const layout of ["single", "parallel", "masonry"]) {
    await ready(page, layout);
    await page.evaluate((key) => localStorage.removeItem(key), preference);
    await page.reload();
    await expect(list(page).locator(".notice-toggle")).toHaveCount(8);
    const before = await order(page);
    const dimensions = await row(page, 0).locator(".notice-card").boundingBox();
    await hold(page, 0);
    const slot = await row(page, 0)
      .locator(".notice-drag-placeholder")
      .boundingBox();
    expect(slot.width).toBeCloseTo(dimensions.width, 0);
    expect(slot.height).toBeCloseTo(dimensions.height, 0);
    const destination = await point(row(page, 3).locator(".notice-toggle"));
    await page.mouse.move(destination.x, destination.y);
    await expect
      .poll(() => order(page))
      .toEqual([
        before[1],
        before[2],
        before[3],
        before[0],
        ...before.slice(4),
      ]);
    await expect(list(page).locator("[data-notice-placeholder]")).toHaveCount(
      1,
    );
    const moves = await page.evaluate(() =>
      window.__homeReorder.motions.filter(
        (motion) => motion.id === "sfmcl-t-notice-reorder",
      ),
    );
    expect(moves.length).toBeGreaterThanOrEqual(3);
    expect(moves.every((move) => move.duration === 320)).toBe(true);
    await page.waitForTimeout(100);
    expect(
      await list(page).evaluate((node) =>
        node
          .getAnimations({ subtree: true })
          .some(
            (motion) =>
              motion.id === "sfmcl-t-notice-reorder" &&
              motion.playState === "running",
          ),
      ),
    ).toBe(true);
    await page.screenshot({ path: `${evidence}/drag-${layout}.png` });
    await release(page);
    await expect(row(page, 0).locator(".notice-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    const after = await order(page);
    expect(
      JSON.parse(
        await page.evaluate((key) => localStorage.getItem(key), preference),
      ),
    ).toEqual(after);
    await page.reload();
    await expect.poll(() => order(page)).toEqual(after);
    // Rapidly reverse two swaps while prior displacement animations are running.
    await hold(page, 0);
    const first = await point(row(page, 1).locator(".notice-toggle"));
    await page.mouse.move(first.x, first.y);
    await page.waitForTimeout(60);
    const next = await point(row(page, 4).locator(".notice-toggle"));
    await page.mouse.move(next.x, next.y);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(page.locator(".notice-drag-overlay")).toHaveCount(0);
    expect(await order(page)).toEqual(after);
    await expect(list(page).locator("[data-notice-placeholder]")).toHaveCount(
      0,
    );
    checks.push(
      `${layout}: same-size placeholder follows insertion, neighboring cards animate for 320ms, drop preserves collapse state, order survives reload, and Escape restores the prior order during rapid swaps.`,
    );
  }

  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.evaluate(() => {
    window.__pixelTest.data.settings.theme = "dark";
  });
  await page.getByRole("button", { name: "刷新公告", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await row(page, 0).locator(".notice-toggle").click();
  await page.waitForTimeout(400);
  const expandedHeight = (
    await row(page, 0).locator(".notice-card").boundingBox()
  ).height;
  await hold(page, 0);
  await expect(row(page, 0).locator(".notice-list-content")).toHaveCSS(
    "opacity",
    "0",
  );
  expect(
    (await row(page, 0).locator(".notice-drag-placeholder").boundingBox())
      .height,
  ).toBeCloseTo(expandedHeight, 0);
  const other = await point(row(page, 2).locator(".notice-toggle"));
  await page.mouse.move(other.x, other.y);
  await page.screenshot({ path: `${evidence}/expanded-dark.png` });
  await release(page);
  await expect(row(page, 0).locator(".notice-toggle")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(
    await page.evaluate(() =>
      window.__homeReorder.motions
        .filter((motion) =>
          ["sfmcl-t-notice-reorder", "sfmcl-t-notice-drop"].includes(motion.id),
        )
        .every((motion) => motion.duration === 320),
    ),
  ).toBe(true);
  checks.push(
    "Expanded cards retain their full-height placeholder and expansion state; light/dark styling works and reduced-motion preference retains full sorting and drop animations.",
  );

  // Leaving the retained home page must remove overlay, capture and body cursor.
  await hold(page, 2);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "设置", exact: true })
    .evaluate((node) => node.click());
  await expect(page.locator(".notice-drag-overlay")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveAttribute(
    "data-notice-dragging",
  );
  await page.mouse.up();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "开始游戏", exact: true })
    .click();
  await expect(list(page).locator("[data-notice-placeholder]")).toHaveCount(0);
  await hold(page, 2);
  await page.evaluate(() => {
    window.__homeReorder.items = window.__homeReorder.items.filter(
      (item) => item.id !== "reorder:2",
    );
    document.querySelector(".notice-refresh").click();
  });
  await expect(page.locator(".notice-drag-overlay")).toHaveCount(0);
  await page.mouse.up();
  await expect(list(page).locator(".notice-toggle")).toHaveCount(7);
  checks.push(
    "Page navigation and removal by refresh cancel a drag without leftover overlays, placeholders or a stuck grabbing cursor.",
  );

  await ready(page, "single");
  await page.evaluate(() => {
    const state = window.__homeReorder;
    state.items.push(
      ...Array.from({ length: 24 }, (_, index) => ({
        ...state.items[1],
        id: `reorder:${index + 8}`,
        title: `排序公告 ${index + 9}`,
      })),
    );
    document.querySelector(".notice-refresh").click();
  });
  await expect(list(page).locator(".notice-toggle")).toHaveCount(32);
  const prior = await order(page);
  await hold(page, 0);
  const scroll = page.locator("main.page");
  const scrollBefore = await scroll.evaluate((node) => node.scrollTop);
  const bounds = await scroll.boundingBox();
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height - 12,
  );
  await expect
    .poll(() => scroll.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(scrollBefore + 150);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".notice-drag-overlay")).toHaveCount(0);
  expect(await order(page)).toEqual(prior);
  checks.push(
    "Dragging near the page edge automatically scrolls a long announcement list; cancellation restores all 32 cards in their original order.",
  );

  const touch = await createPage(true);
  await touch.setViewportSize({ width: 600, height: 800 });
  await ready(touch);
  const client = await touch.context().newCDPSession(touch);
  const from = await point(row(touch, 0).locator(".notice-toggle"));
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [from],
  });
  await touch.waitForTimeout(470);
  await expect(row(touch, 0)).toHaveAttribute(
    "data-notice-placeholder",
    "true",
  );
  const destination = await point(row(touch, 3).locator(".notice-toggle"));
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [destination],
  });
  await expect
    .poll(() => order(touch))
    .toEqual([
      "notice:reorder:1",
      "notice:reorder:2",
      "notice:reorder:3",
      "notice:reorder:0",
      "notice:reorder:4",
      "notice:reorder:5",
      "notice:reorder:6",
      "notice:reorder:7",
    ]);
  await touch.screenshot({ path: `${evidence}/touch-narrow.png` });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(touch.locator(".notice-drag-overlay")).toHaveCount(0);
  await expect(row(touch, 0).locator(".notice-toggle")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  checks.push(
    "A narrow touchscreen supports long-press sorting without panning the page or opening the dragged card on release.",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser.close();
}
