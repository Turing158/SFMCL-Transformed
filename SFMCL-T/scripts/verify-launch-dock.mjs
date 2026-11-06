import { runtimePath } from "./lib/paths.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { launchDockFixture } from "./fixtures/launch-dock.mjs";

const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/";
const evidence = runtimePath("evidence/launch-dock-project");
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
await page.addInitScript({
  content: `(${pixelAppFixture.toString()})({ components: true }); (${launchDockFixture.toString()})();`,
});
const dock = page.locator(".launch-dock");
const primary = dock.locator(".launch-primary");
const change = dock.locator(".launch-switch");
const picker = page.getByRole("dialog", { name: "选择游戏版本", exact: true });
const viewport = picker.locator(".launch-version-viewport");
const edgeOpacity = (pseudo) =>
  viewport.evaluate(
    (node, pseudo) => Number(getComputedStyle(node, pseudo).opacity),
    pseudo,
  );
const scrollFrames = (position) =>
  viewport.evaluate(async (node, position) => {
    const list = node.querySelector(".launch-version-list");
    const frames = [];
    list.scrollTop = (list.scrollHeight - list.clientHeight) * position;
    const start = performance.now();
    await new Promise((resolve) => {
      const sample = (time) => {
        frames.push({
          top: Number(getComputedStyle(node, "::before").opacity),
          bottom: Number(getComputedStyle(node, "::after").opacity),
        });
        if (time - start < 360) requestAnimationFrame(sample);
        else resolve();
      };
      requestAnimationFrame(sample);
    });
    return frames;
  }, position);
