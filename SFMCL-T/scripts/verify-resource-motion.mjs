import { runtimePath } from "./lib/paths.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";

const evidence = runtimePath("evidence/resource-motion");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
const errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(resourceCenterFixture);
await page.addInitScript(() => {
  window.__catalogAnimations = [];
  window.__tabAnimations = [];
  window.__holdTabAnimations = false;
  window.__pixelTest.delays.manifest = 800;
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (...args) {
    const animation = animate.apply(this, args);
    if (args[1]?.id?.startsWith("sfmcl-t-catalog-"))
      window.__catalogAnimations.push(animation);
    if (args[1]?.id === "sfmcl-t-resource-tab") {
      window.__tabAnimations.push(animation);
      if (window.__holdTabAnimations) animation.pause();
    }
    return animation;
  };
});

const verifyResults = async () => {
  const sample = await page.evaluate(() => {
    const latest = new Map(
      window.__catalogAnimations
        .filter((animation) => animation.effect.target.isConnected)
        .map((animation) => [animation.effect.target, animation]),
    );
    const entries = [
      ...document.querySelectorAll(".catalog-project, .catalog-tags .badge"),
    ];
    return entries.map((element) => {
      const animation = latest.get(element);
      if (!animation) return null;
      animation.pause();
      const timing = animation.effect.getTiming();
      const frames = [0, 0.5, 0.999].map((fraction) => {
        animation.currentTime = timing.delay + timing.duration * fraction;
        const style = getComputedStyle(element);
        return {
          opacity: Number(style.opacity),
          y: new DOMMatrix(style.transform).m42,
        };
      });
      animation.finish();
      return frames;
    });
  });
  expect(sample.length).toBeGreaterThan(0);
  for (const frames of sample) {
    expect(frames).not.toBeNull();
    expect(frames[0].opacity).toBe(0);
    expect(frames[1].opacity).toBeGreaterThan(0);
    expect(frames[1].opacity).toBeLessThan(1);
    expect(frames[1].y).toBeLessThan(frames[0].y);
    expect(frames[2].opacity).toBeCloseTo(1, 2);
    expect(frames[2].y).toBeCloseTo(0, 2);
  }
};

const sampleFilters = async () =>
  page.evaluate(() => {
    const filters = document.querySelector(".catalog-filters");
    const arrow = document.querySelector(".catalog-filter-chevron");
    const animations = [...filters.getAnimations(), ...arrow.getAnimations()];
    animations.forEach((animation) => animation.pause());
    const frames = [0, 100, 240].map((time) => {
      animations.forEach((animation) => {
        animation.currentTime = time;
      });
      return {
        height: filters.getBoundingClientRect().height,
        opacity: Number(getComputedStyle(filters).opacity),
        arrow: getComputedStyle(arrow).transform,
      };
    });
    animations.forEach((animation) => animation.finish());
    return frames;
  });

const tabMotionCount = () => page.evaluate(() => window.__tabAnimations.length);
const sampleTab = async (direction, selector) => {
  const frames = await page.evaluate((target) => {
    const animation = window.__tabAnimations.at(-1);
    const element = animation.effect.target;
    if (!element.matches(target))
      throw new Error("Tab animated the wrong content region");
    const frames = [0, 100, 239.99].map((time) => {
      animation.currentTime = time;
      const style = getComputedStyle(element);
      return {
        x: new DOMMatrix(style.transform).m41,
        opacity: Number(style.opacity),
      };
    });
    animation.finish();
    return frames;
  }, selector);
  expect(frames[0].x * direction).toBeGreaterThan(0);
  expect(frames[1].x * direction).toBeGreaterThan(0);
  expect(Math.abs(frames[1].x)).toBeLessThan(Math.abs(frames[0].x));
  expect(frames[1].opacity).toBeGreaterThan(frames[0].opacity);
  expect(frames[1].opacity).toBeLessThan(1);
  expect(frames[2].x).toBeCloseTo(0, 2);
  await expect(page.locator(selector)).toHaveCSS("transform", "none");
};

