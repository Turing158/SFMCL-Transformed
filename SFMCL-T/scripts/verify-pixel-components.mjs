import { runtimePath } from "./lib/paths.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";

const evidence = runtimePath("evidence/pixel-components");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(8000);
const errors = [];
const checks = [];
const screenshots = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture, { components: true });
const nav = async (name) => {
  if (name === "下载中心") {
    await page.locator(".sidebar-task").click();
  } else if (name === "角色管理") {
    await page.locator(".sidebar .profile-button").click();
  } else {
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: new RegExp(`^${name}`) })
      .click();
  }
  await page
    .locator(".page")
    .evaluate((element) =>
      Promise.allSettled(
        element.getAnimations().map((animation) => animation.finished),
      ),
    );
};
const shot = async (name, target = page) => {
  const path = `${evidence}/${name}.png`;
  await target.screenshot({ path, animations: "disabled" });
  screenshots.push(path);
};
const press = async (name, button) => {
  await page.mouse.move(0, 0);
  await button.evaluate((element) => element.blur());
  // Measure from rest after navigation, since player buttons also animate on hover.
  await page.waitForTimeout(300);
  const before = await button.boundingBox();
  await button.hover();
  await page.mouse.down();
  const animated = await button.evaluate(
    (el) =>
      !!el.closest(
        ".version-management, .version-settings-page, .local-resources",
      ),
  );
  // Launch controls return to their resting size while held (launch-dock spec).
  const launchControl = await button.evaluate(
    (el) => !!el.closest(".launch-actions"),
  );
  await expect
    .poll(async () => (await button.boundingBox()).y)
    .toBeCloseTo(
      before.y + (launchControl ? 0 : animated ? 1 + before.height * 0.02 : 2),
      1,
    );
  const after = await button.boundingBox();
  expect(after.width).toBeCloseTo(before.width * (animated ? 0.96 : 1), 1);
  expect(after.height).toBeCloseTo(before.height * (animated ? 0.96 : 1), 1);
  await shot(`pressed-${name}`, button);
  await page.mouse.move(0, 0);
  await page.mouse.up();
};
const contrast = async (button) =>
  button.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    const luminance = (color) => {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const channels = [...context.getImageData(0, 0, 1, 1).data]
        .slice(0, 3)
        .map((value) => {
          const channel = value / 255;
          return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
        });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const foreground = luminance(getComputedStyle(element).color);
    const background = luminance(
      getComputedStyle(element.querySelector(".surface-frame"), "::after")
        .backgroundColor,
    );
    return (
      (Math.max(foreground, background) + 0.05) /
      (Math.min(foreground, background) + 0.05)
    );
  });