const nav = (name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const count = (operation) =>
  page.evaluate(
    (op) =>
      window.__pixelTest.requests.filter((request) => request.operation === op)
        .length,
    operation,
  );
const ready = async (scenario = "") => {
  await page.goto(`${url}?dock-test=${scenario}`);
  await expect(dock).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: scenario === "no-player" ? "准备好，开启新的冒险" : "你好，Alex",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .locator("main")
    .evaluate((main) =>
      Promise.allSettled(
        main.getAnimations().map((animation) => animation.finished),
      ),
    );
};
const state = (value) => expect(dock).toHaveAttribute("data-state", value);
const shot = (name) =>
  page.screenshot({ path: `${evidence}/${name}.png`, animations: "disabled" });

try {
  await ready();
  await state("ready");
  await expect(page.locator("main .launch-card")).toHaveCount(0);
  await expect(page.locator(".workspace-footer")).toHaveCount(0);
  await shot("desktop-light");
  await change.click();
  const search = picker.getByRole("searchbox", {
    name: "搜索本地版本",
    exact: true,
  });
  await expect(search).toBeFocused();
  await expect(picker.locator(".launch-picker-footer")).toHaveCount(0);
  expect(await edgeOpacity("::before")).toBe(0);
  expect(await edgeOpacity("::after")).toBe(0);
  await expect(
    picker.getByRole("button", { name: "安装新版本", exact: true }),
  ).toHaveCount(0);
  await shot("desktop-picker");
  await search.fill("fabric");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await expect(picker.getByRole("option")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    dock.getByRole("heading", { name: "1.20.1-Fabric", exact: true }),
  ).toBeVisible();
  await expect(change).toBeFocused();
  expect(await count("versions.select")).toBe(1);
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.activeVersion),
  ).toBe("1.20.1-Fabric");
  checks.push(
    "Version search and keyboard selection persist through versions.select without leaving home; focus returns to the trigger",
  );

  await change.click();
  await search.fill("not-installed");
  await expect(
    picker.getByText("没有找到这个版本", { exact: true }),
  ).toBeVisible();
  await expect(
    picker
      .locator(".launch-picker-empty")
      .getByRole("button", { name: "安装新版本", exact: true }),
  ).toBeVisible();
  await expect(picker.locator(".launch-picker-footer")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(picker).toBeVisible();
  await expect(
    picker.getByRole("button", { name: "安装新版本", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await change.click();
  await page.getByRole("heading", { name: "你好，Alex", exact: true }).click();
  await expect(picker).toBeHidden();
  checks.push(
    "Search empty state, two-stage Escape and outside-click dismissal",
  );

  await page.evaluate(() => {
    window.__pixelTest.failures["versions.select"] = "磁盘暂时不可写";
    window.__pixelTest.delays["versions.select"] = 250;
  });
  await change.click();
  await picker.getByRole("option", { name: /^1\.21\.4/ }).click();
  await expect(picker.getByRole("alert")).toContainText("磁盘暂时不可写");
  await expect(picker).toBeVisible();
  await expect(
    dock.getByRole("heading", { name: "1.20.1-Fabric", exact: true }),
  ).toBeVisible();
  await page.evaluate(
    () => delete window.__pixelTest.failures["versions.select"],
  );
  await picker.getByRole("option", { name: /^1\.21\.4/ }).click();
  await expect(picker).toBeHidden();
  await expect(change).toBeFocused();
  checks.push(
    "Failed version saves keep the old selection and can be retried in the open picker",
  );

  await page.evaluate(() => {
    window.__pixelTest.holdLaunch = true;
    window.__pixelTest.delays.launch = 300;
  });
  await primary.click();
  await expect(primary).toBeDisabled();
  await primary.evaluate((button) => button.click());
  await expect.poll(() => count("launch")).toBe(1);
  await expect(dock.getByRole("status")).toContainText("正在读取启动进度");
  await primary.evaluate((button) => button.click());
  expect(await count("launch")).toBe(1);
  await page.evaluate(() => window.__pixelTest.publishLaunch());
  await state("preparing");
  await expect(change).toHaveText("取消启动");
  await expect(change).toBeEnabled();
  await expect(dock.getByRole("progressbar")).toBeVisible();
  await change.click();
  await state("ready");
  expect(await count("jobs.cancel")).toBe(1);
  checks.push(
    "Start is guarded before the request and between job creation and polling; cancellation targets the returned job",
  );

  await primary.click();
  await expect(change).toBeEnabled();
  await page.evaluate(() => window.__pixelTest.downloadState("paused"));
  await state("paused");
  await expect(primary).toHaveText("继续启动");
  await primary.click();
  await state("preparing");
  expect(await count("launch")).toBe(2);
  await page.evaluate(() => window.__pixelTest.downloadState("failed"));
  await state("download-error");
  await expect(primary).toHaveText("重试下载");
  await expect(dock.getByRole("status")).toContainText("资源服务器连接中断");
  await primary.click();
  await state("preparing");
  expect(await count("launch")).toBe(2);
  expect(await count("downloads.control")).toBe(2);
  checks.push(
    "Paused and failed downloads resume the original workflow without launching a second game",
  );

  await page.evaluate(() => window.__pixelTest.advanceLaunch(4));
  await state("running");
  await expect(primary).toHaveText("结束游戏");
  await expect(change).toHaveText("查看日志");
  await change.click();
  await expect(
    page.getByRole("heading", { name: "下载中心", exact: true }),
  ).toBeVisible();
  await expect(dock).toHaveAttribute("aria-hidden", "true");
  await expect(dock).toHaveAttribute("inert", "");
  await expect(dock.locator(".launch-dock-main")).toHaveCSS("opacity", "0");
  await expect(page.locator(".workspace-footer")).toBeVisible();
  await nav("开始游戏");
  await state("running");
  await primary.click();
  await state("ready");
  checks.push(
    "Running game exposes log and stop actions; navigating away restores the ordinary footer and returning preserves job state",
  );

  await page.evaluate(
    () =>
      (window.__pixelTest.failures.launch = "Microsoft 登录已失效，请刷新登录"),
  );
  await primary.click();
  await state("failed");
  await expect(primary).toHaveText("重试启动");
  // The notification enters from below; measure once it clears the dock.
  await expect
    .poll(async () => {
      const toast = await page.locator(".toast.error").boundingBox();
      const footer = await dock.boundingBox();
      return toast.y + toast.height - footer.y;
    })
    .toBeLessThan(0);
  await page.evaluate(() => delete window.__pixelTest.failures.launch);
  await primary.click();
  await expect(change).toBeEnabled();
  await page.evaluate(() => {
    window.__pixelTest.latestLaunch.status = "failed";
    window.__pixelTest.latestLaunch.error = "未找到兼容的 Java 21";
  });
  await state("failed");
  await expect(dock.getByRole("status")).toContainText("未找到兼容的 Java 21");
  await primary.click();
  await expect(change).toBeEnabled();
  await change.click();
  await state("ready");
  checks.push(
    "Both preflight and background failures expose retry; error notifications remain above the launch actions",
  );

  await ready("jobs-only");
  await expect(
    page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "下载中心", exact: true }),
  ).toHaveCount(0);
  await primary.click();
  await expect(change).toBeEnabled();
  await expect(page.locator(".sidebar-downloads")).toBeVisible();
  await page.evaluate(() => window.__pixelTest.advanceLaunch(4));
  await state("running");
  await change.click();
  await expect(
    page.getByRole("heading", { name: "操作步骤", exact: true }),
  ).toBeVisible();
  checks.push(
    "Launch jobs without downloads show sidebar task progress; the log action still opens task details",
  );

  await ready("empty");
  await state("empty");
  await expect(primary).toBeDisabled();
  await expect(
    dock.getByRole("heading", { name: "选择你的第一个版本", exact: true }),
  ).toBeVisible();
  await change.click();
  await expect(picker.getByRole("option")).toHaveCount(2);
  await expect(
    picker.getByRole("button", { name: "安装新版本", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await nav("版本管理");
  await page
    .locator(".version-management")
    .getByRole("button", { name: "安装新版本", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "安装 Minecraft", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Minecraft", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  checks.push(
    "No selection blocks launch; populated pickers omit installation and version management still opens the Minecraft installation tab",
  );

  await ready("no-dir");
  await change.click();
  await expect(
    picker.getByText("还没有本地游戏", { exact: true }),
  ).toBeVisible();
  await expect(picker.locator(".launch-picker-footer")).toHaveCount(0);
  await picker
    .locator(".launch-picker-empty")
    .getByRole("button", { name: "安装新版本", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "查看 Minecraft 1.21.4 安装配置",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "添加游戏目录", exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "开始安装", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "添加游戏目录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "版本管理", exact: true }),
  ).toBeVisible();
  checks.push(
    "The footer is removed; installation remains centered in the empty placeholder and guides first-time users to add a game directory",
  );

  await ready("no-player");
  await expect(primary).toHaveText("选择角色");
  await primary.click();
  await expect(
    page.getByRole("heading", { name: "角色管理", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("main")
    .getByRole("button", { name: "选择角色 Steve", exact: true })
    .click();
  await nav("开始游戏");
  await state("ready");
  await expect(primary).toBeEnabled();
  checks.push(
    "Missing-player action uses the real role-management flow and unlocks launch after selection",
  );

  await ready("invalid");
  await state("invalid");
  await expect(primary).toHaveText("管理版本");
  await change.click();
  await expect(
    picker.getByRole("option", { name: /^1\.21\.4/ }),
  ).toBeDisabled();
  await search.press("ArrowDown");
  await expect(
    picker.getByRole("option", { name: /^1\.20\.1-Fabric/ }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await state("ready");
  checks.push(
    "Broken versions expose management and cannot be selected or launched; keyboard navigation skips them",
  );

  await ready();
  const layouts = [];
  for (const width of [1440, 1024, 768, 375]) {
    const height = width === 375 ? 812 : 720;
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
        document.querySelector("main").scrollTop = 0;
      }, theme);
      const before = await dock.boundingBox();
      await page
        .locator("main")
        .evaluate((main) => (main.scrollTop = main.scrollHeight));
      const geometry = await page.evaluate(() => {
        const main = document.querySelector("main");
        const footer = document
          .querySelector(".launch-dock")
          .getBoundingClientRect();
        return {
          bottom: footer.bottom,
          top: footer.top,
          mainBottom: main.getBoundingClientRect().bottom,
          statusTop: document
            .querySelector(".launch-status")
            .getBoundingClientRect().top,
          last: Math.max(
            ...Array.from(
              main.querySelectorAll(
                ".page-heading, .notice-card, .notices .helper, .notices .inline-error",
              ),
              (item) => item.getBoundingClientRect().bottom,
            ),
          ),
          overflow: document.body.scrollWidth > innerWidth,
        };
      });
      expect(geometry.bottom).toBe(height);
      expect(geometry.top).toBe(before.y);
      expect(geometry.mainBottom).toBe(geometry.statusTop);
      expect(geometry.last).toBeLessThanOrEqual(geometry.top);
      expect(geometry.overflow).toBe(false);
      await page.locator("main").evaluate((main) => (main.scrollTop = 0));
      if (width === 1440 || width === 375)
        await shot(`${width === 1440 ? "desktop" : "mobile"}-${theme}`);
      await change.click();
      const bounds = await picker.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y).toBeGreaterThanOrEqual(40);
      expect(bounds.y + bounds.height).toBeLessThan(before.y);
      await page.keyboard.press("Escape");
      layouts.push({ width, theme, dockHeight: before.height });
    }
  }
  checks.push(
    "At 375/768/1024/1440px in both themes, the dock stays at the bottom, page endings remain reachable and the popup fits",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".brand-logo").hover();
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await expect.poll(async () => (await dock.boundingBox()).x).toBe(60);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await change.click();
  expect(
    await picker.evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("launch-picker-enter");
  await page.keyboard.press("Escape");
  checks.push(
    "Collapsed sidebar alignment, animations remain enabled with reduced-motion preference (D2), and error-free rendering",
  );
  await ready("many");
  await page.setViewportSize({ width: 375, height: 568 });
  await change.click();
  await expect(viewport).not.toHaveAttribute("data-scroll-top");
  await expect(viewport).toHaveAttribute("data-scroll-bottom", "true");
  await expect.poll(() => edgeOpacity("::before")).toBe(0);
  await expect.poll(() => edgeOpacity("::after")).toBe(1);
  const fadeBounds = await viewport.evaluate((node) => {
    const list = node
      .querySelector(".launch-version-list")
      .getBoundingClientRect();
    const viewport = node.getBoundingClientRect();
    const picker = node.closest(".launch-version-picker");
    const panel = picker.getBoundingClientRect();
    const stroke = parseFloat(
      getComputedStyle(picker).getPropertyValue("--surface-stroke"),
    );
    return {
      uncoveredBottom:
        list.bottom -
        (viewport.bottom -
          parseFloat(getComputedStyle(node, "::after").bottom)),
      frameGap: panel.bottom - list.bottom,
      leftGap: viewport.left - panel.left,
      rightGap: panel.right - viewport.right,
      stroke,
    };
  });
  expect(Math.abs(fadeBounds.uncoveredBottom)).toBeLessThan(0.5);
  expect(fadeBounds.frameGap).toBeGreaterThanOrEqual(fadeBounds.stroke);
  expect(fadeBounds.leftGap).toBeGreaterThanOrEqual(fadeBounds.stroke);
  expect(fadeBounds.rightGap).toBeGreaterThanOrEqual(fadeBounds.stroke);
  const middle = await scrollFrames(0.5);
  expect(middle.some((frame) => frame.top > 0 && frame.top < 1)).toBe(true);
  expect(await edgeOpacity("::before")).toBe(1);
  expect(await edgeOpacity("::after")).toBe(1);
  await shot("picker-scroll-middle");
  const bottom = await scrollFrames(1);
  expect(bottom.some((frame) => frame.bottom > 0 && frame.bottom < 1)).toBe(
    true,
  );
  await expect(viewport).not.toHaveAttribute("data-scroll-bottom");
  expect(await edgeOpacity("::before")).toBe(1);
  expect(await edgeOpacity("::after")).toBe(0);
  await shot("picker-scroll-bottom");
  const top = await scrollFrames(0);
  expect(top.some((frame) => frame.top > 0 && frame.top < 1)).toBe(true);
  expect(top.some((frame) => frame.bottom > 0 && frame.bottom < 1)).toBe(true);
  await expect(viewport).not.toHaveAttribute("data-scroll-top");
  expect(await edgeOpacity("::before")).toBe(0);
  expect(await edgeOpacity("::after")).toBe(1);
  await shot("picker-scroll-top");
  await search.fill("1.21.4");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await expect(viewport).not.toHaveAttribute("data-scroll-top");
  await expect(viewport).not.toHaveAttribute("data-scroll-bottom");
  await expect.poll(() => edgeOpacity("::before")).toBe(0);
  await expect.poll(() => edgeOpacity("::after")).toBe(0);
  await search.fill("");
  await expect(picker.getByRole("option")).toHaveCount(26);
  await expect(viewport).toHaveAttribute("data-scroll-bottom", "true");
  checks.push(
    "List edge fades match favorites: both show mid-list, the reached edge hides with intermediate animation frames, and filtering to a non-scrollable list removes both fades even under reduced-motion preference",
  );
  await search.press("ArrowDown");
  await page.keyboard.press("End");
  await expect(picker.getByRole("option").last()).toBeFocused();
  const lastOption = await picker.getByRole("option").last().boundingBox();
  const menu = await picker.boundingBox();
  expect(lastOption.y + lastOption.height).toBeLessThan(menu.y + menu.height);
  await page.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await expect(primary).toBeEnabled();
  expect(await page.evaluate(() => document.body.scrollWidth)).toBe(375);
  checks.push(
    "A short window with 26 installed versions can scroll and select the last long-named version without moving the launch actions",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/verification.json`,
    JSON.stringify({ checks, layouts, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, layouts, errors }, null, 2));
} catch (error) {
  await shot("failure");
  throw error;
} finally {
  await browser.close();
}
