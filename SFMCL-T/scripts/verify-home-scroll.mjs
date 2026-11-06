import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("evidence/home-scroll");
const illustratedOnly = process.argv.includes("--illustrated");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
  ignoreDefaultArgs: ["--hide-scrollbars"],
});
const page = await browser.newPage({ viewport: { width: 1120, height: 1000 } });
const checks = [];
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/assets/__home-scroll-image.svg", (route) =>
  route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="772" height="350"><rect width="772" height="350" fill="#32785b"/></svg>',
  }),
);
await page.addInitScript(pixelAppFixture);
await page.addInitScript(() => {
  const query = new URLSearchParams(location.search);
  window.__pixelTest.data.settings.homeCleanMode = query.has("clean");
  window.__pixelTest.data.settings.homeNoticeLayout = query.get("layout");
  let items = Array.from({ length: 6 }, (_, index) => ({
    id: `scroll:${index}`,
    preset: true,
    title: `冒险公告 ${index + 1}`,
    category: "官方新闻",
    date: "2026-11-06",
    icon: "/assets/DefaultGameIcon/Minecraft.png",
    content: Array.from(
      { length: 20 },
      () => "探索世界，准备下一次冒险。展开后应能滚动查看全部内容。",
    ).join("\n\n"),
  }));
  if (query.get("sample") === "news") {
    const image = "\n\n![公告配图](/assets/__home-scroll-image.svg)";
    items = [
      { title: "Minecraft 26.4 Snapshot 7", content: "最新 Java 快照。" },
      { title: "Java版26.4-snapshot-7", content: "查看快照更新内容。" },
      { title: "Halloween on Realms", content: "准备下一次冒险。" },
      {
        title: "Rob a Mob",
        content:
          "Plan the perfect heist in Rob a Mob, a new collect-and-steal adventure. Hunt valuable mobs, discover rare mutations, and build your collection. Unlock PvP to raid rival bases and steal their best mobs. Just remember to defend your mobs too!" +
          image,
      },
      {
        title: "Domino’s x Minecraft Dungeons II",
        content:
          "Domino’s x Minecraft Dungeons II is here! Order the new Domino, the perfect gaming companion, and get 1 of 3 exclusive in-game items. Fuel up and gear up for Minecraft Dungeons II – out now." +
          image,
      },
    ].map((item, index) => ({
      ...item,
      id: `news:scroll:${index}`,
      preset: false,
      category: "官方新闻",
      date: "2026-11-06",
      icon: "/assets/DefaultGameIcon/Minecraft.png",
    }));
  }
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "request" && args.operation === "notices.list")
      return structuredClone(items);
    if (command === "request" && args.operation === "notices.refresh")
      return { items: structuredClone(items), error: "" };
    return invoke(command, args);
  };
});
const main = page.locator("main.page");
const card = page.locator(".launch-dock-main");
const toggles = page.locator("main.page .notice-toggle");
const read = () =>
  page.evaluate(() => {
    const main = document.querySelector("main.page");
    const card = document.querySelector(".launch-dock-main");
    const dock = card.parentElement;
    const status = dock.querySelector(".launch-status");
    const content = main.querySelector(".home-content");
    const last = Math.max(
      ...Array.from(
        main.querySelectorAll(".page-heading, .notice-card"),
        (item) => item.getBoundingClientRect().bottom,
      ),
    );
    return {
      scroll: main.scrollHeight - main.clientHeight,
      width: main.clientWidth,
      top: main.scrollTop,
      last,
      padding: parseFloat(getComputedStyle(main).paddingBottom),
      base: parseFloat(
        getComputedStyle(main).getPropertyValue("--page-bottom-padding"),
      ),
      contentBottom: content.getBoundingClientRect().bottom,
      cardTop: card.getBoundingClientRect().top,
      cardBottom: card.getBoundingClientRect().bottom,
      mainBottom: main.getBoundingClientRect().bottom,
      statusTop: status.getBoundingClientRect().top,
      cover:
        dock.getBoundingClientRect().height -
        status.getBoundingClientRect().height,
    };
  });
