import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { waitForAutoSave } from "./lib/auto-save.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("evidence/home-settings");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 800 } });
page.setDefaultTimeout(8000);
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture, { persistJavaLists: true });
await page.addInitScript(() => {
  if (!sessionStorage.getItem("pixel-test-java-settings")) {
    // A config from before these settings existed receives the new defaults.
    delete window.__pixelTest.data.settings.homeCleanMode;
    delete window.__pixelTest.data.settings.homeNoticeLayout;
  }
  window.__homeSettings = {
    hidden: [],
    items: Array.from({ length: 6 }, (_, index) => ({
      id: `home-settings:${index}`,
      preset: true,
      title: `布局公告 ${index + 1}`,
      category: "官方新闻",
      date: "2026-11-02",
      icon: "/assets/DefaultGameIcon/Minecraft.png",
      content:
        index === 0
          ? Array.from(
              { length: 5 },
              () => "较长的公告正文，用于验证展开后的排版。",
            ).join("\n\n")
          : "简短的公告正文。",
    })),
  };
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    const state = window.__homeSettings;
    if (command === "request") {
      if (args.operation === "notices.list")
        return structuredClone(state.items);
      if (args.operation === "notices.refresh")
        return { items: structuredClone(state.items), error: "" };
      if (args.operation === "notices.hidden") return [...state.hidden];
      if (args.operation === "notices.visibility") {
        state.hidden = state.hidden.filter((id) => id !== args.payload.id);
        if (args.payload.hidden) state.hidden.push(args.payload.id);
        return [...state.hidden];
      }
    }
    return invoke(command, args);
  };
});
const nav = (name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const notices = page.getByRole("region", { name: "启动器公告", exact: true });
const list = notices.locator(".notice-home-list");
const toggles = notices.locator(".notice-toggle");
const clean = page.getByRole("switch", { name: "干净模式", exact: true });
const layout = page.getByRole("combobox", { name: "公告布局", exact: true });
const config = () => page.evaluate(() => window.__pixelTest.data.settings);
const boxes = () =>
  toggles.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.closest(".notice-card").getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }),
  );
