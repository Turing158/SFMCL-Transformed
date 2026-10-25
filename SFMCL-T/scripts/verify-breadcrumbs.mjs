import { runtimePath } from "./lib/paths.mjs";
import { answerConfirmation } from "./lib/confirmation.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";

const evidence = runtimePath("evidence/breadcrumbs");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(8000);
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(resourceCenterFixture);
await page.addInitScript(() => {
  window.__pixelTest.data.settings.downloadTaskDisplay = "always";
  window.__breadcrumbTest = {
    motions: [],
    holdMotion: false,
  };
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (...args) {
    const animation = animate.apply(this, args);
    if (args[1]?.id?.startsWith("sfmcl-t-navigation-")) {
      window.__breadcrumbTest.motions.push(animation);
      if (window.__breadcrumbTest.holdMotion) animation.pause();
    }
    return animation;
  };
});
const path = page.getByRole("navigation", { name: "页面路径" });
const nav = (name) =>
  name === "角色管理"
    ? page.locator(".sidebar .profile-button").click()
    : page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name, exact: true })
        .click();
const backButton = path.getByRole("button", {
  name: "返回上一级",
  exact: true,
});
const back = () => backButton.click();
const openDownloads = () => page.locator(".sidebar-task").click();
const labels = () => path.locator("button, strong");
const openSettings = () =>
  page.getByRole("button", { name: "游戏设置 1.21.4", exact: true }).click();
const motionCount = () =>
  page.evaluate(() => window.__breadcrumbTest.motions.length);
