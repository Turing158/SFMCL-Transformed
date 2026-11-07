import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("evidence/home-content");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
});
const page = await browser.newPage({ viewport: { width: 1120, height: 800 } });
page.setDefaultTimeout(8000);
const errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(() => {
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__pixelTest.data.settings.homeCleanMode =
    location.search.includes("clean=on");
  const state = (window.__homeContentTest = {
    fail: false,
    hold: false,
    writes: 0,
    links: [],
  });
  const news = [0, 1, 2].map((i) => ({
    id: `article:${i}`,
    preset: true,
    title: `原新闻 ${i + 1}`,
    category: "新闻资讯",
    content: `**原折叠面板 ${i + 1}**\n\n[新闻原链接](https://example.com/news)`,
  }));
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "request") {
      if (args.operation === "notices.list") return structuredClone(news);
      if (args.operation === "notices.refresh")
        return { items: structuredClone(news), error: "" };
      if (args.operation === "home.content.save") {
        state.writes++;
        if (state.fail) throw new Error("组件配置写入失败");
        if (state.hold)
          await new Promise((resolve) => {
            state.finish = resolve;
          });
      }
    }
    if (command === "plugin:opener|open_url") {
      state.links.push(args.url);
      return;
    }
    return invoke(command, args);
  };
});
const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/";
const home = page.locator('main[data-page="home"]');
const rows = home.locator(".home-widget-row");
const library = page.getByRole("dialog", { name: "添加组件", exact: true });
const typeRow = (type) =>
  home.locator(`.home-widget-row[data-home-widget-type="${type}"]`);
const stored = () =>
  page.evaluate(() => JSON.parse(localStorage.getItem("pixel-home-content")));
const ids = () =>
  rows.evaluateAll((nodes) => nodes.map((node) => node.dataset.homeWidgetId));
