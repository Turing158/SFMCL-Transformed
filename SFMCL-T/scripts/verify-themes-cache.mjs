import { runtimePath } from "./lib/paths.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";
import { installComponentsFixture } from "./fixtures/install-components.mjs";

const evidence = runtimePath("evidence/themes-cache");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 640 } });
page.setDefaultTimeout(8000);
await page.addInitScript(pixelAppFixture, { components: true });
await page.addInitScript(resourceCenterFixture);
await page.addInitScript(installComponentsFixture);
await page.addInitScript(() => {
  // Keep device-code and clipboard/browser actions inside the isolated fixture.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => {} },
  });
  const base = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "plugin:opener|open_url") return;
    if (command === "request" && args.operation === "players.login") {
      return {
        jobId: "theme-login",
        userCode: "TEST-CODE",
        verificationUri: "https://www.microsoft.com/link",
        expiresIn: 900,
      };
    }
    if (
      command === "request" &&
      args.operation === "jobs.cancel" &&
      args.payload.id === "theme-login"
    )
      return true;
    return base(command, args);
  };
});
const errors = [],
  checks = [],
  themes = [];
page.on("pageerror", (error) => errors.push(error.message));
const nav = (name) =>
  name === "角色管理"
    ? page.locator(".sidebar .profile-button").click()
    : page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name, exact: true })
        .click();
const select = async (name, value) => {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
};
const save = async () => {
  const button = page
    .getByRole("button", { name: "保存设置", exact: true })
    .first();
  if (await button.isEnabled()) await button.click();
  await expect(button).toBeDisabled();
};
const shot = async (name) => {
  await page.evaluate(() =>
    Promise.allSettled(
      document
        .getAnimations()
        .filter((a) => a.effect.getTiming().iterations !== Infinity)
        .map((a) => a.finished),
    ),
  );
  await page.screenshot({
    path: `${evidence}/${name}.png`,
    animations: "disabled",
  });
};
const readTheme = () =>
  page.evaluate(() => {
    const names = [
      "bg",
      "panel",
      "ink",
      "muted",
      "line",
      "accent",
      "accent-hover",
      "on-accent",
      "soft",
      "sidebar",
      "sidebar-muted",
      "pixel-well",
      "pixel-thumb",
      "surface-line",
      "surface-well",
      "danger",
      "surface-danger-bg",
      "surface-warning",
      "surface-warning-bg",
      "surface-info",
      "surface-info-bg",
      "surface-success",
      "surface-success-bg",
    ];
    const span = document.createElement("span");
    document.body.append(span);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    const tokens = Object.fromEntries(
      names.map((name) => {
        span.style.color = `var(--${name})`;
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = getComputedStyle(span).color;
        context.fillRect(0, 0, 1, 1);
        return [name, [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)];
      }),
    );
    span.remove();
    return {
      tokens,
      border: decodeURIComponent(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--px-frame-line",
        ),
      ),
      scheme: getComputedStyle(document.documentElement).colorScheme,
    };
  });
const luminance = (rgb) =>
  rgb
    .map((v) => v / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) =>
  (Math.max(luminance(a), luminance(b)) + 0.05) /
  (Math.min(luminance(a), luminance(b)) + 0.05);