const chooseTheme = async (theme, accent) => {
  await nav("设置");
  await page.getByRole("tab", { name: "启动器设置", exact: true }).click();
  await page
    .getByRole("button", {
      name: theme === "light" ? "明亮" : "深色",
      exact: true,
    })
    .click();
  await page.getByRole("combobox", { name: "主题配色", exact: true }).click();
  const name = { forest: "森林绿", puce: "原版 · Puce", ebony: "原版 · Ebony" }[
    accent
  ];
  await page.getByRole("option", { name, exact: true }).click();
  const save = page
    .getByRole("button", { name: "保存设置", exact: true })
    .first();
  if (await save.count()) await save.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator("html")).toHaveAttribute("data-accent", accent);
  await expect(save).toHaveCount(0);
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await expect(page.getByRole("heading", { name: "你好，Alex" })).toBeVisible();
  await shot("home-light");
  await press("primary", page.locator(".launch-actions .primary"));
  await press(
    "secondary",
    page.getByRole("button", { name: "切换版本", exact: true }),
  );
  await nav("角色管理");
  await press("danger", page.locator(".players-remove").first());
  await page
    .getByRole("main")
    .getByRole("button", { name: "选择角色 Steve", exact: true })
    .click();
  await expect(
    page
      .getByRole("main")
      .getByRole("button", { name: "选择角色 Steve", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await shot("players-selected");
  await nav("版本管理");
  await press(
    "icon",
    page.getByRole("button", { name: "管理 1.21.4", exact: true }),
  );
  const fabric = page.locator(".version-card").filter({
    has: page.getByRole("heading", { name: "1.20.1-Fabric", exact: true }),
  });
  await fabric
    .getByRole("button", { name: "选择 1.20.1-Fabric", exact: true })
    .click();
  await expect(fabric).toHaveClass(/selected/);
  await expect(
    fabric.getByRole("button", { name: "选择 1.20.1-Fabric", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  checks.push(
    "Buttons retain press feedback; version controls animate scale and travel; player and version selection still update the app",
  );

  await nav("设置");
  let tabs = page.getByRole("tablist", { name: "设置分类" });
  await tabs.getByRole("tab", { name: "启动器设置" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "全局设置" })).toBeFocused();
  await expect(page.getByRole("tabpanel", { name: "全局设置" })).toBeVisible();
  await page.keyboard.press("End");
  await expect(tabs.getByRole("tab", { name: "关于" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "启动器设置" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tabs.getByRole("tab", { name: "关于" })).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("tabpanel", { name: "启动器设置" }),
  ).toBeFocused();
  const save = page
    .getByRole("button", { name: "保存设置", exact: true })
    .first();
  await expect(save).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        window.__pixelTest.requests.filter(
          (r) => r.operation === "settings.save",
        ).length,
    ),
  ).toBe(0);
  await page.evaluate(() => {
    window.__pixelTest.delays["settings.save"] = 400;
  });
  await tabs.getByRole("tab", { name: "全局设置" }).click();
  await page.getByRole("switch", { name: "自动分配内存" }).click();
  const savingButton = await save.elementHandle();
  await save.click();
  await expect(save).toHaveCount(0);
  await savingButton.evaluate((button) => {
    if (!button.disabled)
      throw new Error("Closing save button must be disabled");
    button.click();
  });
  await expect(page.getByText("设置已保存", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.__pixelTest.requests.filter(
          (r) => r.operation === "settings.save",
        ).length,
    ),
  ).toBe(1);
  await page.evaluate(() => {
    window.__pixelTest.delays["settings.save"] = 0;
  });
  checks.push(
    "Tabs support arrows, Home/End, wrapping and a single Tab stop; tab/panel associations work; disabled and busy Save buttons cannot submit twice",
  );

  await nav("下载中心");
  const downloadTabs = page.getByRole("tablist", { name: "下载任务筛选" });
  await expect(downloadTabs.locator(".tab-count")).toHaveText([
    "4",
    "2",
    "1",
    "1",
  ]);
  await page
    .getByRole("button", { name: "暂停 Minecraft 1.21.4", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "继续 Minecraft 1.21.4", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "继续 Minecraft 1.21.4", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "暂停 Minecraft 1.21.4", exact: true }),
  ).toBeVisible();
  await downloadTabs.getByRole("tab", { name: /^进行中/ }).click();
  await expect(page.locator("#downloads-panel .download-card")).toHaveCount(2);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#downloads-panel .download-card")).toHaveCount(1);
  await expect(page.locator("#downloads-panel")).toContainText("世界备份");
  await page.keyboard.press("End");
  await expect(page.locator("#downloads-panel")).toContainText("资源包下载");
  await page.keyboard.press("Home");
  await shot("downloads-light");
  checks.push(
    "Live task badges and filter counts match the downloads; pause/resume and keyboard filtering preserve task behavior",
  );

  await nav("资源中心");
  await page.getByRole("tab", { name: "模组", exact: true }).click();
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page
    .getByRole("button", { name: "查看 Sodium 详情", exact: true })
    .click();
  const resourcePage = page.locator(".resource-subpage");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    resourcePage.getByRole("heading", { name: "渲染优化", exact: true }),
  ).toBeVisible();
  await resourcePage.getByRole("tab", { name: /^可下载版本/ }).click();
  await expect(resourcePage.locator(".project-file")).toHaveCount(1);
  await expect(
    resourcePage.getByRole("button", { name: /暂时无法下载/ }),
  ).toBeDisabled();
  await page.keyboard.press("Home");
  await expect(
    resourcePage.getByRole("tab", { name: "项目介绍", exact: true }),
  ).toBeFocused();
  await shot("resource-subpage");
  await page.keyboard.press("Escape");
  await expect(resourcePage).toBeVisible();
  await page
    .getByRole("navigation", { name: "页面路径" })
    .getByRole("button", { name: "返回上一级", exact: true })
    .click();
  await expect(resourcePage).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "查看 Sodium 详情", exact: true }),
  ).toBeFocused();
  await nav("版本管理");
  await page.getByRole("button", { name: "安装新版本", exact: true }).click();
  const versionType = page.getByRole("tablist", {
    name: "Minecraft 版本类型",
    exact: true,
  });
  await versionType.getByRole("tab", { name: "正式版", exact: true }).focus();
  await page.keyboard.press("End");
  await expect(
    versionType.getByRole("tab", { name: "全部", exact: true }),
  ).toBeFocused();
  await expect(
    versionType.getByRole("tab", { name: "全部", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".minecraft-install .catalog-project")).toHaveCount(
    3,
  );
  await page
    .getByRole("button", {
      name: "查看 Minecraft 1.20.1 安装配置",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("region", { name: "安装 Minecraft 1.20.1", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "页面路径" })
    .getByRole("button", { name: "返回上一级", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "查看 Minecraft 1.20.1 安装配置",
      exact: true,
    }),
  ).toBeFocused();
  await expect(
    page.getByRole("tab", { name: "Minecraft", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  checks.push(
    "Resource and Minecraft child pages restore trigger focus on return; version filtering supports keyboard selection",
  );

  for (const theme of ["light", "dark"]) {
    for (const accent of ["forest", "puce", "ebony"]) {
      await chooseTheme(theme, accent);
      await nav("版本管理");
      await page.mouse.move(0, 0);
      expect(
        await contrast(page.locator(".page-heading .primary")),
        `Primary in ${theme}/${accent}`,
      ).toBeGreaterThanOrEqual(4.5);
      await shot(`versions-${theme}-${accent}`);
    }
  }
  await chooseTheme("dark", "puce");
  await nav("开始游戏");
  await shot("home-dark-puce");
  await nav("下载中心");
  await shot("downloads-dark-puce");
  checks.push(
    "All six light/dark and forest/puce/ebony combinations persist through real settings controls and render the shared frames",
  );

  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of [
      "开始游戏",
      "角色管理",
      "版本管理",
      "资源中心",
      "下载中心",
      "设置",
    ]) {
      await nav(name);
      const bounds = await page.locator(".page").evaluate((element) => ({
        width: element.clientWidth,
        content: element.scrollWidth,
      }));
      expect(bounds.content, `${name} at ${width}px`).toBeLessThanOrEqual(
        bounds.width + 1,
      );
    }
    if (width === 375) {
      tabs = page.getByRole("tablist", { name: "设置分类" });
      const frame = page.locator(".settings-tabs > .surface-frame");
      const frameBefore = await frame.boundingBox();
      await tabs.getByRole("tab", { name: "启动器设置", exact: true }).focus();
      await page.keyboard.press("End");
      const frameAfter = await frame.boundingBox();
      expect(frameAfter.x).toBe(frameBefore.x);
      expect(frameAfter.width).toBe(frameBefore.width);
      const selected = await tabs
        .getByRole("tab", { selected: true })
        .boundingBox();
      const viewport = await tabs.boundingBox();
      expect(selected.x).toBeGreaterThanOrEqual(viewport.x);
      expect(selected.x + selected.width).toBeLessThanOrEqual(
        viewport.x + viewport.width,
      );
      await shot("mobile-settings-tabs");
      await nav("下载中心");
      await page.getByRole("tab", { name: /^全部任务/ }).focus();
      await page.keyboard.press("End");
      await shot("mobile-download-tabs");
      await nav("版本管理");
      await page
        .getByRole("button", { name: "安装新版本", exact: true })
        .click();
      await page
        .getByRole("tablist", { name: "Minecraft 版本类型", exact: true })
        .getByRole("tab", { selected: true })
        .focus();
      await page.keyboard.press("End");
      await shot("mobile-install-tabs");
    }
  }
  checks.push(
    "Six pages fit 375/768/1024/1440px widths; keyboard selection scrolls narrow tab strips while their outer frame stays fixed",
  );
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await nav("版本管理");
  await page.getByRole("button", { name: "安装新版本", exact: true }).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  expect(
    await page
      .getByRole("button", { name: "安装新版本", exact: true })
      .evaluate((button) => button.matches(":focus-visible")),
  ).toBe(true);
  await shot("high-contrast-focus");
  checks.push(
    "Forced colors and reduced motion preserve visible controls and keyboard focus",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, screenshots, errors }, null, 2),
  );
  console.log(
    JSON.stringify(
      { checks, screenshots: screenshots.length, errors },
      null,
      2,
    ),
  );
} catch (error) {
  await shot("failure");
  await writeFile(
    `${evidence}/failure.json`,
    JSON.stringify({ error: String(error), checks, errors }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
