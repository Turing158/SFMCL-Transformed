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
  window.__pixelTest.data.settings.showNotices =
    new URLSearchParams(location.search).get("notices") !== "off";
  window.__homeNotices = {
    fail: false,
    links: [],
    items: [
      {
        title: "欢迎来到 SFMCL-T",
        icon: "/assets/DefaultGameIcon/Minecraft.png",
        content:
          "**准备好下一次冒险。**\n\n公告支持 Markdown、图片和链接。\n\n[查看完整公告](https://example.com/sfmcl-t-notice)\n\n![公告配图](/assets/DefaultGameIcon/Minecraft.png)",
      },
      {
        title: "更新说明：这是用于验证窄窗口自动换行的较长公告标题",
        icon: "",
        content: Array.from(
          { length: 12 },
          (_, i) => `### 更新 ${i + 1}\n\n更轻巧的首页，更专注的游戏时光。`,
        ).join("\n\n"),
      },
      {
        title: "文件公告",
        icon: "",
        content: "",
        error: "读取公告失败：测试文件不存在。",
      },
    ],
  };
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "request" && args.operation === "notices.list") {
      if (window.__homeNotices.fail) throw new Error("测试公告读取失败");
      return structuredClone(window.__homeNotices.items);
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
const toggles = notices.locator(".notice-toggle");
const bodies = notices.locator(".notice-body");
const dock = page.locator(".launch-dock");
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

  await toggles.nth(0).focus();
  await page.keyboard.press("Tab");
  await expect(toggles.nth(1)).toBeFocused();
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
      for (const accent of ["forest", "puce", "ebony"]) {
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
    "All six themes and three viewport widths keep the panels within the page; per-notice read errors remain available inside their panel.",
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
  await ready("?notices=off");
  await expect(notices).toHaveCount(0);
  await expect(page.locator("main.page > *")).toHaveCount(1);
  await expect(dock).toBeVisible();
  checks.push(
    "Refresh errors retain existing notices, retry recovers to the empty state, and turning notices off leaves only the title above the launch dock.",
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