const finishMotion = async () => {
  await page.evaluate(() => {
    window.__breadcrumbTest.holdMotion = false;
    window.__breadcrumbTest.motions.forEach((animation) => {
      if (["running", "paused"].includes(animation.playState))
        animation.finish();
    });
  });
  await expect(page.locator(".page")).toHaveCSS("transform", "none");
  await expect(path.locator("ol")).toHaveCSS("transform", "none");
};
const holdMotion = async () => {
  await finishMotion();
  await page.evaluate(() => {
    window.__breadcrumbTest.motions = [];
    window.__breadcrumbTest.holdMotion = true;
  });
};
const verifyMotion = async (direction, screenshot) => {
  await expect.poll(motionCount).toBe(2);
  const frames = await page.evaluate(() => {
    const motions = window.__breadcrumbTest.motions;
    const sample = (time) => {
      motions.forEach((animation) => {
        animation.currentTime = time;
      });
      return motions.map((animation) => {
        const style = getComputedStyle(animation.effect.target);
        return {
          x: new DOMMatrix(style.transform).m41,
          opacity: Number(style.opacity),
        };
      });
    };
    const start = sample(0),
      end = sample(259.99),
      middle = sample(110);
    return { start, middle, end };
  });
  for (let i = 0; i < 2; i++) {
    expect(frames.start[i].x * direction).toBeGreaterThan(0);
    expect(frames.middle[i].x * direction).toBeGreaterThan(0);
    expect(Math.abs(frames.middle[i].x)).toBeLessThan(
      Math.abs(frames.start[i].x),
    );
    expect(frames.end[i].x).toBeCloseTo(0, 2);
    expect(frames.middle[i].opacity).toBeGreaterThan(frames.start[i].opacity);
    expect(frames.middle[i].opacity).toBeLessThan(1);
  }
  if (screenshot)
    await page.screenshot({ path: `${evidence}/${screenshot}.png` });
  await finishMotion();
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await expect(labels()).toHaveText(["开始游戏"]);
  let previousName = "开始游戏";
  for (const name of [
    "角色管理",
    "版本管理",
    "资源中心",
    "设置",
    "设置",
    "开始游戏",
  ]) {
    const before = await motionCount();
    await nav(name);
    const label = name === "资源中心" ? "Minecraft资源" : name;
    await expect(labels()).toHaveText([label]);
    await expect(path.getByRole("button")).toHaveCount(0);
    await expect(path.locator(".breadcrumb-separator")).toHaveCount(0);
    await expect(path.locator('[aria-current="page"]')).toHaveText(label);
    expect(await motionCount()).toBe(before + (name === previousName ? 0 : 2));
    previousName = name;
  }
  checks.push("各主页面独立作为父页面，切换或重复点击后只显示当前页面名称");

  for (const name of ["开始游戏", "角色管理", "版本管理", "资源中心", "设置"]) {
    await nav(name);
    const parentLabel = name === "资源中心" ? "Minecraft资源" : name;
    await holdMotion();
    await openDownloads();
    await expect(labels()).toHaveText(["", "下载中心"]);
    await expect(backButton).toHaveAttribute(
      "data-tooltip",
      `返回${parentLabel}`,
    );
    await verifyMotion(1);
    const beforeRepeat = await motionCount();
    await openDownloads();
    await expect(labels()).toHaveText(["", "下载中心"]);
    expect(await motionCount()).toBe(beforeRepeat);
    await holdMotion();
    await back();
    await expect(labels()).toHaveText([parentLabel]);
    await verifyMotion(-1);
  }
  checks.push(
    "下载中心始终是进入前页面的子页面；五个主页面都可通过返回箭头回到原页，重复点击下载不改变父页面或重播动画",
  );

  await nav("版本管理");
  await openSettings();
  await expect(labels()).toHaveText(["", "1.21.4 · 游戏设置"]);
  await expect(
    path.locator("li").first().locator("button"),
  ).toHaveAccessibleName("返回上一级");
  await expect(backButton.locator("svg")).toBeVisible();
  await expect(backButton).toHaveAttribute("data-tooltip", "返回版本管理");
  await expect(path.locator('[aria-current="page"]')).toHaveCount(1);
  const independent = page.getByRole("switch", {
    name: "内存与游戏目录：独立设置",
    exact: true,
  });
  await independent.click();
  const beforeCancelledNavigation = await motionCount();
  await back();
  await answerConfirmation(page, false);
  await expect(independent).toBeChecked();
  await expect(path.locator("strong")).toHaveText("1.21.4 · 游戏设置");
  expect(await motionCount()).toBe(beforeCancelledNavigation);
  await back();
  await answerConfirmation(page, true);
  await expect(labels()).toHaveText(["版本管理"]);
  checks.push(
    "版本游戏设置接入路径；未保存时取消会留在原页，确认后返回版本管理",
  );

  await openSettings();
  await independent.click();
  await openDownloads();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(labels()).toHaveText(["", "1.21.4 · 游戏设置", "下载中心"]);
  await expect(backButton).toHaveAttribute(
    "data-tooltip",
    "返回1.21.4 · 游戏设置",
  );
  await back();
  await expect(labels()).toHaveText(["", "1.21.4 · 游戏设置"]);
  await expect(independent).toBeChecked();
  await back();
  await answerConfirmation(page, true);
  checks.push(
    "从未保存的版本设置进入下载保留草稿，下载返回对应版本设置；明确返回版本列表仍确认放弃修改",
  );

  await page
    .getByRole("button", { name: "查看 1.21.4 本地资源", exact: true })
    .click();
  await expect(labels()).toHaveText(["", "1.21.4 · 本地资源"]);
  await page.getByRole("combobox", { name: "查看资源的游戏版本" }).click();
  await page
    .getByRole("option", { name: "1.20.1-Fabric", exact: true })
    .click();
  await expect(labels()).toHaveText(["", "1.20.1-Fabric · 本地资源"]);
  await nav("资源中心");
  await expect(labels()).toHaveText(["Minecraft资源"]);
  await expect(path.getByRole("button")).toHaveCount(0);
  await nav("版本管理");
  await expect(labels()).toHaveText(["", "1.20.1-Fabric · 本地资源"]);
  await expect(
    page.getByRole("combobox", { name: "查看资源的游戏版本", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "查看资源的游戏版本" }),
  ).toContainText("1.20.1-Fabric");
  checks.push("本地资源切换版本保留父子层级；切换主页面恢复之前的子页面路径");

  for (const width of [1440, 768, 375]) {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width, height: 900 });
    const parent = backButton;
    await expect(parent).toBeVisible();
    await expect(path.locator("strong")).toBeVisible();
    const bounds = await page.locator(".topbar").evaluate((bar) => ({
      width: bar.clientWidth,
      content: bar.scrollWidth,
      pathRight: bar.querySelector(".topbar-breadcrumb").getBoundingClientRect()
        .right,
      controlsLeft: bar
        .querySelector(".window-controls")
        .getBoundingClientRect().left,
    }));
    expect(bounds.content).toBeLessThanOrEqual(bounds.width + 1);
    expect(bounds.pathRight).toBeLessThanOrEqual(bounds.controlsLeft);
    expect(
      await parent.evaluate(
        (button) => button.scrollWidth <= button.clientWidth,
      ),
    ).toBe(true);
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
    await page.screenshot({ path: `${evidence}/path-${width}.png` });
    await holdMotion();
    await parent.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "版本管理", exact: true }),
    ).toBeVisible();
    await expect(labels()).toHaveText(["版本管理"]);
    await verifyMotion(-1, `motion-back-${width}`);
    await holdMotion();
    await page
      .getByRole("button", { name: "查看 1.20.1-Fabric 本地资源", exact: true })
      .click();
    await verifyMotion(1, `motion-forward-${width}`);
  }
  checks.push(
    "1440/768/375px 下上一级与当前页可见，无标题栏溢出，键盘 Enter 可返回",
  );
  checks.push(
    "父子页面与面包屑在 1440/768/375px 同步滑动淡入，返回方向相反；重复点击与取消未保存确认不重播动画",
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  await nav("开始游戏");
  for (const name of ["角色管理", "设置", "资源中心", "版本管理"])
    await nav(name);
  await back();
  await openSettings();
  await expect(labels()).toHaveText(["", "1.21.4 · 游戏设置"]);
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(backButton).toBeInViewport();
  await expect(path.locator("strong")).toBeInViewport();
  await back();
  await expect(
    page.getByRole("heading", { name: "版本管理", exact: true }),
  ).toBeVisible();
  await expect(labels()).toHaveText(["版本管理"]);
  checks.push("多次主页面切换后，子页面首项仍为返回箭头，并指向所属上一级页面");

  await holdMotion();
  await openSettings();
  await expect.poll(motionCount).toBe(2);
  await backButton.evaluate((button) => button.click());
  await expect(labels()).toHaveText(["版本管理"]);
  await expect.poll(motionCount).toBe(4);
  expect(
    await page.evaluate(() =>
      window.__breadcrumbTest.motions
        .slice(0, 2)
        .every((animation) => animation.playState === "idle"),
    ),
  ).toBe(true);
  await finishMotion();
  checks.push("连续父子跳转取消旧动画，结束后清理内容区与路径的变换");

  await page.setViewportSize({ width: 1440, height: 900 });
  await nav("资源中心");
  await finishMotion();
  const resourceTabs = page.getByRole("tablist", { name: "资源中心分类" });
  for (const [tab, width, triggerName, title, heading] of [
    [
      "Minecraft",
      1440,
      "查看 Minecraft 1.20.1 安装配置",
      "1.20.1 · 安装配置",
      "安装 Minecraft 1.20.1",
    ],
    ["模组", 768, "查看 Sodium 详情", "Sodium", "Sodium"],
    ["材质包", 375, "查看 Sodium 详情", "Sodium", "Sodium"],
    ["光影", 1440, "查看 Sodium 详情", "Sodium", "Sodium"],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    const beforeTab = await motionCount();
    await resourceTabs.getByRole("tab", { name: tab, exact: true }).click();
    const trigger = page.getByRole("button", {
      name: triggerName,
      exact: true,
    });
    await expect(trigger).toBeVisible();
    await expect(labels()).toHaveText([`${tab}资源`]);
    await expect(backButton).toHaveCount(0);
    expect(await motionCount()).toBe(beforeTab);
    await holdMotion();
    await trigger.click();
    await expect(labels()).toHaveText(["", title]);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(resourceTabs).toBeHidden();
    await expect(page.locator(".resource-catalog")).toBeHidden();
    await expect(page.locator(".resource-subpage-header h1")).toHaveText(
      heading,
    );
    await expect(page.locator(".resource-subpage-header h1")).toBeFocused();
    await expect(backButton).toBeInViewport();
    await expect(backButton).toHaveAttribute("data-tooltip", `返回${tab}资源`);
    await expect(
      page.getByRole("button", { name: /^返回.*列表$/ }),
    ).toHaveCount(0);
    await expect(path.locator("strong")).toBeInViewport();
    await verifyMotion(1);
    if (tab !== "Minecraft") {
      const beforeInternalTab = await motionCount();
      await page.getByRole("tab", { name: /可下载版本/ }).click();
      await expect(
        page.getByRole("textbox", { name: "筛选游戏版本" }),
      ).toBeVisible();
      await expect(
        page.getByRole("combobox", { name: "筛选加载器" }),
      ).toBeVisible();
      await page.getByRole("tab", { name: "项目介绍", exact: true }).click();
      expect(await motionCount()).toBe(beforeInternalTab);
      if (tab === "模组") {
        const bootstraps = () =>
          page.evaluate(
            () =>
              window.__pixelTest.requests.filter(
                (request) => request.operation === "bootstrap",
              ).length,
          );
        const beforeRefresh = await bootstraps();
        await page.evaluate(() => {
          window.__pixelTest.tasks.jobs.push({
            id: "resource-refresh",
            title: "完成安装",
            status: "completed",
            currentStep: 0,
            steps: [],
            log: [],
          });
        });
        await expect.poll(bootstraps).toBeGreaterThan(beforeRefresh);
        await expect(page.locator(".resource-subpage-header h1")).toHaveText(
          heading,
        );
        expect(await motionCount()).toBe(beforeInternalTab);
      }
      await page.screenshot({
        path: `${evidence}/resource-subpage-${width}.png`,
      });
    }
    await holdMotion();
    await back();
    await expect(labels()).toHaveText([`${tab}资源`]);
    await expect(backButton).toHaveCount(0);
    await expect(page.locator(".resource-subpage")).toHaveCount(0);
    await expect(resourceTabs).toBeVisible();
    await expect(
      resourceTabs.getByRole("tab", { name: tab, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(trigger).toBeFocused();
    await verifyMotion(-1);
  }
  await page
    .getByRole("button", { name: "查看 Sodium 详情", exact: true })
    .click();
  await finishMotion();
  await holdMotion();
  await back();
  await expect(page.locator(".resource-subpage")).toHaveCount(0);
  await expect(labels()).toHaveText(["光影资源"]);
  await verifyMotion(-1);
  await resourceTabs
    .getByRole("tab", { name: "Minecraft", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "查看 Minecraft 1.20.1 安装配置",
      exact: true,
    })
    .click();
  await finishMotion();
  await holdMotion();
  await back();
  await expect(page.locator(".resource-subpage")).toHaveCount(0);
  await verifyMotion(-1);
  await expect(labels()).toHaveText(["Minecraft资源"]);
  await expect(backButton).toHaveCount(0);
  checks.push(
    "四类资源 Tab 都是父页面，路径显示对应分类资源且没有返回箭头；详情箭头返回所属 Tab，窄屏保留箭头与当前页，进入和返回有动画，普通分类切换、详情 Tab 和后台刷新不重播",
  );

  for (const [tab, trigger, title] of [
    ["Minecraft", "查看 Minecraft 1.20.1 安装配置", "1.20.1 · 安装配置"],
    ["模组", "查看 Sodium 详情", "Sodium"],
  ]) {
    await resourceTabs.getByRole("tab", { name: tab, exact: true }).click();
    await page.getByRole("button", { name: trigger, exact: true }).click();
    await openDownloads();
    await expect(labels()).toHaveText(["", title, "下载中心"]);
    await expect(backButton).toHaveAttribute("data-tooltip", `返回${title}`);
    await holdMotion();
    await back();
    await expect(labels()).toHaveText(["", title]);
    await expect(page.locator(".resource-subpage")).toBeVisible();
    await verifyMotion(-1);
    await back();
    await expect(labels()).toHaveText([`${tab}资源`]);
  }
  checks.push(
    "从 Minecraft 安装配置或项目详情进入下载后，返回准确恢复对应子页面及资源分类层级",
  );

  await nav("版本管理");
  await page
    .getByRole("button", { name: "查看 1.21.4 本地资源", exact: true })
    .click();
  await page
    .getByRole("button", { name: "1.21.4 Sodium 详情", exact: true })
    .click();
  await expect(labels()).toHaveText(["", "1.21.4 · 本地资源", "1.21.4 Sodium"]);
  await page
    .getByRole("button", {
      name: "1.21.4 Sodium 的 Modrinth 详情",
      exact: true,
    })
    .click();
  await openDownloads();
  await finishMotion();
  const fullPath = ["", "1.21.4 Sodium", "1.21.4 Sodium", "下载中心"];
  const layouts = [];
  for (const width of [1440, 768, 650, 550, 510, 475, 400, 375, 350, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(path.locator("strong")).toHaveText("下载中心");
    await expect
      .poll(() =>
        path
          .locator("ol")
          .evaluate((list) => list.scrollWidth <= list.clientWidth + 1),
      )
      .toBe(true);
    await expect(backButton).toHaveCount(1);
    await expect(backButton.locator("svg")).toBeVisible();
    await expect(backButton).toBeInViewport();
    const texts = await labels().allTextContents();
    expect(texts[0]).toBe("");
    const pathTexts = texts.slice(1);
    expect(pathTexts.length).toBeLessThanOrEqual(3);
    expect(pathTexts.length).toBeGreaterThan(0);
    const expected = fullPath.slice(-pathTexts.length);
    for (let index = 0; index < pathTexts.length - 1; index++)
      expect(["...", expected[index]]).toContain(pathTexts[index]);
    if (pathTexts.length < 3)
      expect(pathTexts.slice(0, -1)).toEqual(
        Array(pathTexts.length - 1).fill("..."),
      );
    expect(texts.at(-1)).toBe("下载中心");
    const bounds = await page.locator(".topbar").evaluate((bar) => ({
      width: bar.clientWidth,
      content: bar.scrollWidth,
      pathRight: bar.querySelector("nav").getBoundingClientRect().right,
      controlsLeft: bar
        .querySelector(".window-controls")
        .getBoundingClientRect().left,
    }));
    expect(bounds.content).toBeLessThanOrEqual(bounds.width + 1);
    expect(bounds.pathRight).toBeLessThanOrEqual(bounds.controlsLeft);
    layouts.push({ width, texts });
    await page.screenshot({ path: `${evidence}/collapsed-${width}.png` });
  }
  expect(layouts[0].texts).toEqual(fullPath);
  expect(
    layouts.some(
      ({ texts }) =>
        texts.length === 4 && texts[1] === "..." && texts[2] !== "...",
    ),
  ).toBe(true);
  expect(
    layouts.some(
      ({ texts }) =>
        texts.length === 4 && texts[1] === "..." && texts[2] === "...",
    ),
  ).toBe(true);
  expect(layouts.some(({ texts }) => texts.length === 3)).toBe(true);
  expect(layouts.at(-1).texts).toEqual(["", "下载中心"]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(labels()).toHaveText(fullPath);
  checks.push(
    "最多显示三个最近标签；空间不足先从左侧逐项变为省略号，全部缩短仍不够才隐藏上级；放大恢复名称，返回箭头与当前页始终保留且无标题栏溢出",
  );

  for (const { width, texts } of layouts) {
    await page.setViewportSize({ width, height: 900 });
    await expect(labels()).toHaveText(texts);
    await expect(backButton).toHaveAttribute(
      "data-tooltip",
      "返回1.21.4 Sodium",
    );
    await backButton.click();
    await expect(path.locator("strong")).toHaveText("1.21.4 Sodium");
    await expect(backButton.locator("svg")).toBeVisible();
    await openDownloads();
    await expect(labels()).toHaveText(texts);
    await backButton.focus();
    await page.keyboard.press("Enter");
    await expect(path.locator("strong")).toHaveText("1.21.4 Sodium");
    await expect(
      page.locator(
        '[data-page="versions"][data-view="resources"] .resource-subpage-header h1',
      ),
    ).toHaveText("Sodium");
    await openDownloads();
    await expect(labels()).toHaveText(texts);
    const ellipses = path.locator(".breadcrumb-ellipsis");
    for (
      let index = 0;
      index < texts.filter((text) => text === "...").length;
      index++
    ) {
      await expect(ellipses.nth(index)).toHaveAttribute(
        "data-tooltip",
        "返回1.21.4 Sodium",
      );
      await ellipses.nth(index).focus();
      await page.keyboard.press("Enter");
      await expect(path.locator("strong")).toHaveText("1.21.4 Sodium");
      const targetIndex = 3 - (texts.length - 1) + index;
      if (targetIndex === 0) {
        await expect(page.locator(".local-resource-page")).toBeVisible();
        await expect(
          page.locator('[data-page="versions"][data-view="resources"]'),
        ).toHaveCount(0);
        await page
          .getByRole("button", {
            name: "1.21.4 Sodium 的 Modrinth 详情",
            exact: true,
          })
          .click();
      } else {
        await expect(
          page.locator(
            '[data-page="versions"][data-view="resources"] .resource-subpage-header h1',
          ),
        ).toHaveText("Sodium");
        await expect(page.locator(".local-resource-page")).toBeHidden();
      }
      await openDownloads();
      await expect(labels()).toHaveText(texts);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(labels()).toHaveText(fullPath);
  await path
    .getByRole("button", { name: "1.21.4 Sodium", exact: true })
    .first()
    .click();
  await expect(path.locator("strong")).toHaveText("1.21.4 Sodium");
  await back();
  await expect(labels()).toHaveText(["", "1.21.4 · 本地资源"]);
  checks.push(
    "返回箭头逐级返回；完整标签及省略号均返回各自对应的页面，同名本地详情和在线详情也可准确定位，隐藏标签不改变导航链",
  );

  const longCurrent = "超长模组名称与兼容信息".repeat(6);
  await page.evaluate((name) => {
    window.__pixelTest.resources.localItems["1.21.4"].mod[0].name = name;
  }, longCurrent);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page
    .getByRole("button", { name: `${longCurrent} 详情`, exact: true })
    .click();
  await page.setViewportSize({ width: 375, height: 900 });
  await expect(labels()).toHaveText(["", longCurrent]);
  await expect(backButton.locator("svg")).toBeVisible();
  await expect(backButton).toBeInViewport();
  await expect(path.locator('[aria-current="page"]')).toHaveText(longCurrent);
  await expect(path.locator("strong")).toHaveAttribute(
    "data-tooltip",
    longCurrent,
  );
  await expect(path.locator("strong")).toBeInViewport();
  await expect(path.locator("strong")).toHaveCSS("text-overflow", "clip");
  await page.screenshot({ path: `${evidence}/long-current-375.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect
    .poll(() =>
      path
        .locator("strong")
        .evaluate((label) => label.scrollWidth <= label.clientWidth + 1),
    )
    .toBe(true);
  await expect(labels()).toHaveText(["", "1.21.4 · 本地资源", longCurrent]);
  checks.push(
    "超长当前页名称保持原文和完整提示，窄窗口隐藏上级标签，放大后恢复完整显示",
  );

  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify({ checks, layouts, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser.close();
}
