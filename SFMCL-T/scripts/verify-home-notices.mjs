import { chromium, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { runtimePath } from "./lib/paths.mjs";

const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:4180";
const evidence = runtimePath("evidence/home-notices");
await mkdir(evidence, { recursive: true });
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.SFMCL_T_BROWSER_EXECUTABLE
    ? { executablePath: process.env.SFMCL_T_BROWSER_EXECUTABLE }
    : process.platform === "win32" && existsSync(edge)
      ? { executablePath: edge }
      : {}),
});
const page = await browser.newPage({ viewport: { width: 1120, height: 640 } });
page.setDefaultTimeout(8000);
const checks = [];
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(() => {
  window.__pixelTest.data.settings.homeCleanMode =
    new URLSearchParams(location.search).get("clean") === "on";
  window.__homeNotices = {
    fail: false,
    links: [],
    refreshes: [],
    pending: new URLSearchParams(location.search).get("remote") === "pending",
    refreshError: "",
    hidden: JSON.parse(localStorage.getItem("notice-test-hidden") || "[]"),
    custom: JSON.parse(localStorage.getItem("notice-test-custom") || "[]"),
    saves: 0,
    saveFail: false,
    visibilityFail: false,
    savePending: false,
    deletes: 0,
    deleteFail: false,
    deletePending: false,
    tabTransitions: [],
    listMotions: [],
    freezeListMotion: false,
    items: [
      {
        id: "local:fixture:0",
        preset: true,
        title: "欢迎来到 SFMCL-T",
        icon: "/assets/DefaultGameIcon/Minecraft.png",
        content:
          "**准备好下一次冒险。**\n\n公告支持 Markdown、图片和链接。\n\n[查看完整公告](https://example.com/sfmcl-t-notice)\n\n![公告配图](/assets/DefaultGameIcon/Minecraft.png)",
      },
      {
        id: "local:fixture:1",
        preset: true,
        title: "更新说明：这是用于验证窄窗口自动换行的较长公告标题",
        icon: "",
        content: Array.from(
          { length: 12 },
          (_, i) => `### 更新 ${i + 1}\n\n更轻巧的首页，更专注的游戏时光。`,
        ).join("\n\n"),
      },
      {
        id: "local:fixture:2",
        preset: true,
        title: "文件公告",
        icon: "",
        content: "",
        error: "读取公告失败：测试文件不存在。",
      },
    ],
  };
  window.__homeNotices.items.push(...window.__homeNotices.custom);
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (frames, options) {
    const animation = animate.call(this, frames, options);
    if (this.matches(".notice-editor .tab-panel")) {
      window.__homeNotices.tabTransitions.push({
        duration: animation.effect.getTiming().duration,
        frames: animation.effect
          .getKeyframes()
          .map(({ opacity, transform }) => ({ opacity, transform })),
      });
    }
    if (String(options?.id).startsWith("sfmcl-t-notice-list-")) {
      const row = this.closest(".notice-list-item");
      window.__homeNotices.listMotions.push({
        id: options.id,
        list: this.closest(".notice-home-list") ? "home" : "presets",
        key: row?.getAttribute("data-notice-key"),
        phase: row?.getAttribute("data-notice-phase"),
        duration: animation.effect.getTiming().duration,
        frames: animation.effect.getKeyframes(),
      });
      if (window.__homeNotices.freezeListMotion) animation.pause();
    }
    return animation;
  };
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "request" && args.operation === "notices.hidden") {
      return structuredClone(window.__homeNotices.hidden);
    }
    if (command === "request" && args.operation === "notices.visibility") {
      const state = window.__homeNotices;
      if (state.visibilityFail) throw new Error("测试隐藏状态保存失败");
      state.hidden = state.hidden.filter((id) => id !== args.payload.id);
      if (args.payload.hidden) state.hidden.push(args.payload.id);
      localStorage.setItem("notice-test-hidden", JSON.stringify(state.hidden));
      return structuredClone(state.hidden);
    }
    if (command === "request" && args.operation === "notices.create") {
      const state = window.__homeNotices;
      state.saves += 1;
      if (state.saveFail) throw new Error("测试新增公告保存失败");
      const save = () => {
        const item = {
          id: `local:custom:${state.saves}`,
          preset: false,
          title: args.payload.title.trim(),
          content: args.payload.content.trim(),
          category: "自定义公告",
          icon: "",
        };
        state.custom.push(item);
        state.items.push(item);
        localStorage.setItem(
          "notice-test-custom",
          JSON.stringify(state.custom),
        );
        return structuredClone(state.items);
      };
      if (state.savePending)
        return new Promise((resolve) => {
          state.finishSave = () => resolve(save());
        });
      return save();
    }
    if (command === "request" && args.operation === "notices.delete") {
      const state = window.__homeNotices;
      state.deletes += 1;
      if (state.deleteFail) throw new Error("测试删除公告保存失败");
      const item = state.items.find((item) => item.id === args.payload.id);
      if (!item || item.preset) throw new Error("只能删除自定义公告");
      const remove = () => {
        state.custom = state.custom.filter(
          (item) => item.id !== args.payload.id,
        );
        state.items = state.items.filter((item) => item.id !== args.payload.id);
        localStorage.setItem(
          "notice-test-custom",
          JSON.stringify(state.custom),
        );
        return structuredClone(state.items);
      };
      if (state.deletePending)
        return new Promise((resolve) => {
          state.finishDelete = () => resolve(remove());
        });
      return remove();
    }
    if (command === "request" && args.operation === "notices.list") {
      if (window.__homeNotices.fail) throw new Error("测试公告读取失败");
      return structuredClone(window.__homeNotices.items);
    }
    if (command === "request" && args.operation === "notices.refresh") {
      const state = window.__homeNotices;
      state.refreshes.push(args.payload.force);
      if (state.fail) throw new Error("测试公告读取失败");
      if (state.pending) {
        return new Promise((resolve) => {
          state.finish = resolve;
        });
      }
      return { items: structuredClone(state.items), error: state.refreshError };
    }
    if (command === "plugin:opener|open_url") {
      window.__homeNotices.links.push(args.url);
      return;
    }
    return invoke(command, args);
  };
});
const ready = async (suffix = "") => {
  await page.goto(`${url}${suffix}`);
  await page.waitForFunction(
    () => !document.documentElement.hasAttribute("data-startup"),
  );
};
const notices = page.getByRole("region", { name: "启动器公告", exact: true });
const refresh = page.getByRole("button", { name: "刷新公告", exact: true });
const add = page.getByRole("button", { name: "新增公告", exact: true });
const hides = notices.locator(".notice-hide");
const deletes = notices.locator(".notice-delete");
const toggles = notices.locator(".notice-toggle");
const bodies = notices.locator(".notice-body");
const dock = page.locator(".launch-dock");
const hoverNoticeAction = async (button) => {
  await button.locator("..").locator("..").hover();
  await expect(button.locator("..")).toHaveCSS("opacity", "1");
};
const clickNoticeAction = async (button) => {
  await hoverNoticeAction(button);
  await button.click();
};
try {
  await ready();
  await expect(page.getByRole("heading", { name: "你好，Alex" })).toBeVisible();
  await expect(page.locator(".hero, .shortcut-grid, .home-note")).toHaveCount(
    0,
  );
  await expect(page.locator("main.page > *")).toHaveCount(2);
  await expect(dock).toBeVisible();
  const dockBefore = await dock.boundingBox();
  await expect(toggles).toHaveCount(3);
  expect(
    await toggles.evaluateAll((nodes) =>
      nodes.every((node) => node.getAttribute("aria-expanded") === "false"),
    ),
  ).toBe(true);
  expect(
    await bodies.evaluateAll((nodes) =>
      nodes.every(
        (node) => node.inert && node.getBoundingClientRect().height === 0,
      ),
    ),
  ).toBe(true);
  await page.screenshot({ path: `${evidence}/collapsed-light.png` });
  checks.push(
    "Home contains only its existing title and notices; the launch dock is retained; every notice starts collapsed.",
  );

  const firstCard = notices.locator(".notice-card").first();
  const firstHeading = firstCard.locator(".notice-heading");
  const firstControl = firstCard.locator(".notice-control");
  const firstReveal = firstCard.locator(".notice-remove-motion");
  const firstChevron = firstCard.locator(".notice-chevron");
  await page.mouse.move(30, 30);
  await expect(firstReveal).toHaveCSS("opacity", "0");
  await expect(firstChevron).toHaveCSS("opacity", "1");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await firstCard.evaluate((card) => {
    const motion = card.querySelector(".notice-remove-motion");
    const heading = card.querySelector(".notice-heading");
    const timing = { shownAt: null, hideAt: null };
    window.__homeNotices.removePreviewTiming = timing;
    const shown = (event) => {
      if (event.target !== motion || event.propertyName !== "transform") return;
      timing.shownAt = performance.now();
      motion.removeEventListener("transitionend", shown);
    };
    motion.addEventListener("transitionend", shown);
    const changes = new MutationObserver(() => {
      if (heading.dataset.removeVisible !== "false" || timing.shownAt === null)
        return;
      timing.hideAt = performance.now();
      changes.disconnect();
    });
    changes.observe(heading, {
      attributes: true,
      attributeFilter: ["data-remove-visible"],
    });
  });
  await firstCard.hover({ position: { x: 120, y: 12 } });
  await expect(firstReveal).toHaveCSS("opacity", "1");
  await expect(firstChevron).toHaveCSS("opacity", "0");
  const actionPosition = await firstCard.evaluate((card) => {
    const remove = card.querySelector(".notice-remove").getBoundingClientRect();
    const chevron = card
      .querySelector(".notice-chevron")
      .getBoundingClientRect();
    return {
      removeX: remove.x + remove.width / 2,
      removeY: remove.y + remove.height / 2,
      chevronX: chevron.x + chevron.width / 2,
      chevronY: chevron.y + chevron.height / 2,
      duration: getComputedStyle(card.querySelector(".notice-remove-motion"))
        .transitionDuration,
    };
  });
  expect(actionPosition.removeX).toBeCloseTo(actionPosition.chevronX, 1);
  expect(actionPosition.removeY).toBeCloseTo(actionPosition.chevronY, 1);
  expect(actionPosition.duration).toBe("0.18s, 0.22s");
  await expect(firstHeading).toHaveAttribute("data-remove-visible", "false");
  const previewTiming = await page.evaluate(
    () => window.__homeNotices.removePreviewTiming,
  );
  expect(previewTiming.shownAt).not.toBeNull();
  expect(previewTiming.hideAt - previewTiming.shownAt).toBeGreaterThanOrEqual(
    450,
  );
  expect(previewTiming.hideAt - previewTiming.shownAt).toBeLessThan(650);
  await expect(firstReveal).toHaveCSS("opacity", "0");
  await expect(firstChevron).toHaveCSS("opacity", "1");
  await page.mouse.move(30, 30);
  await firstCard.hover({ position: { x: 120, y: 12 } });
  await expect(firstHeading).toHaveAttribute("data-remove-visible", "true");
  await page.mouse.move(30, 30);
  await expect(firstReveal).toHaveCSS("opacity", "0");
  await firstControl.hover();
  await expect(firstReveal).toHaveCSS("opacity", "1");
  await page.waitForTimeout(1100);
  await expect(firstReveal).toHaveCSS("opacity", "1");
  await page.screenshot({ path: `${evidence}/hover-notice-action.png` });
  await firstCard.hover({ position: { x: 120, y: 12 } });
  await expect(firstReveal).toHaveCSS("opacity", "0");
  await expect(firstChevron).toHaveCSS("opacity", "1");
  await page.mouse.move(30, 30);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  checks.push(
    "Hide/delete shares the chevron position and stays hidden by default; each row entry immediately previews it and begins fading 500ms after the entrance ends, control hover holds it beyond the preview timeout, and leaving restores the chevron with full transitions even when reduced motion is requested.",
  );

  await toggles.nth(0).focus();
  await page.keyboard.press("Tab");
  await expect(hides.nth(0)).toBeFocused();
  await expect(firstReveal).toHaveCSS("opacity", "1");
  await page.keyboard.press("Tab");
  await expect(toggles.nth(1)).toBeFocused();
  await expect(firstReveal).toHaveCSS("opacity", "0");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(toggles.nth(0)).toHaveAttribute("aria-expanded", "true");
  await expect(bodies.nth(0)).toHaveCSS("opacity", "1");
  await expect(bodies.nth(0).locator("strong")).toHaveText(
    "准备好下一次冒险。",
  );
  await expect(
    bodies.nth(0).getByRole("img", { name: "公告配图" }),
  ).toBeVisible();
  await bodies.nth(0).getByRole("link", { name: "查看完整公告" }).click();
  expect(await page.evaluate(() => window.__homeNotices.links)).toEqual([
    "https://example.com/sfmcl-t-notice",
  ]);
  await toggles.nth(1).click();
  await expect(toggles.nth(0)).toHaveAttribute("aria-expanded", "true");
  await expect(toggles.nth(1)).toHaveAttribute("aria-expanded", "true");
  await toggles.nth(0).focus();
  await page.keyboard.press("Space");
  await expect(bodies.nth(0)).toBeHidden();
  expect(await bodies.nth(0).evaluate((node) => node.inert)).toBe(true);
  await page.keyboard.press("Tab");
  await expect(hides.nth(0)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(toggles.nth(1)).toBeFocused();
  await toggles.nth(1).click();
  for (let i = 0; i < 3; i++) await toggles.nth(0).click();
  await expect(toggles.nth(0)).toHaveAttribute("aria-expanded", "true");
  await expect(bodies.nth(0)).toHaveCSS("opacity", "1");
  expect(await dock.boundingBox()).toEqual(dockBefore);
  checks.push(
    "Mouse, Enter and Space toggle panels independently; hidden links leave the tab order; rapid toggles settle correctly; Markdown, images and external links work without moving the dock.",
  );

  for (const width of [1120, 850, 540]) {
    await page.setViewportSize({ width, height: 640 });
    for (const theme of ["light", "dark"]) {
      for (const accent of ["forest", "nether", "end", "sift"]) {
        await page.evaluate(
          ({ theme, accent }) =>
            Object.assign(document.documentElement.dataset, { theme, accent }),
          { theme, accent },
        );
        expect(
          await notices.evaluate(
            (node) => node.scrollWidth <= node.clientWidth + 1,
          ),
        ).toBe(true);
      }
    }
  }
  await page.setViewportSize({ width: 1120, height: 640 });
  await page.evaluate(() =>
    Object.assign(document.documentElement.dataset, {
      theme: "dark",
      accent: "forest",
    }),
  );
  await page.evaluate(() =>
    Promise.allSettled(
      document
        .getAnimations()
        .filter(
          (animation) => animation.effect.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished),
    ),
  );
  await page.screenshot({ path: `${evidence}/expanded-dark.png` });
  await toggles.nth(2).click();
  await expect(bodies.nth(2)).toContainText("读取公告失败：测试文件不存在。");
  await expect(bodies.nth(2)).toBeVisible();
  checks.push(
    "All eight themes and three viewport widths keep the panels within the page; per-notice read errors remain available inside their panel.",
  );

  await page.evaluate(() => {
    window.__homeNotices.fail = true;
  });
  await refresh.click();
  await expect(notices.getByRole("alert")).toContainText("测试公告读取失败");
  await expect(toggles).toHaveCount(3);
  await page.evaluate(() => {
    window.__homeNotices.fail = false;
    window.__homeNotices.items = [];
  });
  await refresh.click();
  await expect(notices.getByRole("status")).toHaveText("暂无公告");
  await expect(toggles).toHaveCount(0);
  await expect(notices.getByRole("alert")).toHaveCount(0);
  await ready("?clean=on");
  await expect(notices).toHaveCount(0);
  await expect(page.locator("main.page > *")).toHaveCount(1);
  await expect(dock).toBeVisible();
  expect(await page.evaluate(() => window.__homeNotices.refreshes)).toEqual([]);
  checks.push(
    "Refresh errors retain existing notices, retry recovers to the empty state, and clean mode leaves only the title above the launch dock.",
  );

  // Optional network work must not hold the startup screen or hide cached content.
  await ready("?remote=pending");
  await expect
    .poll(() => page.evaluate(() => window.__homeNotices.refreshes.length))
    .toBe(1);
  await expect(toggles).toHaveCount(3);
  await expect(dock).toBeVisible();
  await expect(refresh).toBeDisabled();
  await page.evaluate(() => {
    const state = window.__homeNotices;
    state.items = Array.from({ length: 5 }, (_, index) => ({
      id: `official-${index}`,
      preset: true,
      title:
        index < 3
          ? `Official Minecraft news ${index + 1}`
          : index === 3
            ? "Minecraft 26.4 Snapshot 6"
            : "Java版26.4-snapshot-6",
      category:
        index < 3
          ? "官方新闻"
          : index === 3
            ? "Java 快照"
            : "中文 Minecraft Wiki",
      date: `2026-10-${30 - index}T13:40:29Z`,
      icon: "/assets/DefaultGameIcon/Minecraft.png",
      content:
        index === 4
          ? "这是最新快照的中文介绍，加入了雪砖系列方块。\n\n[阅读完整内容](https://zh.minecraft.wiki/w/Java%E7%89%8826.4-snapshot-6)"
          : "Minecraft 更新内容。\n\n![公告配图](/assets/DefaultGameIcon/Minecraft.png)\n\n[阅读完整内容](https://www.minecraft.net/article/test-news)",
    }));
    state.pending = false;
    state.finish({ items: structuredClone(state.items), error: "" });
  });
  await expect(toggles).toHaveCount(5);
  await expect(refresh).toBeEnabled();
  await expect(notices.locator("time").first()).toHaveText("2026-10-30");
  await expect(notices.locator(".notice-meta").first()).toContainText(
    "官方新闻",
  );
  await expect(notices.locator(".notice-meta").last()).toContainText(
    "中文 Minecraft Wiki",
  );
  await expect(
    notices.locator(".notice-meta").filter({ hasText: "Java 快照" }),
  ).toHaveCount(1);
  await expect(bodies.locator("img")).toHaveCount(0);
  await page.screenshot({ path: `${evidence}/official-news-collapsed.png` });
  await page.setViewportSize({ width: 540, height: 640 });
  expect(
    await notices.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  await page.setViewportSize({ width: 1120, height: 640 });
  await toggles.first().click();
  await expect(
    bodies.first().getByRole("img", { name: "公告配图" }),
  ).toBeVisible();
  await bodies.first().getByRole("link", { name: "阅读完整内容" }).click();
  expect(await page.evaluate(() => window.__homeNotices.links)).toEqual([
    "https://www.minecraft.net/article/test-news",
  ]);
  await toggles.last().click();
  await expect(bodies.last()).toContainText("加入了雪砖系列方块");
  await bodies.last().getByRole("link", { name: "阅读完整内容" }).click();
  expect(await page.evaluate(() => window.__homeNotices.links)).toEqual([
    "https://www.minecraft.net/article/test-news",
    "https://zh.minecraft.wiki/w/Java%E7%89%8826.4-snapshot-6",
  ]);
  await page.evaluate(() => {
    window.__homeNotices.refreshError =
      "中文 Minecraft Wiki暂时无法更新，正在显示缓存内容。";
  });
  await refresh.click();
  await expect(notices.getByRole("alert")).toContainText("正在显示缓存内容");
  await expect(toggles).toHaveCount(5);
  await expect(toggles.first()).toHaveAttribute("aria-expanded", "true");
  await expect(toggles.last()).toHaveAttribute("aria-expanded", "true");
  await expect(bodies.last()).toContainText("这是最新快照的中文介绍");
  expect(await page.evaluate(() => window.__homeNotices.refreshes)).toEqual([
    false,
    true,
  ]);
  await page.screenshot({ path: `${evidence}/official-news-cached.png` });
  checks.push(
    "Pending requests do not block startup; three news notices, one latest Java update and one Chinese Wiki introduction show categories/dates, open the source articles, and preserve expanded content when Wiki refresh falls back to cache.",
  );

  // Every source supports hiding without changing which future entries are fetched.
  await page.evaluate(() => {
    window.__homeNotices.refreshError = "";
  });
  await expect(hides).toHaveCount(5);
  for (const title of [
    "Official Minecraft news 1",
    "Minecraft 26.4 Snapshot 6",
    "Java版26.4-snapshot-6",
  ]) {
    await clickNoticeAction(
      notices.getByRole("button", { name: `隐藏公告：${title}`, exact: true }),
    );
  }
  await expect(toggles).toHaveCount(2);
  await refresh.click();
  await expect(toggles).toHaveCount(2);
  await add.click();
  const editor = page.getByRole("dialog", { name: "新增公告", exact: true });
  await expect(editor.getByRole("tab").first()).toContainText("预设");
  await expect(editor.getByRole("tab").first()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(editor.getByRole("tabpanel")).toHaveAccessibleName(/^预设/);
  await expect(editor.locator(".notice-form, .helper")).toHaveCount(0);
  await expect(editor.getByRole("tab", { name: "已隐藏" })).toHaveCount(0);
  await editor.getByRole("tab", { name: "预设" }).click();
  await expect(editor.locator(".notice-preset-row")).toHaveCount(3);
  await editor
    .getByRole("button", {
      name: "添加预设公告：Minecraft 26.4 Snapshot 6",
      exact: true,
    })
    .click();
  await expect(toggles).toHaveCount(3);
  await expect(editor.locator(".notice-preset-row")).toHaveCount(2);
  await editor.getByRole("button", { name: "关闭对话框" }).click();
  await expect(editor).toHaveCount(0);
  checks.push(
    "Official news, Java updates and Chinese Wiki notices each support hiding; only hidden presets appear in the Presets tab, and adding them back removes them from that tab.",
  );

  await ready();
  await expect(toggles).toHaveCount(3);
  await expect(hides).toHaveCount(3);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => {
    window.__homeNotices.freezeListMotion = true;
  });
  await clickNoticeAction(hides.first());
  const departing = notices.locator(
    '.notice-list-item[data-notice-phase="exiting"]',
  );
  await expect(departing).toHaveCount(1);
  await expect(notices.locator(".notice-home-list")).toHaveAttribute(
    "data-notice-list-moving",
    "true",
  );
  await hoverNoticeAction(
    notices
      .locator('.notice-list-item[data-notice-phase="stable"] .notice-hide')
      .first(),
  );
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  expect(
    await departing.evaluate(
      (node) => node.inert && node.getAttribute("aria-hidden") === "true",
    ),
  ).toBe(true);
  await expect(
    notices.getByRole("button", {
      name: "隐藏公告：欢迎来到 SFMCL-T",
      exact: true,
    }),
  ).toHaveCount(0);
  const flow = await page.evaluate(() => {
    const animations = document
      .getAnimations()
      .filter((animation) => animation.id.startsWith("sfmcl-t-notice-list-"));
    const row = document.querySelector(
      '.notice-home-list .notice-list-item[data-notice-phase="exiting"]',
    );
    const sibling = row.nextElementSibling;
    const sample = (time) => {
      animations.forEach((animation) => {
        animation.currentTime = time;
      });
      return {
        top: sibling.getBoundingClientRect().top,
        height: row.getBoundingClientRect().height,
      };
    };
    const start = sample(0);
    const middle = sample(160);
    const end = sample(320);
    sample(160);
    return {
      start,
      middle,
      end,
      durations: animations.map(
        (animation) => animation.effect.getTiming().duration,
      ),
    };
  });
  expect(flow.durations).toEqual([320, 320]);
  expect(flow.middle.height).toBeGreaterThan(0);
  expect(flow.middle.height).toBeLessThan(flow.start.height);
  expect(flow.middle.top).toBeLessThan(flow.start.top);
  expect(flow.middle.top).toBeGreaterThan(flow.end.top);
  await page.screenshot({ path: `${evidence}/home-notice-exit-midpoint.png` });
  await page.evaluate(() => {
    window.__homeNotices.freezeListMotion = false;
    document
      .getAnimations()
      .filter((animation) => animation.id.startsWith("sfmcl-t-notice-list-"))
      .forEach((animation) => animation.finish());
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(toggles).toHaveCount(2);
  await expect(toggles.first()).toBeFocused();
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(toggles).toHaveCount(2);
  await ready();
  await expect(toggles).toHaveCount(2);
  await add.click();
  await editor.getByRole("tab", { name: "预设" }).click();
  await expect(editor.locator(".notice-preset-row")).toHaveCount(1);
  await page.evaluate(() => {
    window.__homeNotices.freezeListMotion = true;
  });
  await editor
    .getByRole("button", {
      name: "添加预设公告：欢迎来到 SFMCL-T",
      exact: true,
    })
    .click();
  await expect(
    editor.locator('.notice-list-item[data-notice-phase="exiting"]'),
  ).toHaveCount(1);
  await expect(
    notices.locator('.notice-list-item[data-notice-phase="entering"]'),
  ).toHaveCount(1);
  const transfer = await page.evaluate(() => window.__homeNotices.listMotions);
  expect(
    transfer.some(
      (motion) =>
        motion.list === "presets" &&
        motion.id === "sfmcl-t-notice-list-exit" &&
        motion.duration === 320,
    ),
  ).toBe(true);
  expect(
    transfer.some(
      (motion) =>
        motion.list === "home" &&
        motion.id === "sfmcl-t-notice-list-enter" &&
        motion.duration === 320,
    ),
  ).toBe(true);
  await expect(editor.getByRole("tab", { name: "预设" })).toBeFocused();
  await page.evaluate(() => {
    window.__homeNotices.freezeListMotion = false;
    document
      .getAnimations()
      .filter((animation) => animation.id.startsWith("sfmcl-t-notice-list-"))
      .forEach((animation) => animation.finish());
  });
  await expect(toggles).toHaveCount(3);
  await expect(editor.getByRole("status")).toHaveText("当前预设均已显示");
  await expect(
    editor.locator(".notice-preset-empty .empty-icon svg"),
  ).toBeVisible();
  await expect(editor.locator(".notice-preset-empty h3")).toHaveText(
    "当前预设均已显示",
  );
  await expect(editor.locator(".notice-preset-empty p, .helper")).toHaveCount(
    0,
  );
  await editor.evaluate((node) =>
    Promise.allSettled(
      node
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    ),
  );
  await page.screenshot({ path: `${evidence}/preset-empty.png` });
  await editor.getByRole("tab", { name: "新增公告", exact: true }).click();
  const forward = await page.evaluate(() =>
    window.__homeNotices.tabTransitions.at(-1),
  );
  expect(forward.duration).toBe(240);
  expect(forward.frames[0]).toEqual({
    opacity: "0.15",
    transform: "translateX(16px)",
  });
  await expect(editor.locator(".helper")).toHaveCount(0);
  await expect(
    editor.getByRole("textbox", { name: "公告内容", exact: true }),
  ).not.toHaveAttribute("aria-describedby");
  await editor.getByRole("button", { name: "添加公告", exact: true }).click();
  await expect(editor.getByRole("alert")).toHaveText("请填写公告标题和内容。");
  expect(await page.evaluate(() => window.__homeNotices.saves)).toBe(0);
  await editor.getByLabel("公告标题", { exact: true }).fill(" 自定义测试公告 ");
  await editor
    .getByRole("textbox", { name: "公告内容", exact: true })
    .fill("**本地公告内容**\n\n[自定义链接](https://example.com/custom)");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await editor.getByRole("tab", { name: "预设" }).click();
  const reverse = await page.evaluate(() =>
    window.__homeNotices.tabTransitions.at(-1),
  );
  expect(reverse.duration).toBe(240);
  expect(reverse.frames[0]).toEqual({
    opacity: "0.15",
    transform: "translateX(-16px)",
  });
  await editor.getByRole("tab", { name: "新增公告", exact: true }).click();
  await editor.getByRole("tab", { name: "预设" }).click();
  await editor.getByRole("tab", { name: "新增公告", exact: true }).click();
  await editor
    .getByRole("tabpanel")
    .evaluate((node) =>
      Promise.allSettled(
        node.getAnimations().map((animation) => animation.finished),
      ),
    );
  await expect(editor.getByRole("tabpanel")).toHaveCSS("opacity", "1");
  await expect(editor.getByRole("tabpanel")).toHaveCSS("transform", "none");
  await expect(editor.getByLabel("公告标题", { exact: true })).toHaveValue(
    " 自定义测试公告 ",
  );
  await expect(
    editor.getByRole("textbox", { name: "公告内容", exact: true }),
  ).toHaveValue("**本地公告内容**\n\n[自定义链接](https://example.com/custom)");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  checks.push(
    "Presets is the first and default tab; tab content animates in both directions at full duration, rapid switching settles and preserves drafts; descriptions are removed and the empty preset uses an icon placeholder.",
  );
  await page.evaluate(() => {
    window.__homeNotices.saveFail = true;
  });
  await editor.getByRole("button", { name: "添加公告", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("测试新增公告保存失败");
  await expect(editor.getByLabel("公告标题", { exact: true })).toHaveValue(
    " 自定义测试公告 ",
  );
  await expect(toggles).toHaveCount(3);
  await page.setViewportSize({ width: 540, height: 640 });
  expect(
    await editor.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  await page.screenshot({ path: `${evidence}/add-notice-narrow.png` });
  await page.setViewportSize({ width: 1120, height: 640 });

  // Deliver an older refresh after creating a notice to check stale-response protection.
  await page.evaluate(() => {
    const state = window.__homeNotices;
    state.saveFail = false;
    state.savePending = true;
    state.pending = true;
    document.querySelector(".notice-refresh").click();
  });
  await expect
    .poll(() => page.evaluate(() => typeof window.__homeNotices.finish))
    .toBe("function");
  await editor.getByRole("button", { name: "添加公告", exact: true }).click();
  await expect(
    editor.getByRole("button", { name: "正在保存…", exact: true }),
  ).toBeDisabled();
  await expect(
    editor.getByRole("button", { name: "关闭对话框" }),
  ).toBeDisabled();
  await page.evaluate(() =>
    document.querySelector(".notice-form").requestSubmit(),
  );
  expect(await page.evaluate(() => window.__homeNotices.saves)).toBe(2);
  await page.evaluate(() => {
    window.__homeNotices.freezeListMotion = true;
    window.__homeNotices.finishSave();
  });
  await expect(editor).toHaveCount(0);
  await expect(toggles).toHaveCount(4);
  await expect(
    notices.locator('.notice-list-item[data-notice-phase="entering"]'),
  ).toHaveCount(1);
  expect(
    await page.evaluate(() =>
      window.__homeNotices.listMotions.some(
        (motion) =>
          motion.key === "notice:local:custom:2" &&
          motion.id === "sfmcl-t-notice-list-enter" &&
          motion.duration === 320,
      ),
    ),
  ).toBe(true);
  await page.evaluate(() => {
    window.__homeNotices.freezeListMotion = false;
    document
      .getAnimations()
      .filter((animation) => animation.id.startsWith("sfmcl-t-notice-list-"))
      .forEach((animation) => animation.finish());
  });
  await page.evaluate(() => {
    const state = window.__homeNotices;
    state.pending = false;
    state.finish({
      items: structuredClone(state.items.slice(0, 3)),
      error: "",
    });
  });
  await expect(refresh).toBeEnabled();
  await expect(toggles).toHaveCount(4);
  await toggles.last().click();
  await expect(bodies.last().locator("strong")).toHaveText("本地公告内容");
  await ready();
  await expect(toggles).toHaveCount(4);
  await expect(deletes).toHaveCount(1);
  await expect(hides).toHaveCount(3);
  await expect(
    notices.getByRole("button", {
      name: "隐藏公告：自定义测试公告",
      exact: true,
    }),
  ).toHaveCount(0);
  // Old hidden custom IDs must not turn user-created notices into presets.
  await page.evaluate(() => {
    const state = window.__homeNotices;
    state.hidden.push(state.custom[0].id);
    localStorage.setItem("notice-test-hidden", JSON.stringify(state.hidden));
  });
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(toggles).toHaveCount(4);
  await add.click();
  await editor.getByRole("tab", { name: "预设" }).click();
  await expect(editor.locator(".notice-preset-row")).toHaveCount(0);
  await expect(editor.getByRole("status")).toHaveText("当前预设均已显示");
  await editor.getByRole("button", { name: "关闭对话框" }).click();
  await expect(editor).toHaveCount(0);
  await page.evaluate(() => {
    window.__homeNotices.deleteFail = true;
  });
  const beforeFailure = await page.evaluate(
    () => window.__homeNotices.listMotions.length,
  );
  await clickNoticeAction(deletes.first());
  await expect(notices.getByRole("alert")).toContainText(
    "测试删除公告保存失败",
  );
  await expect(toggles).toHaveCount(4);
  expect(
    await page.evaluate(() => window.__homeNotices.listMotions.length),
  ).toBe(beforeFailure);
  await page.evaluate(() => {
    const state = window.__homeNotices;
    state.deleteFail = false;
    state.deletePending = true;
    state.pending = true;
    state.staleItems = structuredClone(state.items);
  });
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await clickNoticeAction(deletes.first());
  await expect(deletes.first()).toBeDisabled();
  expect(await page.evaluate(() => window.__homeNotices.deletes)).toBe(2);
  await page.evaluate(() => window.__homeNotices.finishDelete());
  await expect(toggles).toHaveCount(3);
  expect(
    await page.evaluate(() =>
      window.__homeNotices.listMotions.some(
        (motion) =>
          motion.id === "sfmcl-t-notice-list-exit" &&
          motion.key === "notice:local:custom:2",
      ),
    ),
  ).toBe(true);
  await expect(deletes).toHaveCount(0);
  await page.evaluate(() => {
    const state = window.__homeNotices;
    state.pending = false;
    state.finish({ items: state.staleItems, error: "" });
  });
  await expect(refresh).toBeEnabled();
  await expect(toggles).toHaveCount(3);
  await ready();
  await expect(toggles).toHaveCount(3);
  await expect(deletes).toHaveCount(0);
  await page.evaluate(() => {
    window.__homeNotices.visibilityFail = true;
  });
  await clickNoticeAction(hides.first());
  await expect(notices.getByRole("alert")).toContainText(
    "测试隐藏状态保存失败",
  );
  await expect(toggles).toHaveCount(3);
  await page.evaluate(() => {
    window.__homeNotices.visibilityFail = false;
  });
  for (let index = 0; index < 3; index++)
    await clickNoticeAction(hides.first());
  await expect(notices.getByRole("status")).toHaveText("暂无公告");
  await expect(add).toBeFocused();
  await add.click();
  await editor.getByRole("tab", { name: "预设" }).click();
  await expect(editor.locator(".notice-preset-row")).toHaveCount(3);
  await expect(editor.getByText("自定义测试公告", { exact: true })).toHaveCount(
    0,
  );
  await editor.evaluate((node) =>
    Promise.allSettled(
      node
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    ),
  );
  await page.screenshot({ path: `${evidence}/preset-notices.png` });
  await editor
    .getByRole("button", {
      name: "添加预设公告：欢迎来到 SFMCL-T",
      exact: true,
    })
    .click();
  await editor.getByRole("button", { name: "关闭对话框" }).click();
  await expect(toggles).toHaveCount(1);
  await ready();
  await expect(toggles).toHaveCount(1);
  await expect(toggles.first()).toContainText("欢迎来到 SFMCL-T");
  // Re-add a preset before its home exit completes; both lists must retain one copy.
  await page.evaluate(() => {
    window.__homeNotices.freezeListMotion = true;
  });
  await clickNoticeAction(hides.first());
  await expect(
    notices.locator('.notice-list-item[data-notice-phase="exiting"]'),
  ).toHaveCount(1);
  await page.evaluate(() => {
    document
      .getAnimations()
      .filter((animation) => animation.id.startsWith("sfmcl-t-notice-list-"))
      .forEach((animation) => {
        animation.currentTime = 130;
      });
    document.querySelector(".notice-add").click();
  });
  await expect(editor).toBeVisible();
  await editor
    .getByRole("button", {
      name: "添加预设公告：欢迎来到 SFMCL-T",
      exact: true,
    })
    .evaluate((button) => button.click());
  await expect(
    notices.locator('[data-notice-key="notice:local:fixture:0"]'),
  ).toHaveCount(1);
  await expect(
    notices.locator('[data-notice-key="notice:local:fixture:0"]'),
  ).toHaveAttribute("data-notice-phase", "entering");
  const reversal = await page.evaluate(() =>
    window.__homeNotices.listMotions
      .filter(
        (motion) =>
          motion.list === "home" &&
          motion.key === "notice:local:fixture:0" &&
          motion.phase === "entering" &&
          motion.id === "sfmcl-t-notice-list-height",
      )
      .at(-1),
  );
  expect(parseFloat(reversal.frames[0].height)).toBeGreaterThan(0);
  expect(parseFloat(reversal.frames[0].height)).toBeLessThan(
    parseFloat(reversal.frames[1].height),
  );
  await page.evaluate(() => {
    window.__homeNotices.freezeListMotion = false;
    document
      .getAnimations()
      .filter((animation) => animation.id.startsWith("sfmcl-t-notice-list-"))
      .forEach((animation) => animation.finish());
  });
  await expect(toggles).toHaveCount(1);
  await expect(editor.locator(".notice-preset-row")).toHaveCount(2);
  await expect(
    page.locator('.notice-list-item:not([data-notice-phase="stable"])'),
  ).toHaveCount(0);
  await editor.getByRole("button", { name: "关闭对话框" }).click();
  checks.push(
    "Home and preset lists animate entry, exit, placeholder changes and continuous reflow at full duration; exiting rows become inert immediately, failed saves do not animate removal, custom notices animate creation/deletion, and interrupted moves reverse without duplicates or leftover space.",
  );
  checks.push(
    "Adding validates required fields, retains drafts on save failure, prevents duplicate submissions and renders Markdown; custom notices only support deletion, stay deleted after reload and older network replies, and never appear as presets even with legacy hidden IDs; preset visibility remains persistent and reversible.",
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