// Visibility assertions alone miss text painted underneath an opaque indicator.
// Inspect Chromium's actual paint order for the label, icon and count instead.
const cdp = await page.context().newCDPSession(page);
const verifyTabPaint = async (id) => {
  const { documents, strings } = await cdp.send("DOMSnapshot.captureSnapshot", {
    computedStyles: [],
    includePaintOrder: true,
  });
  const { nodes, layout } = documents[0];
  const attribute = (index, name) => {
    const attributes = nodes.attributes[index];
    for (let i = 0; i < attributes.length; i += 2)
      if (strings[attributes[i]] === name) return strings[attributes[i + 1]];
  };
  const tab = nodes.attributes.findIndex(
    (_, index) => attribute(index, "id") === id,
  );
  const content = nodes.parentIndex.findIndex(
    (parent, index) =>
      parent === tab && attribute(index, "class") === "tab-content",
  );
  const indicator = nodes.attributes.findIndex((_, index) =>
    attribute(index, "class")?.split(" ").includes("tab-indicator"),
  );
  expect(tab).toBeGreaterThanOrEqual(0);
  expect(content).toBeGreaterThanOrEqual(0);
  expect(indicator).toBeGreaterThanOrEqual(0);
  const paints = (root) =>
    layout.nodeIndex.flatMap((index, position) => {
      while (index >= 0) {
        if (index === root) return [layout.paintOrders[position]];
        index = nodes.parentIndex[index];
      }
      return [];
    });
  const foreground = paints(content);
  const background = paints(indicator);
  expect(foreground.length).toBeGreaterThan(0);
  expect(background.length).toBeGreaterThan(0);
  expect(Math.min(...foreground)).toBeGreaterThan(Math.max(...background));
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "资源中心", exact: true })
    .click();
  await expect(page.locator(".catalog-skeleton")).toHaveCount(6);
  await expect(
    page.getByText("正在获取官方版本清单…", { exact: true }),
  ).toHaveCount(0);
  const pulse = await page
    .locator(".catalog-skeleton > span")
    .first()
    .evaluate((element) => {
      const animation = element.getAnimations()[0];
      animation.pause();
      const values = [0, 550, 1100].map((time) => {
        animation.currentTime = time;
        return Number(getComputedStyle(element).opacity);
      });
      animation.play();
      return values;
    });
  expect(pulse[0]).toBeLessThan(pulse[1]);
  expect(pulse[1]).toBeLessThan(pulse[2]);
  checks.push(
    "Minecraft loading shows animated skeletons without the manifest text",
  );

  for (const tab of ["Minecraft", "模组", "材质包", "光影", "数据包"]) {
    await page
      .getByRole("tablist", { name: "资源中心分类" })
      .getByRole("tab", { name: tab, exact: true })
      .click();
    await expect(page.locator(".catalog-results")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    for (const view of ["list", "grid"]) {
      const target = page.getByRole("button", {
        name: view === "grid" ? "切换为卡片视图" : "切换为列表视图",
        exact: true,
      });
      if (await target.count()) await target.click();
      await verifyResults();
    }
    const count = await page.evaluate(() => window.__catalogAnimations.length);
    await page.locator(".catalog-project-info").first().click();
    await page.getByRole("button", { name: "返回上一级", exact: true }).click();
    expect(await page.evaluate(() => window.__catalogAnimations.length)).toBe(
      count,
    );
  }
  checks.push(
    "All five tabs animate every list/card and badge; returning from details does not replay entry animations",
  );

  await page.evaluate(() => {
    window.__holdTabAnimations = true;
  });
  const resourceTabs = page.getByRole("tablist", { name: "资源中心分类" });
  await resourceTabs
    .getByRole("tab", { name: "Minecraft", exact: true })
    .click();
  await sampleTab(-1, ".resource-catalog");
  const versionTabs = page.getByRole("tablist", { name: "Minecraft 版本类型" });
  await versionTabs.getByRole("tab", { name: "全部", exact: true }).click();
  await sampleTab(1, "#minecraft-version-types-panel");
  await versionTabs.getByRole("tab", { name: "正式版", exact: true }).click();
  await sampleTab(-1, "#minecraft-version-types-panel");
  const beforeData = await tabMotionCount();
  await expect(page.locator(".catalog-results")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await versionTabs.getByRole("tab", { name: "正式版", exact: true }).click();
  await resourceTabs
    .getByRole("tab", { name: "Minecraft", exact: true })
    .click();
  expect(await tabMotionCount()).toBe(beforeData);

  await resourceTabs.getByRole("tab", { name: "模组", exact: true }).click();
  await resourceTabs
    .getByRole("tab", { name: "Minecraft", exact: true })
    .click();
  expect(
    await page.evaluate(() => window.__tabAnimations.at(-2).playState),
  ).toBe("idle");
  await sampleTab(-1, ".resource-catalog");
  await resourceTabs.getByRole("tab", { name: "光影", exact: true }).focus();
  await page.keyboard.press("Enter");
  await sampleTab(1, ".resource-catalog");
  const beforeDetail = await tabMotionCount();
  await page.locator(".catalog-project-info").first().click();
  expect(await tabMotionCount()).toBe(beforeDetail);
  const detailTabs = page.getByRole("tablist", { name: "资源详情" });
  await detailTabs.getByRole("tab", { name: /^可下载版本/ }).click();
  await sampleTab(1, "#project-panel");
  await detailTabs.getByRole("tab", { name: "项目介绍", exact: true }).click();
  await sampleTab(-1, "#project-panel");
  const beforeReturn = await tabMotionCount();
  await page.getByRole("button", { name: "返回上一级", exact: true }).click();
  expect(await tabMotionCount()).toBe(beforeReturn);
  checks.push(
    "Resource, Minecraft type and detail tabs slide and fade in both directions; keyboard and rapid switching work without replaying on data updates, repeated selection or detail navigation",
  );

  const toggle = page.getByRole("button", { name: /^筛选/ });
  await toggle.click();
  const opening = await sampleFilters();
  expect(opening[0].height).toBeLessThan(opening[1].height);
  expect(opening[1].height).toBeLessThan(opening[2].height);
  expect(opening[0].arrow).not.toBe(opening[1].arrow);
  await page.getByRole("textbox", { name: "游戏版本", exact: true }).focus();
  await page.keyboard.press("Escape");
  const closing = await sampleFilters();
  expect(closing[0].height).toBeGreaterThan(closing[1].height);
  expect(closing[1].height).toBeGreaterThan(closing[2].height);
  expect(closing[2].height).toBe(0);
  await expect(toggle).toBeFocused();
  await expect(
    page.getByRole("textbox", { name: "游戏版本", exact: true }),
  ).toBeHidden();
  await toggle.click();
  // Reverse an in-flight transition; the final state must remain collapsed.
  await toggle.click({ force: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".catalog-filters")).toHaveCSS(
    "visibility",
    "hidden",
  );
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(
    page.getByRole("textbox", { name: "游戏版本", exact: true }),
  ).toBeVisible();
  checks.push(
    "Filter height and arrow interpolate in both directions, reverse cleanly, restore focus, and remain visible in the wide sidebar",
  );

  await page.evaluate(() => {
    window.__countFrames = [];
    document.addEventListener("animationstart", (event) => {
      if (!event.animationName.startsWith("catalog-count-")) return;
      const animation = event.target.getAnimations()[0];
      animation.pause();
      const duration = animation.effect.getTiming().duration;
      const opacity = [0, 0.5, 0.999].map((fraction) => {
        animation.currentTime = duration * fraction;
        return Number(getComputedStyle(event.target).opacity);
      });
      window.__countFrames.push({ name: event.animationName, opacity });
      animation.finish();
    });
  });
  const search = page.getByRole("searchbox", { name: "搜索资源", exact: true });
  await search.fill("slow");
  await search.press("Enter");
  await expect(page.locator(".catalog-result-count")).toHaveText("1 个结果");
  const counts = await page.evaluate(() => window.__countFrames);
  for (const name of ["catalog-count-in", "catalog-count-out"]) {
    const frames = counts.filter((entry) => entry.name === name);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const { opacity } of frames) {
      if (name.endsWith("-in")) {
        expect(opacity[0]).toBeLessThan(opacity[1]);
        expect(opacity[1]).toBeLessThan(opacity[2]);
      } else {
        expect(opacity[0]).toBeGreaterThan(opacity[1]);
        expect(opacity[1]).toBeGreaterThan(opacity[2]);
      }
    }
  }
  checks.push(
    "Result count crossfades both when search starts and when results arrive",
  );
  await page.screenshot({
    path: `${evidence}/resources.png`,
    animations: "disabled",
  });
  await resourceTabs.getByRole("tab", { name: "模组", exact: true }).click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  expect(
    await page.evaluate(() => window.__tabAnimations.at(-1).playState),
  ).toBe("idle");
  checks.push(
    "Leaving the resource center cancels an unfinished tab animation",
  );

  const beforeLocal = await tabMotionCount();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "版本管理", exact: true })
    .click();
  await page
    .getByRole("button", { name: "查看 1.21.4 本地资源", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "1.21.4 Sodium" }),
  ).toBeVisible();
  expect(await tabMotionCount()).toBe(beforeLocal);
  const localTabs = page.getByRole("tablist", { name: "本地资源类型" });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => (document.documentElement.dataset.theme = value),
      theme,
    );
    for (const [kind, direction] of [
      ["resourcepack", 1],
      ["shader", 1],
      ["world", 1],
      ["mod", -1],
    ]) {
      const tab = localTabs.locator(`#version-resources-tab-${kind}`);
      await tab.click();
      await sampleTab(direction, "#version-resources-panel");
      await localTabs.evaluate((el) =>
        Promise.allSettled(
          el
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished),
        ),
      );
      await expect(tab).toHaveAttribute("aria-selected", "true");
      expect(await tab.evaluate((el) => el.matches(":hover"))).toBe(true);
      await verifyTabPaint(`version-resources-tab-${kind}`);
      await page.mouse.down();
      await verifyTabPaint(`version-resources-tab-${kind}`);
      await page.mouse.up();
    }
    await page.screenshot({
      path: `${evidence}/local-tabs-${theme}.png`,
      animations: "disabled",
    });
  }
  const beforeLocalUpdate = await tabMotionCount();
  await localTabs.getByRole("tab", { name: /^模组/ }).click();
  await page
    .getByRole("searchbox", { name: "搜索本地资源", exact: true })
    .fill("Sodium");
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "1.21.4 Sodium" }),
  ).toBeVisible();
  expect(await tabMotionCount()).toBe(beforeLocalUpdate);
  await page
    .getByRole("searchbox", { name: "搜索本地资源", exact: true })
    .fill("");
  await localTabs.getByRole("tab", { name: /^光影/ }).focus();
  await page.keyboard.press("Enter");
  await sampleTab(1, "#version-resources-panel");
  await localTabs.getByRole("tab", { name: /^材质包/ }).click();
  await localTabs.getByRole("tab", { name: /^存档/ }).click();
  expect(
    await page.evaluate(() => window.__tabAnimations.at(-2).playState),
  ).toBe("idle");
  await sampleTab(1, "#version-resources-panel");
  await localTabs.getByRole("tab", { name: /^模组/ }).click();
  await page.getByRole("button", { name: "返回上一级", exact: true }).click();
  expect(
    await page.evaluate(() => window.__tabAnimations.at(-1).playState),
  ).toBe("idle");
  checks.push(
    "Local tabs keep labels, icons and counts above the sliding indicator during hover and press in both themes; content animates in both directions, supports keyboard and rapid switching, and cancels on exit without replaying on refresh/search/reselection",
  );

  await page.setViewportSize({ width: 1120, height: 640 });
  const beforeSettings = await tabMotionCount();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  expect(await tabMotionCount()).toBe(beforeSettings);
  const settingsTabs = page.getByRole("tablist", { name: "设置分类" });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await expect(page.locator(".sidebar")).toHaveCSS(
      "background-image",
      "none",
    );
    await page.evaluate(() =>
      Promise.allSettled(
        document
          .getAnimations()
          .filter((a) => a.effect.getTiming().iterations !== Infinity)
          .map((a) => a.finished),
      ),
    );
    const header = await page.locator(".page-heading").boundingBox();
    for (const [name, direction] of [
      ["全局设置", 1],
      ["关于", 1],
      ["启动器设置", -1],
    ]) {
      await settingsTabs.getByRole("tab", { name, exact: true }).click();
      await sampleTab(direction, "#settings-panel");
      expect(await page.locator(".page-heading").boundingBox()).toEqual(header);
    }
    await settingsTabs.getByRole("tab", { name: "关于", exact: true }).click();
    await sampleTab(1, "#settings-panel");
    const beforeRepeat = await tabMotionCount();
    await settingsTabs.getByRole("tab", { name: "关于", exact: true }).click();
    expect(await tabMotionCount()).toBe(beforeRepeat);
    await expect(
      page.getByRole("button", { name: "原项目主页", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "从旧版迁移", exact: true }),
    ).toHaveCount(0);
    const icon = page.getByRole("img", { name: "SFMCL-T 软件图标", exact: true });
    await expect(icon).toBeVisible();
    expect(
      await icon.evaluate(
        (el) =>
          el.complete &&
          el.naturalWidth > 0 &&
          el.src === document.querySelector(".brand-mark").src,
      ),
    ).toBe(true);
    await page.mouse.move(1000, 610);
    for (const collapsed of [false, true]) {
      if (collapsed) {
        await page.locator(".brand-logo").hover();
        await page.locator(".sidebar-collapse").click();
        await page.mouse.move(1000, 610);
      }
      await page.evaluate(() =>
        Promise.allSettled(
          document
            .getAnimations()
            .filter((a) => a.effect.getTiming().iterations !== Infinity)
            .map((a) => a.finished),
        ),
      );
      expect(
        await page
          .locator("main.page")
          .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);
      await page.screenshot({
        path: `${evidence}/settings-about-${theme}-${collapsed ? "collapsed" : "expanded"}-1120.png`,
      });
    }
    await page.locator(".brand-logo").hover();
    await page.locator(".sidebar-collapse").click();
    await settingsTabs
      .getByRole("tab", { name: "启动器设置", exact: true })
      .click();
    await sampleTab(-1, "#settings-panel");
  }
  await settingsTabs
    .getByRole("tab", { name: "全局设置", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await sampleTab(1, "#settings-panel");
  await settingsTabs.getByRole("tab", { name: "关于", exact: true }).click();
  await settingsTabs
    .getByRole("tab", { name: "启动器设置", exact: true })
    .click();
  expect(
    await page.evaluate(() => window.__tabAnimations.at(-2).playState),
  ).toBe("idle");
  await sampleTab(-1, "#settings-panel");
  checks.push(
    "设置内容支持双向、键盘和快速切换动画，标题保持原位且重复点击不重播；关于页移除主页按钮及迁移卡片，并在 1120×640 明暗主题与展开/收起侧栏下显示软件图标，无横向溢出",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser.close();
}