const openLibrary = async (type) => {
  await home.getByRole("button", { name: "添加组件", exact: true }).click();
  if (type === "info" || type === "announcement")
    await library
      .getByRole("tab", {
        name: type === "info" ? "卡片信息" : "折叠公告",
        exact: true,
      })
      .click();
};
const addFixed = async (type) => {
  await openLibrary(type);
  await expect(library.getByRole("textbox")).toHaveCount(0);
  await library.locator(`[data-home-template="${type}"]`).click();
  await expect(library).toHaveCount(0);
};
const addCustom = async (type, title) => {
  await openLibrary(type);
  await library.getByLabel("组件标题", { exact: true }).fill(title);
  await library
    .getByRole("textbox", { name: "内容", exact: true })
    .fill("**自定义正文**\n\n[内容链接](https://example.com/custom)");
  if (type === "info")
    await library.getByLabel("底部备注").fill("记得备份存档");
  await library
    .getByRole("button", { name: "添加到首页", exact: true })
    .click();
  await expect(library).toHaveCount(0);
};
try {
  await page.goto(url);
  await expect(page.locator("html")).not.toHaveAttribute("data-startup");
  await expect(rows).toHaveCount(3);
  await expect(home.locator(".notice-toggle")).toHaveCount(3);
  const firstNews = home.locator(".notice-toggle").first();
  await firstNews.click();
  await expect(firstNews).toHaveAttribute("aria-expanded", "true");
  await page.evaluate(() => {
    window.__originalNews = document.querySelector(".notice-card");
  });
  for (const type of ["player", "links", "version"]) await addFixed(type);
  await openLibrary("notices");
  await expect(library.getByRole("textbox")).toHaveCount(0);
  await expect(library.locator('[data-home-template="notice"]')).toHaveCount(3);
  expect(await library.getByRole("tab").allTextContents()).toEqual([
    "预设组件",
    "折叠公告",
    "卡片信息",
  ]);
  await expect(
    library.getByRole("tab", { name: /预设公告|已隐藏组件/ }),
  ).toHaveCount(0);
  await expect(
    library.locator(
      '[data-home-template="info"], [data-home-template="announcement"]',
    ),
  ).toHaveCount(0);
  await expect(
    library.locator(".home-template-grid [data-home-template]"),
  ).toHaveCount(6);
  await expect(
    library.locator(
      '[data-home-template="notices"], .home-preset-config, .home-news-presets',
    ),
  ).toHaveCount(0);
  await expect(
    library.locator(
      ".home-template-preview, .home-content-preview, .home-template-news-preview, .home-widget-panel, canvas, img",
    ),
  ).toHaveCount(0);
  await page.screenshot({
    path: `${evidence}/component-library-presets.png`,
    animations: "disabled",
  });

  await expect(
    library.getByRole("button", { name: "已添加资讯：原新闻 1", exact: true }),
  ).toBeDisabled();
  await library.getByRole("button", { name: "关闭对话框" }).click();

  for (const type of ["player", "links", "version"]) {
    await openLibrary(type);
    await expect(library.getByRole("textbox")).toHaveCount(0);
    await expect(
      library.locator(`[data-home-template="${type}"]`),
    ).toBeDisabled();
    await library.getByRole("button", { name: "关闭对话框" }).click();
  }

  await openLibrary("info");
  await library.getByLabel("组件标题", { exact: true }).fill("信息草稿");
  await library
    .getByRole("textbox", { name: "内容", exact: true })
    .fill("**信息正文草稿**");
  await library.getByLabel("底部备注").fill("信息备注草稿");
  await expect(
    library.locator(".home-content-preview, .markdown, .home-widget-panel"),
  ).toHaveCount(0);
  await page.screenshot({
    path: `${evidence}/component-library-info.png`,
    animations: "disabled",
  });
  await library.getByRole("tab", { name: "折叠公告", exact: true }).click();
  await expect(library.getByRole("textbox")).toHaveCount(2);
  await expect(library.getByLabel("组件标题", { exact: true })).toHaveValue("");
  await library.getByLabel("组件标题", { exact: true }).fill("公告草稿");
  await library
    .getByRole("textbox", { name: "内容", exact: true })
    .fill("**公告正文草稿**");
  await expect(
    library.locator(".home-content-preview, .markdown, .home-widget-panel"),
  ).toHaveCount(0);
  await page.screenshot({
    path: `${evidence}/component-library-announcement.png`,
    animations: "disabled",
  });
  await library.getByRole("tab", { name: "卡片信息", exact: true }).click();
  await expect(library.getByLabel("组件标题", { exact: true })).toHaveValue(
    "信息草稿",
  );
  await expect(
    library.getByRole("textbox", { name: "内容", exact: true }),
  ).toHaveValue("**信息正文草稿**");
  await expect(library.getByLabel("底部备注")).toHaveValue("信息备注草稿");
  await library.getByRole("tab", { name: "预设组件", exact: true }).click();
  await expect(library.getByRole("textbox")).toHaveCount(0);
  await library.getByRole("tab", { name: "折叠公告", exact: true }).click();
  await expect(library.getByLabel("组件标题", { exact: true })).toHaveValue(
    "公告草稿",
  );
  await library.getByRole("button", { name: "关闭对话框" }).click();
  checks.push(
    "组件库保留三个 tab；每条资讯与三类固定卡片直接列在同一网格，没有右侧内容区、新闻资讯总入口或预览；固定卡片直接添加，已添加项禁用，独立表单草稿保留。",
  );
  for (const type of ["info", "announcement"])
    for (let i = 0; i < 2; i++)
      await addCustom(type, `${type === "info" ? "冒险清单" : "自定义公告"}`);
  await expect(rows).toHaveCount(10);
  await expect(typeRow("info")).toHaveCount(2);
  await expect(typeRow("announcement")).toHaveCount(2);
  await expect(typeRow("info").first().locator("strong").last()).toHaveText(
    "自定义正文",
  );
  await typeRow("announcement")
    .first()
    .locator(".home-announcement-toggle")
    .click();
  await expect(
    typeRow("announcement").first().locator(".markdown"),
  ).toBeVisible();
  await typeRow("announcement").first().hover();
  await expect(
    typeRow("announcement").locator(".notice-hide, .home-widget-hide"),
  ).toHaveCount(0);
  await home.locator(".notice-card").first().hover();
  await expect(home.locator(".notice-hide, .home-widget-hide")).toHaveCount(0);
  await expect(home.locator(".notice-chevron").first()).toHaveCSS(
    "opacity",
    "1",
  );
  await home.getByRole("button", { name: "刷新公告", exact: true }).click();
  await expect(firstNews).toHaveAttribute("aria-expanded", "true");
  expect(
    await page.evaluate(
      () => window.__originalNews === document.querySelector(".notice-card"),
    ),
  ).toBe(true);
  checks.push(
    "新闻和自定义折叠公告在普通模式 hover 不出现隐藏按钮，资讯展开箭头保持可见；添加和刷新保留原新闻折叠面板和展开状态。每条资讯及三类固定组件保持唯一，两类自定义组件允许重复并渲染 Markdown。",
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  await home.getByRole("button", { name: "编辑布局", exact: true }).click();
  await expect(home.locator(".home-widget-hide")).toHaveCount(10);
  const motion = await rows.evaluateAll(async (nodes) => {
    const samples = nodes.map(() => []);
    for (let frame = 0; frame < 20; frame++) {
      nodes.forEach((node, i) => {
        const target = node.querySelector(".home-widget-motion");
        const style = getComputedStyle(target),
          matrix = new DOMMatrix(style.transform);
        samples[i].push({
          angle: (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI,
          y: matrix.f,
          name: style.animationName,
          duration: style.animationDuration,
        });
      });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return nodes.map((node, i) => ({
      samples: samples[i],
      position: getComputedStyle(node.querySelector(".home-widget-hide"))
        .position,
    }));
  });
  for (const card of motion) {
    expect(card.position).toBe("absolute");
    expect(
      Math.max(...card.samples.map((s) => Math.abs(s.angle))),
    ).toBeLessThanOrEqual(0.29);
    expect(
      Math.max(...card.samples.map((s) => s.angle)) -
        Math.min(...card.samples.map((s) => s.angle)),
    ).toBeGreaterThan(0.15);
    expect(
      card.samples.every(
        (s) =>
          s.name === "home-widget-wiggle" && parseFloat(s.duration) >= 0.38,
      ),
    ).toBe(true);
  }
  await writeFile(`${evidence}/motion.json`, JSON.stringify(motion, null, 2));
  const beforeHide = await stored();
  const player = beforeHide.widgets.find((item) => item.type === "player");
  await typeRow("player")
    .getByRole("button", { name: "隐藏：角色卡片", exact: true })
    .click({ force: true });
  await expect(typeRow("player")).toHaveCount(0);
  await openLibrary("player");
  await library.locator('[data-home-template="player"]').click();
  await expect(library).toHaveCount(0);
  expect((await stored()).widgets).toEqual(beforeHide.widgets);
  await home.getByRole("button", { name: "编辑布局", exact: true }).click();
  await rows.last().focus();
  const beforeReorder = await ids();
  await page.keyboard.press("Alt+ArrowUp");
  const afterKeyboard = [...beforeReorder];
  const end = afterKeyboard.length - 1;
  [afterKeyboard[end - 1], afterKeyboard[end]] = [
    afterKeyboard[end],
    afterKeyboard[end - 1],
  ];
  await expect.poll(ids).toEqual(afterKeyboard);
  // Pointer ordering uses the whole card surface; the original news drag remains independent.
  const source = typeRow("player").locator(".home-widget-heading");
  const target = typeRow("version").locator(".home-widget-heading");
  await expect(typeRow("player")).toHaveAttribute(
    "data-notice-phase",
    "stable",
  );
  await source.evaluate((node) => node.scrollIntoView({ block: "center" }));
  const from = await source.boundingBox(),
    to = await target.boundingBox();
  await page.mouse.move(from.x + 60, from.y + 10);
  await page.mouse.down();
  await page.mouse.move(from.x + 80, from.y + 20);
  await expect(page.locator(".home-widget-drag-overlay")).toHaveCount(1);
  await page.mouse.move(to.x + 60, to.y + 10, { steps: 12 });
  await page.waitForTimeout(180);
  await page.mouse.up();
  await expect(page.locator(".home-widget-drag-overlay")).toHaveCount(0);
  expect(await ids()).not.toEqual(afterKeyboard);
  await expect(firstNews).toHaveAttribute("aria-expanded", "true");
  expect(
    await page.evaluate(
      () => window.__originalNews === document.querySelector(".notice-card"),
    ),
  ).toBe(true);

  const separateNews = typeRow("notice").filter({ hasText: "原新闻 1" });
  const beforeNewsMove = await ids();
  await separateNews.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(ids).not.toEqual(beforeNewsMove);
  await expect(separateNews.locator(".notice-toggle")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const beforeNewsHide = await stored();
  await typeRow("notice")
    .filter({ hasText: "原新闻 2" })
    .getByRole("button", { name: "隐藏：原新闻 2", exact: true })
    .click({ force: true });
  await expect(typeRow("notice")).toHaveCount(2);
  await expect(
    typeRow("notice").filter({ hasText: "原新闻 1" }).locator(".notice-toggle"),
  ).toHaveAttribute("aria-expanded", "true");
  await openLibrary("notices");
  await library
    .getByRole("button", { name: "恢复资讯：原新闻 2", exact: true })
    .click();
  await expect(
    library.getByRole("button", { name: "已添加资讯：原新闻 2", exact: true }),
  ).toBeDisabled();
  await library.getByRole("button", { name: "关闭对话框" }).click();
  expect(await stored()).toEqual(beforeNewsHide);
  await expect(typeRow("notice")).toHaveCount(3);
  checks.push(
    "每条新闻是独立布局元素，能与其他卡片交错排序；只隐藏指定新闻，其他新闻保留展开状态，单条恢复保留 ID 和位置。",
  );
  await home.getByRole("button", { name: "编辑布局", exact: true }).click();
  await home.getByRole("button", { name: "完成编辑", exact: true }).click();
  await expect(home.locator(".home-widget-hide")).toHaveCount(0);
  await expect(rows.first().locator(".home-widget-motion")).toHaveCSS(
    "animation-name",
    "none",
  );
  checks.push(
    "编辑时每张卡片仅有右上角悬浮隐藏按钮，实际抖动幅度 ≤0.29°，减少动态设置下仍正常播放；恢复固定组件保留 ID 和顺序；键盘及鼠标拖动排序不重建新闻面板，完成编辑后动画停止。",
  );

  await typeRow("player")
    .getByRole("button", { name: "切换角色", exact: true })
    .click();
  await expect(page.locator('main[data-page="players"]')).toBeVisible();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "开始游戏", exact: true })
    .click();
  await home.getByRole("button", { name: "编辑布局", exact: true }).click();
  await typeRow("version")
    .getByRole("button", { name: "管理版本", exact: true })
    .click({ force: true });
  await expect(page.locator('main[data-page="versions"]')).toBeVisible();
  await expect(home.locator(".home-widget-list")).toHaveAttribute(
    "data-home-editing",
    "false",
  );
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "开始游戏", exact: true })
    .click();
  const persistent = await stored();
  await page.reload();
  await expect(rows).toHaveCount(10);
  expect(await ids()).toEqual(
    persistent.widgets.filter((item) => item.visible).map((item) => item.id),
  );
  checks.push(
    "切换角色跳转真实角色管理，版本卡片跳转版本管理；离开首页停止编辑动画，重新打开和刷新页面保留配置。",
  );

  const beforeFailureWrites = await page.evaluate(
    () => window.__homeContentTest.writes,
  );
  await page.evaluate(() => {
    window.__homeContentTest.fail = true;
  });
  await openLibrary("info");
  await library
    .getByRole("button", { name: "添加到首页", exact: true })
    .click();
  await expect(library.getByRole("alert")).toHaveText("请填写标题和内容。");
  await library.getByLabel("组件标题", { exact: true }).fill("未保存的草稿");
  await library
    .getByRole("textbox", { name: "内容", exact: true })
    .fill("内容草稿");
  await library
    .getByRole("button", { name: "添加到首页", exact: true })
    .click();
  await expect(library.getByRole("alert")).toContainText("组件配置写入失败");
  await expect(library.getByLabel("组件标题", { exact: true })).toHaveValue(
    "未保存的草稿",
  );
  expect(await stored()).toEqual(persistent);
  await page.evaluate(() => {
    window.__homeContentTest.fail = false;
    window.__homeContentTest.hold = true;
  });
  await library
    .getByRole("button", { name: "添加到首页", exact: true })
    .click();
  await expect(
    library.getByRole("button", { name: "关闭对话框" }),
  ).toBeDisabled();
  await library.locator("form").evaluate((form) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  expect(await page.evaluate(() => window.__homeContentTest.writes)).toBe(
    beforeFailureWrites + 2,
  );
  await page.evaluate(() => {
    window.__homeContentTest.hold = false;
    window.__homeContentTest.finish();
  });
  await expect(library).toHaveCount(0);
  await expect(rows).toHaveCount(11);
  await page.evaluate(() => {
    window.__homeContentTest.fail = true;
  });
  await home.getByRole("button", { name: "编辑布局", exact: true }).click();
  await typeRow("player")
    .getByRole("button", { name: "隐藏：角色卡片", exact: true })
    .click({ force: true });
  await expect(home.getByRole("alert")).toContainText("组件配置写入失败");
  await expect(typeRow("player")).toHaveCount(1);
  await page.evaluate(() => {
    window.__homeContentTest.fail = false;
  });
  await home.getByRole("button", { name: "完成编辑", exact: true }).click();
  checks.push(
    "内容必填校验、保存失败保留草稿和原布局、慢保存时禁用关闭并拦截重复提交、隐藏失败恢复原卡片。",
  );

  await page.reload();
  await expect(rows).toHaveCount(11);

  for (const type of ["info", "announcement"]) {
    const beforeCustomHide = await stored();
    await home.getByRole("button", { name: "编辑布局", exact: true }).click();
    await typeRow(type)
      .first()
      .getByRole("button", {
        name: type === "info" ? "隐藏：冒险清单" : "隐藏：自定义公告",
        exact: true,
      })
      .click({ force: true });
    await openLibrary(type);
    await expect(
      library.locator(".home-library-restores .home-hidden-row"),
    ).toHaveCount(1);
    await library.locator(".home-library-restores").getByRole("button").click();
    await expect(
      library.locator(".home-library-restores .home-hidden-row"),
    ).toHaveCount(0);
    await library.getByRole("button", { name: "关闭对话框" }).click();
    expect(await stored()).toEqual(beforeCustomHide);
  }
  checks.push(
    "移除已隐藏组件 tab 后，两类自定义组件仍能在各自添加 tab 原位恢复，保留内容、备注和 ID。",
  );
  for (const width of [1120, 850, 540, 375]) {
    await page.setViewportSize({ width, height: 800 });
    for (const theme of ["light", "dark"])
      for (const accent of ["forest", "nether", "end", "sift"]) {
        await page.evaluate(
          ({ theme, accent }) =>
            Object.assign(document.documentElement.dataset, { theme, accent }),
          { theme, accent },
        );
        expect(
          await home.evaluate(
            (node) => node.scrollWidth <= node.clientWidth + 1,
          ),
        ).toBe(true);
      }
    await openLibrary("info");
    expect(
      await library.evaluate(
        (node) => node.scrollWidth <= node.clientWidth + 1,
      ),
    ).toBe(true);
    if (width === 375) {
      await page.screenshot({
        path: `${evidence}/component-library-info-narrow.png`,
        animations: "disabled",
      });
      await library.getByRole("tab", { name: "折叠公告", exact: true }).click();
      await expect(
        library.getByRole("textbox", { name: "内容", exact: true }),
      ).toBeVisible();
      await library.getByRole("tab", { name: "预设组件", exact: true }).click();
      await expect(
        library.locator(".home-template-grid [data-home-template]"),
      ).toHaveCount(6);
      await page.screenshot({
        path: `${evidence}/component-library-presets-narrow.png`,
        animations: "disabled",
      });
    }
    await library.getByRole("button", { name: "关闭对话框" }).click();
  }
  await page.setViewportSize({ width: 1120, height: 800 });
  await page.evaluate(() =>
    Object.assign(document.documentElement.dataset, {
      theme: "light",
      accent: "forest",
    }),
  );
  await page.screenshot({ path: `${evidence}/implemented-home.png` });
  await home.getByRole("button", { name: "编辑布局", exact: true }).click();
  await page.screenshot({ path: `${evidence}/independent-news-editing.png` });
  await home.getByRole("button", { name: "完成编辑", exact: true }).click();
  await rows.last().scrollIntoViewIfNeeded();
  const last = await rows
      .last()
      .locator(".home-widget-panel, .notice-card")
      .boundingBox(),
    dock = await page.locator(".launch-dock").boundingBox();
  expect(last.y + last.height).toBeLessThanOrEqual(dock.y + 1);
  checks.push(
    "八种主题和四种窗口宽度下首页与组件库无横向溢出，最后一张卡片可以滚动到启动栏上方。",
  );

  await page.evaluate(() => {
    localStorage.setItem(
      "pixel-home-content",
      JSON.stringify({
        schemaVersion: 1,
        widgets: [
          { id: "existing:player", type: "player", visible: true },
          { id: "existing:news", type: "notices", visible: false },
          {
            id: "existing:info",
            type: "info",
            title: "保留我的笔记",
            content: "原笔记正文",
            note: "原备注",
            visible: true,
          },
        ],
      }),
    );
    localStorage.setItem(
      "sfmcl-t.home.notice-order",
      JSON.stringify([
        "notice:article:2",
        "notice:article:0",
        "notice:article:1",
      ]),
    );
  });
  await page.reload();
  await expect(rows).toHaveCount(2);
  await expect
    .poll(async () => (await stored()).widgets.map((item) => item.id))
    .toEqual([
      "existing:player",
      "notice:article:2",
      "notice:article:0",
      "notice:article:1",
      "existing:info",
    ]);
  await expect(typeRow("info")).toContainText("原笔记正文");
  await expect(typeRow("info")).toContainText("原备注");
  await openLibrary("notices");
  await library
    .getByRole("button", { name: "恢复资讯：原新闻 2", exact: true })
    .click();
  await library.getByRole("button", { name: "关闭对话框" }).click();
  await expect(typeRow("notice")).toHaveCount(1);
  expect(
    (await stored()).widgets
      .filter((item) => item.type === "notice" && item.visible)
      .map((item) => item.noticeKey),
  ).toEqual(["notice:article:1"]);
  checks.push(
    "已保存的整体新闻占位按原位置拆为单条引用，保留旧新闻顺序、隐藏状态、角色及自定义笔记；恢复只恢复所选新闻。",
  );

  await page.evaluate(() =>
    localStorage.setItem("pixel-home-content", "damaged config"),
  );
  await page.reload();
  await expect(home.getByRole("alert")).toContainText("读取首页组件失败");
  await expect(
    home.getByRole("button", { name: "添加组件", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() => localStorage.getItem("pixel-home-content")),
  ).toBe("damaged config");
  await page.evaluate(() => localStorage.removeItem("pixel-home-content"));
  await home.getByRole("button", { name: "重试", exact: true }).click();
  await expect(
    home.getByRole("button", { name: "添加组件", exact: true }),
  ).toBeEnabled();
  await page.goto(`${url}?clean=on`);
  await expect(home.locator(".home-widget-list")).toHaveCount(0);
  await expect(page.locator(".launch-dock")).toBeVisible();
  checks.push(
    "损坏配置显示可重试错误、禁用写入并保留原文件；干净模式隐藏内容区，保留启动栏。",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` });
  throw error;
} finally {
  await browser.close();
}
