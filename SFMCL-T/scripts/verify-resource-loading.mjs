import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence =
  process.env.SFMCL_T_TEST_ARTIFACT_DIR ||
  runtimePath("evidence/resource-loading");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 740 } });
page.setDefaultTimeout(8000);
const checks = [],
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(resourceCenterFixture);
await page.addInitScript(() => {
  window.__loadingTest = { held: ["manifest"], pending: [], animations: [] };
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    const operation = args?.operation;
    if (window.__loadingTest.held.includes(operation))
      await new Promise((release) => {
        window.__loadingTest.pending.push({ operation, release });
      });
    return invoke(command, args);
  };
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (frames, options) {
    const animation = animate.call(this, frames, options);
    if (options?.id?.startsWith("sfmcl-t-loading-")) {
      window.__loadingTest.animations.push(animation);
      animation.pause();
    }
    return animation;
  };
});

const nav = (name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const hold = (operation) =>
  page.evaluate((op) => {
    window.__loadingTest.held.push(op);
  }, operation);
const release = (operation) =>
  page.evaluate((op) => {
    const state = window.__loadingTest;
    state.held = state.held.filter((item) => item !== op);
    state.pending
      .filter((item) => item.operation === op)
      .forEach((item) => item.release());
    state.pending = state.pending.filter((item) => item.operation !== op);
  }, operation);
const finish = (region) =>
  region.evaluate((element) => {
    for (const animation of window.__loadingTest.animations)
      if (
        element.contains(animation.effect.target) &&
        animation.playState === "paused"
      )
        animation.finish();
  });
const sample = async (region, entering) => {
  const frames = await region.evaluate((element) =>
    [".loading-state-icon", ".loading-state-text"].map((selector) => {
      const target = element.querySelector(selector);
      const animation = window.__loadingTest.animations.findLast(
        (item) => item.effect.target === target && item.playState === "paused",
      );
      const timing = animation.effect.getTiming();
      return [0, 0.5, 0.999].map((fraction) => {
        animation.currentTime = timing.delay + timing.duration * fraction;
        const style = getComputedStyle(target);
        return {
          opacity: Number(style.opacity),
          y: new DOMMatrix(style.transform).m42,
        };
      });
    }),
  );
  for (const values of frames) {
    expect(values[0].opacity).toBeCloseTo(entering ? 0 : 1, 2);
    expect(values[1].opacity).toBeGreaterThan(0);
    expect(values[1].opacity).toBeLessThan(1);
    expect(values[2].opacity).toBeCloseTo(entering ? 1 : 0, 2);
    expect(entering ? values[0].y : values[2].y).toBeGreaterThan(values[1].y);
  }
};
const verifyLoading = async (region, label, operation, result) => {
  const indicator = region.locator(".loading-state");
  await expect(indicator).toHaveAttribute("data-loading", "true");
  await expect(indicator).toHaveText(label);
  await sample(region, true);
  const layout = await indicator.evaluate((element) => {
    const icon = element
      .querySelector(".loading-state-icon")
      .getBoundingClientRect();
    const text = element
      .querySelector(".loading-state-text")
      .getBoundingClientRect();
    return {
      gap: text.top - icon.bottom,
      offset: Math.abs(icon.x + icon.width / 2 - text.x - text.width / 2),
    };
  });
  expect(layout.gap).toBeGreaterThan(8);
  expect(layout.offset).toBeLessThan(1);
  await finish(region);
  await release(operation);
  await expect(indicator).toHaveAttribute("data-loading", "false");
  await expect(indicator).toHaveAttribute("aria-hidden", "true");
  await expect(region.locator(result)).toHaveCount(0);
  await sample(region, false);
  await finish(region);
  await expect(indicator).toHaveCount(0);
  await expect(region.locator(result).first()).toBeVisible();
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await nav("资源中心");
  const minecraft = page.locator(".minecraft-install .loading-region");
  await verifyLoading(
    minecraft,
    "正在加载 Minecraft 版本…",
    "manifest",
    ".catalog-project",
  );
  checks.push(
    "版本清单的图标、文字分别淡入淡出，图标在文字上方，退场结束后显示版本。",
  );

  const catalog = page.locator(
    ".resource-catalog .catalog-results > .loading-region",
  );
  const files = page.locator(".project-files .loading-region");
  for (const tab of ["模组", "材质包", "光影", "数据包", "整合包"]) {
    await hold("resources.search");
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await verifyLoading(
      catalog,
      `正在加载${tab}…`,
      "resources.search",
      ".catalog-project",
    );
    await hold("resources.files");
    await catalog.locator(".catalog-project-info").first().click();
    await page.getByRole("tab", { name: /^下载/ }).click();
    await verifyLoading(
      files,
      `正在加载${tab}文件…`,
      "resources.files",
      ".project-file",
    );
    await page
      .getByRole("navigation", { name: "页面路径" })
      .getByRole("button", { name: "返回上一级", exact: true })
      .first()
      .click();
  }
  checks.push(
    "模组、材质包、光影、数据包、整合包的在线列表和下载文件分别显示对应类型文字，成功后完整退场并显示可操作结果。",
  );

  await hold("resources.local");
  await nav("版本管理");
  await page
    .getByRole("button", { name: "查看 1.21.4 本地资源", exact: true })
    .click();
  const local = page.locator(".local-resources .loading-region");
  await verifyLoading(
    local,
    "正在读取模组…",
    "resources.local",
    ".resource-row",
  );
  for (const tab of ["模组", "材质包", "光影", "存档"]) {
    await page
      .getByRole("tablist", { name: "本地资源类型" })
      .getByRole("tab", { name: new RegExp(`^${tab}`) })
      .click();
    await hold("resources.local");
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await verifyLoading(
      local,
      `正在读取${tab}…`,
      "resources.local",
      ".resource-row",
    );
  }
  checks.push(
    "本地模组、材质包、光影、存档首次读取及刷新显示对应分类文字，并播放图标和文字的进出动画。",
  );

  // Reverse an exit halfway through; a cancelled completion must not remove the new loader.
  await hold("resources.local");
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await finish(local);
  await release("resources.local");
  await expect(local.locator(".loading-state")).toHaveAttribute(
    "data-loading",
    "false",
  );
  const before = await local.evaluate((element) => {
    return [".loading-state-icon", ".loading-state-text"].map((selector) => {
      const target = element.querySelector(selector);
      const animation = window.__loadingTest.animations.findLast(
        (a) => a.effect.target === target && a.playState === "paused",
      );
      const timing = animation.effect.getTiming();
      animation.currentTime = timing.delay + timing.duration / 2;
      return Number(getComputedStyle(target).opacity);
    });
  });
  await hold("resources.local");
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(local.locator(".loading-state")).toHaveAttribute(
    "data-loading",
    "true",
  );
  const after = await local.evaluate((element) =>
    [".loading-state-icon", ".loading-state-text"].map((selector) =>
      Number(getComputedStyle(element.querySelector(selector)).opacity),
    ),
  );
  after.forEach((opacity, index) =>
    expect(opacity).toBeCloseTo(before[index], 2),
  );
  await finish(local);
  await release("resources.local");
  await expect(local.locator(".loading-state")).toHaveAttribute(
    "data-loading",
    "false",
  );
  await finish(local);
  await expect(local.locator(".resource-row")).toHaveCount(1);
  checks.push(
    "退场中再次刷新会从当前画面继续进入，旧动画回调不会移除新加载状态。",
  );

  await hold("resources.local");
  await page.evaluate(() => {
    window.__pixelTest.failures["resources.local"] = "读取资源失败，请重试";
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await finish(local);
  await release("resources.local");
  await expect(local.locator(".loading-state")).toHaveAttribute(
    "data-loading",
    "false",
  );
  await sample(local, false);
  await finish(local);
  await expect(local.locator(".loading-state")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "重试", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    delete window.__pixelTest.failures["resources.local"];
  });
  await hold("resources.local");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await verifyLoading(
    local,
    "正在读取存档…",
    "resources.local",
    ".resource-row",
  );
  checks.push("失败时加载提示完整退场，重试仍能恢复正常列表。");

  for (const width of [375, 768, 1120, 1440]) {
    await page.setViewportSize({ width, height: 740 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await hold("resources.local");
      await page.getByRole("button", { name: "刷新", exact: true }).click();
      await finish(local);
      await expect(local.locator(".loading-state-text")).toBeVisible();
      expect(
        await local.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `${evidence}/local-${theme}-${width}.png`,
      });
      await release("resources.local");
      await expect(local.locator(".loading-state")).toHaveAttribute(
        "data-loading",
        "false",
      );
      await finish(local);
      await expect(local.locator(".resource-row")).toHaveCount(1);
    }
  }
  checks.push(
    "375／768／1120／1440 像素窗口的明暗主题均能完整显示加载图文，无加载区域横向溢出。",
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  await hold("resources.local");
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(local.locator(".loading-state")).toHaveAttribute(
    "data-loading",
    "true",
  );
  const rotation = await local
    .locator(".loading-state-spinner")
    .evaluate((element) => {
      const animation = element.getAnimations()[0];
      animation.pause();
      const frames = [0, 225, 450].map((time) => {
        animation.currentTime = time;
        return getComputedStyle(element).transform;
      });
      animation.play();
      return frames;
    });
  expect(new Set(rotation).size).toBe(3);
  await verifyLoading(
    local,
    "正在读取存档…",
    "resources.local",
    ".resource-row",
  );
  checks.push("系统减少动态效果时也完整播放旋转及图文进出动画。");
  expect(errors).toEqual([]);
} finally {
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  await browser.close();
}
console.log(JSON.stringify({ checks, errors }, null, 2));