const noOverflow = async () => {
  expect(
    await notices.evaluate((node) => node.scrollWidth - node.clientWidth),
  ).toBeLessThanOrEqual(1);
};
const screenshot = async (name) => {
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${evidence}/${name}.png` });
};
const noOverlaps = async () => {
  await expect
    .poll(async () => {
      const cards = await boxes();
      return cards.every((card, index) =>
        cards
          .slice(index + 1)
          .every(
            (next) =>
              card.x + card.width <= next.x + 0.5 ||
              next.x + next.width <= card.x + 0.5 ||
              card.y + card.height <= next.y + 0.5 ||
              next.y + next.height <= card.y + 0.5,
          ),
      );
    })
    .toBe(true);
};
const select = async (option, value) => {
  await nav("设置");
  await layout.click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await waitForAutoSave(page);
  expect((await config()).homeNoticeLayout).toBe(value);
  await nav("开始游戏");
  await expect(list).toHaveAttribute("data-notice-layout", value);
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await expect(toggles).toHaveCount(6);
  await expect(list).toHaveAttribute("data-notice-layout", "masonry");
  expect(
    await toggles.evaluateAll((nodes) =>
      nodes.every((node) => node.getAttribute("aria-expanded") === "false"),
    ),
  ).toBe(true);
  const defaultCards = await boxes();
  expect(defaultCards[1].x).toBeGreaterThan(defaultCards[0].x);
  await nav("设置");
  await expect(
    page.getByRole("heading", { name: "开始游戏界面", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "显示公告", exact: true }),
  ).toHaveCount(0);
  await expect(clean).toHaveAttribute("aria-checked", "false");
  await expect(layout).toContainText("双列瀑布布局（默认）");
  await clean.scrollIntoViewIfNeeded();
  await screenshot("settings-light");
  checks.push(
    "Old configs without a saved layout receive clean mode off and two-column masonry with collapsed cards; the new settings card replaces the notice switch.",
  );

  await select("一行一个折叠面板", "single");
  const single = await boxes();
  expect(
    single.every(
      (box) => box.x === single[0].x && box.width === single[0].width,
    ),
  ).toBe(true);

  await select("双列平行布局", "parallel");
  const parallel = await boxes();
  expect(parallel[0].y).toBe(parallel[1].y);
  expect(parallel[1].x).toBeGreaterThan(parallel[0].x + parallel[0].width);
  expect(parallel[2].y).toBe(parallel[3].y);
  await toggles.nth(0).click();
  await expect(toggles.nth(0)).toHaveAttribute("aria-expanded", "true");
  await expect(notices.locator(".notice-body").first()).toHaveCSS(
    "opacity",
    "1",
  );
  await expect
    .poll(async () => {
      const rows = await boxes();
      return rows[2].y >= rows[0].y + rows[0].height && rows[2].y === rows[3].y;
    })
    .toBe(true);
  await noOverflow();
  await screenshot("parallel-light");
  await noOverlaps();
  checks.push(
    "Parallel cards align in rows, and expanding a long card moves the whole next row below it.",
  );

  await select("双列瀑布布局（默认）", "masonry");
  await expect(toggles.nth(0)).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(async () => {
      const rows = await boxes();
      return rows[2].x === rows[1].x && rows[2].y < rows[0].y + rows[0].height;
    })
    .toBe(true);
  await toggles.nth(1).click();
  await expect
    .poll(async () => {
      const rows = await boxes();
      return rows[2].y >= rows[1].y + rows[1].height;
    })
    .toBe(true);
  await noOverflow();
  await screenshot("masonry-light");
  await noOverlaps();
  const order = await toggles.allTextContents();
  expect(order.map((title) => title.match(/布局公告 \d/)[0])).toEqual(
    Array.from({ length: 6 }, (_, i) => `布局公告 ${i + 1}`),
  );
  const hide = notices.getByRole("button", {
    name: "隐藏公告：布局公告 2",
    exact: true,
  });
  await hide.focus();
  await page.keyboard.press("Enter");
  await expect(toggles).toHaveCount(5);
  await expect(list.locator('[data-notice-phase="exiting"]')).toHaveCount(0);
  await noOverflow();
  await noOverlaps();
  checks.push(
    "Masonry cards fill available column space, reflow on expansion/removal, and keep DOM and keyboard order.",
  );

  for (const mode of ["light", "dark"]) {
    await nav("设置");
    if (mode === "dark") {
      await page.getByRole("button", { name: "深色", exact: true }).click();
      await waitForAutoSave(page);
    }
    await nav("开始游戏");
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await noOverflow();
      if ((await notices.evaluate((node) => node.clientWidth)) < 540) {
        await expect
          .poll(async () => {
            const rows = await boxes();
            return rows.every((row) => row.x === rows[0].x);
          })
          .toBe(true);
      }
    }
    await screenshot(`masonry-${mode}-wide`);
    await noOverlaps();
  }
  await select("双列平行布局", "parallel");
  await page.setViewportSize({ width: 600, height: 800 });
  expect((await boxes()).every((row, _, rows) => row.x === rows[0].x)).toBe(
    true,
  );
  await noOverflow();
  await select("双列瀑布布局（默认）", "masonry");
  await page.setViewportSize({ width: 1120, height: 800 });
  checks.push(
    "Both themes and both two-column layouts remain readable without overflow; narrow windows revert to one column.",
  );

  await nav("设置");
  await clean.click();
  await waitForAutoSave(page);
  expect(await config()).toMatchObject({
    homeCleanMode: true,
    homeNoticeLayout: "masonry",
  });
  await expect(layout).toBeDisabled();
  await nav("开始游戏");
  await expect(notices).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "新增公告", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "刷新公告", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("main.page > *")).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "你好，Alex", exact: true }),
  ).toBeVisible();
  await expect(page.locator("main.page .page-title-mark")).toBeVisible();
  await expect(page.locator(".launch-dock")).toBeVisible();
  await screenshot("clean-dark");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "你好，Alex", exact: true }),
  ).toBeVisible();
  await expect(notices).toHaveCount(0);
  await nav("设置");
  await expect(clean).toHaveAttribute("aria-checked", "true");
  await expect(layout).toContainText("双列瀑布布局");
  await clean.click();
  await waitForAutoSave(page);
  await nav("开始游戏");
  await expect(toggles).toHaveCount(6);
  await expect(list).toHaveAttribute("data-notice-layout", "masonry");
  checks.push(
    "Clean mode removes all content and actions around the greeting, persists across reload, and restores the saved layout when disabled.",
  );

  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png`, fullPage: true });
  console.log(
    JSON.stringify(
      { viewport: page.viewportSize(), cards: await boxes() },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