const layout = async () => {
  const overflow = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        ".cache-directory-actions, .settings-section, .modal",
      ),
    ]
      .filter((el) => el.getClientRects().length)
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.className),
  );
  expect(overflow).toEqual([]);
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await nav("设置");
  const cache = page.getByRole("textbox", {
    name: "下载缓存文件夹",
    exact: true,
  });
  // Input borders are now drawn in the background; normalize the animated color.
  const cacheBorder = () =>
    cache.evaluate((element) => {
      const context = document.createElement("canvas").getContext("2d");
      context.fillStyle = getComputedStyle(element).getPropertyValue(
        "--pixel-field-border",
      );
      return context.fillStyle;
    });
  await expect(cache).toHaveValue("");
  await expect(cache).toHaveAttribute(
    "placeholder",
    "C:/Pixel-Test/downloads/cache",
  );
  const openCache = page.getByRole("button", {
    name: "打开下载缓存文件夹",
    exact: true,
  });
  await expect(
    page.getByRole("button", { name: "恢复默认", exact: true }),
  ).toHaveCount(0);
  await expect(openCache).toHaveClass(/icon-button/);
  await expect(openCache).toHaveText("");
  await expect(openCache).toHaveAttribute("data-tooltip", "打开下载缓存文件夹");
  await openCache.click();
  expect(
    await page.evaluate(() => window.__pixelTest.openedCacheDirectories),
  ).toEqual(["C:/Pixel-Test/downloads/cache"]);
  await page.evaluate(
    () =>
      (window.__pixelTest.resources.selectedDirectory = "D:/下载缓存/游戏文件"),
  );
  await page.getByRole("button", { name: "选择文件夹", exact: true }).click();
  await expect(cache).toHaveValue("D:/下载缓存/游戏文件");
  await openCache.click();
  expect(
    await page.evaluate(() => window.__pixelTest.openedCacheDirectories.at(-1)),
  ).toBe("D:/下载缓存/游戏文件");
  expect(
    await page.evaluate(
      () => window.__pixelTest.data.settings.downloadCacheDir,
    ),
  ).toBe("");
  await save();
  expect(
    await page.evaluate(
      () => window.__pixelTest.data.settings.downloadCacheDir,
    ),
  ).toBe("D:/下载缓存/游戏文件");
  await nav("开始游戏");
  await nav("设置");
  await expect(cache).toHaveValue("D:/下载缓存/游戏文件");
  await page.evaluate(
    () => (window.__pixelTest.resources.selectedDirectory = null),
  );
  await page.getByRole("button", { name: "选择文件夹", exact: true }).click();
  await expect(cache).toHaveValue("D:/下载缓存/游戏文件");
  await cache.fill("D:/无法写入");
  await page.evaluate(
    () =>
      (window.__pixelTest.failures["settings.save"] = "无法写入下载缓存文件夹"),
  );
  await page
    .getByRole("button", { name: "保存设置", exact: true })
    .first()
    .click();
  await expect(page.getByRole("alert")).toContainText("无法写入下载缓存文件夹");
  expect(
    await page.evaluate(
      () => window.__pixelTest.data.settings.downloadCacheDir,
    ),
  ).toBe("D:/下载缓存/游戏文件");
  await expect(cache).toHaveValue("D:/无法写入");
  await page.locator(".toast.error").click();
  await page.evaluate(
    () => delete window.__pixelTest.failures["settings.save"],
  );
  await cache.fill("");
  await save();
  expect(
    await page.evaluate(
      () => window.__pixelTest.data.settings.downloadCacheDir,
    ),
  ).toBe("");
  await cache.scrollIntoViewIfNeeded();
  await layout();
  await shot("cache-default");
  checks.push(
    "Cache: icon opens default and unsaved custom directories without saving, folder picker, cancel, save/reopen, write error preserves draft and saved settings, blank input restores default",
  );

  for (const [accent, label, borders] of [
    ["forest", "森林绿", ["#8a9f8e", "#526958"]],
    ["puce", "原版 · Puce", ["#a18b93", "#72545f"]],
    ["ebony", "原版 · Ebony", ["#879caa", "#506c80"]],
  ]) {
    for (const [index, mode] of ["light", "dark"].entries()) {
      const key = `${accent}-${mode}`;
      await nav("设置");
      await select("主题配色", label);
      await page.locator(`.theme-option.${mode}`).click();
      await save();
      await expect(page.locator("html")).toHaveAttribute("data-accent", accent);
      await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
      const data = await readTheme();
      expect(data.scheme).toBe(mode);
      expect(data.border).toContain(borders[index]);
      for (const [fg, bg] of [
        ["ink", "panel"],
        ["muted", "bg"],
        ["accent", "soft"],
        ["on-accent", "accent"],
        ["sidebar-muted", "sidebar"],
        ["danger", "surface-danger-bg"],
        ["surface-warning", "surface-warning-bg"],
        ["surface-info", "surface-info-bg"],
        ["surface-success", "surface-success-bg"],
      ]) {
        expect(
          contrast(data.tokens[fg], data.tokens[bg]),
          `${key}: ${fg}/${bg}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      await cache.focus();
      await expect
        .poll(cacheBorder)
        .toBe(
          await page.evaluate(() =>
            getComputedStyle(document.documentElement)
              .getPropertyValue("--accent")
              .trim(),
          ),
        );
      await cache.blur();
      await expect.poll(cacheBorder).toBe(borders[index]);
      await page
        .getByRole("combobox", { name: "侧栏下载任务", exact: true })
        .click();
      const option = page.getByRole("option", { name: "下载时", exact: true });
      await option.hover();
      await expect(page.getByRole("listbox")).toBeVisible();
      await shot(`${key}-select`);
      await page.keyboard.press("Escape");
      await page.getByRole("tab", { name: "全局设置", exact: true }).click();
      await shot(`${key}-game-settings`);
      await nav("开始游戏");
      await shot(`${key}-home`);
      data.launch = await page
        .locator(".launch-primary > .surface-frame")
        .evaluate((el) => getComputedStyle(el, "::after").backgroundColor);
      await nav("角色管理");
      await shot(`${key}-players`);
      await page
        .getByRole("button", { name: "Microsoft 登录", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Microsoft 登录",
          exact: true,
          level: 1,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: "复制设备代码 TEST-CODE",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator(".players-login-error")).toHaveCount(0);
      await shot(`${key}-microsoft-login`);
      await nav("版本管理");
      await page
        .getByRole("button", { name: "游戏设置 1.21.4", exact: true })
        .click();
      await expect(
        page.getByRole("textbox", { name: "窗口标题", exact: true }),
      ).toBeDisabled();
      await shot(`${key}-version-settings`);
      await nav("资源中心");
      await page
        .getByRole("button", {
          name: "查看 Minecraft 1.20.1 安装配置",
          exact: true,
        })
        .click();
      await page
        .getByRole("button", { name: "选择 Forge", exact: true })
        .click();
      await expect(
        page.getByRole("radio", { name: "Forge 47.4.0", exact: true }),
      ).toBeVisible();
      await shot(`${key}-install`);
      await page
        .getByRole("button", { name: "返回上一级", exact: true })
        .click();
      await page.getByRole("tab", { name: "模组", exact: true }).click();
      await expect(
        page.locator(".catalog-projects .catalog-project").first(),
      ).toBeVisible();
      await shot(`${key}-resources`);
      await page.locator(".catalog-projects .catalog-project").first().click();
      await expect(
        page.getByRole("heading", { name: "Sodium", exact: true }),
      ).toBeVisible();
      await shot(`${key}-resource-detail`);
      await page.getByRole("button", { name: /^下载中心：/ }).click();
      await page
        .getByRole("button", {
          name: "查看 安装 Minecraft 1.21.4 日志",
          exact: true,
        })
        .click();
      await expect(page.locator(".log-view")).toContainText("准备安装");
      data.log = await page.locator(".log-view").evaluate((el) => ({
        color: getComputedStyle(el).color,
        background: getComputedStyle(el).backgroundColor,
      }));
      await shot(`${key}-log`);
      await page
        .getByRole("button", { name: "关闭对话框", exact: true })
        .click();
      await nav("设置");
      await page.getByRole("tab", { name: "启动器设置", exact: true }).click();
      await page.setViewportSize({ width: 850, height: 600 });
      await cache.scrollIntoViewIfNeeded();
      await layout();
      await shot(`${key}-cache-850`);
      await page.setViewportSize({ width: 1120, height: 640 });
      themes.push({ key, ...data });
      checks.push(
        `${key}: palette/contrast, input border + focus, dropdown hover, settings + disabled controls, home launch button, players + login, install, resources + detail, log modal, 850px layout`,
      );
    }
  }
  for (const token of [
    "bg",
    "ink",
    "muted",
    "accent",
    "soft",
    "sidebar",
    "pixel-well",
    "surface-line",
    "surface-well",
  ]) {
    expect(
      new Set(themes.map((theme) => JSON.stringify(theme.tokens[token]))).size,
      `${token} must respond to every palette and appearance`,
    ).toBe(6);
  }
  expect(new Set(themes.map((theme) => theme.launch)).size).toBe(6);
  expect(new Set(themes.map((theme) => theme.log.background)).size).toBe(6);
  await page.locator(".theme-option.system").click();
  await save();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  checks.push("System appearance follows OS changes after saving");
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify({ checks, themes, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png`, fullPage: true });
  throw error;
} finally {
  await browser.close();
}