const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/";
try {
  for (const layout of illustratedOnly
    ? []
    : ["single", "parallel", "masonry"]) {
    for (const width of [1120, 768, 375]) {
      await page.setViewportSize({ width, height: 1400 });
      await page.goto(`${url}?layout=${layout}`);
      await expect(toggles).toHaveCount(6);
      await expect(page.locator("html")).not.toHaveAttribute("data-startup");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      const natural = await read();
      // All real cards fit above the dock, but the previous fixed padding
      // extended the page beyond its viewport at this height.
      const height = Math.ceil(natural.last + natural.cover + 40);
      await page.setViewportSize({ width, height });
      await expect.poll(async () => (await read()).scroll).toBe(0);
      const short = await read();
      expect(short.last).toBeLessThan(short.cardTop - 8);
      expect(short.padding).toBe(short.base);
      expect(short.mainBottom).toBeCloseTo(short.statusTop, 3);
      await main.hover({ position: { x: 10, y: 10 } });
      await page.mouse.wheel(0, 300);
      expect((await read()).top).toBe(0);

      if (width === 1120 && layout === "masonry") {
        const old = await page.addStyleTag({
          content:
            '.page[data-page="home"] { padding-bottom: calc(var(--page-bottom-padding) + var(--launch-dock-height) - 28px) !important; }',
        });
        expect((await read()).scroll).toBeGreaterThan(0);
        await old.evaluate((element) => element.remove());
        await expect.poll(async () => (await read()).scroll).toBe(0);
        await page.screenshot({ path: `${evidence}/short-light.png` });
      }

      await toggles.last().click();
      await expect.poll(async () => (await read()).scroll).toBeGreaterThan(100);
      await expect(page.locator(".notice-body").last()).toHaveCSS(
        "opacity",
        "1",
      );
      await main.evaluate(
        (element) => (element.scrollTop = element.scrollHeight),
      );
      await expect
        .poll(async () => {
          const state = await read();
          return state.last - state.cardTop;
        })
        .toBeLessThanOrEqual(-7);
      const long = await read();
      expect(long.cardTop).toBe(short.cardTop);
      // Record actual wheel frames, including when the pointer is over the
      // expanded article. Neither the range nor the direction may change.
      const scrollBounds = await main.boundingBox();
      await main.evaluate((element) => (element.scrollTop = 120));
      await page.mouse.move(scrollBounds.x + 25, scrollBounds.y + 80);
      const wheelFrames = [];
      for (const delta of [60, 60, 60, 60, -60, -60, -60, -60]) {
        const before = await read();
        await page.mouse.wheel(0, delta);
        const frames = await main.evaluate(async (element) => {
          const frames = [];
          for (let index = 0; index < 12; index++) {
            await new Promise(requestAnimationFrame);
            frames.push({
              top: element.scrollTop,
              range: element.scrollHeight - element.clientHeight,
              padding: getComputedStyle(element).paddingBottom,
            });
          }
          return frames;
        });
        let previous = before.top;
        for (const frame of frames) {
          expect(
            (frame.top - previous) * Math.sign(delta),
          ).toBeGreaterThanOrEqual(-1);
          expect(frame.range).toBe(long.scroll);
          expect(parseFloat(frame.padding)).toBe(long.padding);
          previous = frame.top;
        }
        expect((previous - before.top) * Math.sign(delta)).toBeGreaterThan(0);
        wheelFrames.push(...frames);
      }

      if (layout === "masonry" && width === 1120) {
        await main.evaluate((element) => (element.scrollTop = 0));
        const thumb = await main.evaluate(
          (element) => element.clientHeight ** 2 / element.scrollHeight,
        );
        const x = scrollBounds.x + scrollBounds.width - 3;
        const start = scrollBounds.y + thumb / 2;
        await page.mouse.move(x, start);
        await page.mouse.down();
        let previous = (await read()).top;
        let previousFraction = 0;
        for (const fraction of [0.25, 0.5, 0.75, 0.5, 0.25]) {
          const direction = Math.sign(fraction - previousFraction);
          await page.mouse.move(
            x,
            start + fraction * (scrollBounds.height - thumb),
          );
          await page.waitForTimeout(50);
          const state = await read();
          expect(state.scroll).toBe(long.scroll);
          expect((state.top - previous) * direction).toBeGreaterThan(0);
          previous = state.top;
          previousFraction = fraction;
        }
        await page.mouse.up();
      }
      await main.evaluate(
        (element) => (element.scrollTop = element.scrollHeight),
      );
      // Hit testing demonstrates that the card sits over the scroll content.
      expect(
        await card.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(rect.x + 20, rect.y + 20),
          );
        }),
      ).toBe(true);
      await card.hover();
      await expect(card).toHaveCSS("scale", "1");
      expect((await read()).scroll).toBe(long.scroll);
      await page.mouse.move(2, 2);
      await expect(card).toHaveCSS("scale", "0.98");
      if (layout === "masonry" && [1120, 375].includes(width)) {
        await main.evaluate((element) => (element.scrollTop -= 140));
        expect((await read()).last).toBeGreaterThan((await read()).cardTop);
        expect(
          await card.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const main = document.querySelector("main.page");
            return (
              element.contains(
                document.elementFromPoint(rect.right - 30, rect.top + 20),
              ) &&
              main.contains(
                document.elementFromPoint(rect.left - 3, rect.top + 20),
              )
            );
          }),
        ).toBe(true);
        await page.screenshot({ path: `${evidence}/floating-${width}.png` });
      }
      await toggles.last().focus();
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await read()).scroll).toBe(0);
      expect((await read()).top).toBe(0);
      checks.push({
        layout,
        width,
        height,
        shortScroll: short.scroll,
        wheelFrames: wheelFrames.length,
      });
    }
  }
  // A short scroll range with two illustrated masonry cards reproduces the
  // 500ms polling bug: cleared row spans used to clamp scrollTop near zero.
  await page.setViewportSize({ width: 900, height: 560 });
  await page.goto(`${url}?layout=masonry&sample=news`);
  await expect(toggles).toHaveCount(5);
  await expect(page.locator("html")).not.toHaveAttribute("data-startup");
  await toggles.evaluateAll((nodes) =>
    nodes.slice(-2).forEach((node) => node.click()),
  );
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".notice-content img")).every(
      (image) => image.complete && image.naturalWidth === 772,
    ),
  );
  await page.waitForTimeout(400);
  await expect.poll(async () => (await read()).scroll).toBeGreaterThan(100);
  await main.evaluate((element) => (element.scrollTop = element.scrollHeight));
  const pollingStart = await read();
  const pollingCount = () =>
    page.evaluate(
      () =>
        window.__pixelTest.requests.filter(
          (request) => request.operation === "tasks",
        ).length,
    );
  const beforePolls = await pollingCount();
  const holdPosition = async (duration) =>
    main.evaluate(async (element, duration) => {
      const frames = [];
      const start = performance.now();
      while (performance.now() - start < duration) {
        await new Promise(requestAnimationFrame);
        frames.push({
          top: element.scrollTop,
          range: element.scrollHeight - element.clientHeight,
        });
      }
      return frames;
    }, duration);
  const pollingFrames = await holdPosition(1600);
  for (const frame of pollingFrames) {
    expect(frame.top).toBe(pollingStart.top);
    expect(frame.range).toBe(pollingStart.scroll);
  }
  expect((await pollingCount()) - beforePolls).toBeGreaterThanOrEqual(3);
  await page.locator(".notice-refresh").evaluate((element) => element.click());
  await expect(page.locator(".notices")).toHaveAttribute("aria-busy", "false");
  const refreshFrames = await holdPosition(1100);
  for (const frame of refreshFrames) {
    expect(frame.top).toBe(pollingStart.top);
    expect(frame.range).toBe(pollingStart.scroll);
  }
  await main.evaluate((element) => (element.scrollTop = 0));
  const newsBounds = await main.boundingBox();
  await page.mouse.move(newsBounds.x + 300, newsBounds.y + 150);
  let previousTop = 0;
  for (let step = 0; step < 10; step++) {
    await page.mouse.wheel(0, 40);
    const frames = await holdPosition(150);
    for (const frame of frames) {
      expect(frame.top).toBeGreaterThanOrEqual(previousTop);
      expect(frame.range).toBe(pollingStart.scroll);
      previousTop = frame.top;
    }
  }
  expect(previousTop).toBe(pollingStart.scroll);

  // Keep the native thumb held across multiple background task refreshes,
  // with the same short illustrated list that previously jumped near zero.
  await main.evaluate((element) => (element.scrollTop = 0));
  const newsThumb = await main.evaluate(
    (element) => element.clientHeight ** 2 / element.scrollHeight,
  );
  const trackX = newsBounds.x + newsBounds.width - 3;
  const thumbStart = newsBounds.y + newsThumb / 2;
  const trackTravel = newsBounds.height - newsThumb;
  const dragPollsBefore = await pollingCount();
  const dragFrames = [];
  await page.mouse.move(trackX, thumbStart);
  await page.mouse.down();
  let previousFraction = 0;
  previousTop = (await read()).top;
  try {
    for (const fraction of [0.2, 0.4, 0.6, 0.8, 0.6, 0.4, 0.2, 0]) {
      const direction = Math.sign(fraction - previousFraction);
      await page.mouse.move(trackX, thumbStart + trackTravel * fraction);
      // Native thumb movement is applied by the compositor after mouse dispatch.
      await page.waitForTimeout(50);
      const position = (await read()).top;
      expect((position - previousTop) * direction).toBeGreaterThan(0);
      expect(Math.abs(position - pollingStart.scroll * fraction)).toBeLessThan(
        4,
      );
      const frames = await holdPosition(fraction === 0.4 ? 1600 : 600);
      for (const frame of frames) {
        // Native thumb movement may settle by one pixel after dispatch.
        expect(Math.abs(frame.top - position)).toBeLessThanOrEqual(1);
        expect(frame.range).toBe(pollingStart.scroll);
      }
      dragFrames.push(...frames);
      previousTop = position;
      previousFraction = fraction;
    }
  } finally {
    await page.mouse.up();
  }
  expect(previousTop).toBe(0);
  const dragPolls = (await pollingCount()) - dragPollsBefore;
  expect(dragPolls).toBeGreaterThanOrEqual(8);
  checks.push({
    sample: "illustrated-masonry",
    scrollRange: pollingStart.scroll,
    pollingFrames: pollingFrames.length,
    refreshFrames: refreshFrames.length,
    downwardWheelSteps: 10,
    nativeDragFrames: dragFrames.length,
    taskPollsDuringDrag: dragPolls,
  });
  for (const [width, height] of illustratedOnly
    ? []
    : [
        [1120, 320],
        [375, 480],
      ]) {
    await page.setViewportSize({ width, height });
    await page.goto(`${url}?clean=on`);
    await expect(page.locator(".home-content-clean")).toBeVisible();
    await expect.poll(async () => (await read()).scroll).toBe(0);
    expect((await read()).last).toBeLessThan((await read()).cardTop);
    await page.evaluate(
      () => (document.documentElement.dataset.theme = "dark"),
    );
    await page.screenshot({ path: `${evidence}/clean-${width}.png` });
    checks.push({ clean: true, width, height, scroll: 0 });
  }
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` });
  console.log(await read());
  throw error;
} finally {
  await browser.close();
}
