import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { runtimePath } from "./lib/paths.mjs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { playersFixture } from "./fixtures/players.mjs";
import { waitForAutoSave } from "./lib/auto-save.mjs";

const evidence = runtimePath("players-implementation/preview-settings");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 640 } });
page.setDefaultTimeout(15000);
// Remote backgrounds now load directly in the WebView, so serve them here.
const backgroundPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
await page.route("https://example.test/background.png", (route) =>
  route.fulfill({ body: backgroundPng, contentType: "image/png" }),
);
await page.route("https://example.test/missing.png", (route) =>
  route.fulfill({ status: 404, contentType: "text/plain", body: "missing" }),
);
await page.addInitScript(pixelAppFixture, { persistJavaLists: true });
await page.addInitScript(playersFixture);
const checks = [],
  errors = [],
  measurements = {};
page.on("pageerror", (error) => errors.push(error.message));
const settings = page.locator(".settings-page");
const players = page.locator(".players-page");
const figure = players.locator(".players-figure");
const input = players.locator(".players-3d-input");
const scenery = players.locator(".players-scenery");
const nav = async (name) => {
  if (name === "角色管理")
    await page.locator(".sidebar .profile-button").click();
  else
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true })
      .click();
};
const select = async (name, value) => {
  await settings.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
};
const save = () => waitForAutoSave(page);
const ready3d = async (action) => {
  await expect(figure).toHaveAttribute("data-preview-mode", "3d");
  await expect(figure).toHaveAttribute("data-preview-status", "ready");
  await expect(input).toHaveAttribute("data-action", action);
};
const sample = async () => {
  const before = await page.evaluate(() => window.__player3d.renders);
  const start = Date.now();
  await page.waitForTimeout(1500);
  return {
    frames: (await page.evaluate(() => window.__player3d.renders)) - before,
    seconds: (Date.now() - start) / 1000,
  };
};
const check = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await nav("设置");
  await expect(
    settings.getByRole("combobox", { name: "默认预览方式", exact: true }),
  ).toHaveText("正面");
  await expect(
    settings.getByRole("combobox", { name: "3D 预览帧数", exact: true }),
  ).toHaveText("30");
  await expect(
    settings.getByRole("combobox", { name: "3D 预览背景", exact: true }),
  ).toHaveText("当前场景（默认）");
  await expect(
    settings.getByRole("combobox", { name: "3D 默认动作", exact: true }),
  ).toHaveText("静止");
  await expect(
    settings.getByRole("combobox", { name: "默认预览方式", exact: true }),
  ).toHaveText("正面");
  await nav("角色管理");
  await expect(figure).toHaveAttribute("data-preview-mode", "front");
  expect(await page.evaluate(() => window.__player3d)).toBeUndefined();
  check(
    "Old settings receive the original defaults, and the front preview remains lazy",
  );

  await nav("设置");
  const fpsSelect = settings.getByRole("combobox", {
    name: "3D 预览帧数",
    exact: true,
  });
  await fpsSelect.click();
  await expect(page.getByRole("option")).toHaveText([
    "10",
    "24",
    "30",
    "45",
    "60",
  ]);
  await page.keyboard.press("Escape");
  for (const fps of ["10", "24", "30", "45", "60"]) {
    await select("3D 预览帧数", fps);
    await expect(fpsSelect).toHaveText(fps);
  }
  await waitForAutoSave(page);
  await expect(fpsSelect).toHaveText("60");
  await select("默认预览方式", "3D");
  await select("3D 预览帧数", "10");
  await select("3D 预览背景", "纯色背景");
  await select("3D 默认动作", "行走");
  await save();
  await nav("角色管理");
  await ready3d("walk");
  await expect(scenery).toHaveAttribute("data-background", "none");
  await expect(scenery.locator("img")).toHaveCount(0);
  measurements.fps10 = await sample();
  expect(measurements.fps10.frames).toBeGreaterThan(5);
  expect(
    measurements.fps10.frames / measurements.fps10.seconds,
  ).toBeLessThanOrEqual(11);
  await input.focus();
  await page.keyboard.press("Enter");
  await expect(input).toHaveAttribute("data-action", "run");
  check(
    "Frame rate dropdown offers 10, 24, 30, 45 and 60 with automatic persistence; the 3D mode, frame rate, solid background and default action apply to a retained page, and actions remain interactive",
  );

  await players.locator(".players-facing").click();
  await expect(figure).toHaveAttribute("data-preview-mode", "front");
  await expect(scenery).toHaveAttribute("data-background", "current");
  await expect(scenery.locator("img")).toHaveAttribute(
    "src",
    "/assets/players/grass.svg",
  );
  await players.locator(".players-facing").click();
  await players.locator(".players-facing").click();
  await ready3d("walk");
  check(
    "2D keeps its scenery and re-entering 3D restores the configured action",
  );

  await nav("设置");
  await select("3D 预览帧数", "60");
  await select("3D 默认动作", "挥手");
  await select("3D 预览背景", "当前场景（默认）");
  await save();
  await page.reload();
  await nav("角色管理");
  await ready3d("wave");
  measurements.fps60 = await sample();
  expect(
    measurements.fps60.frames / measurements.fps60.seconds,
  ).toBeLessThanOrEqual(62);
  expect(measurements.fps60.frames).toBeGreaterThan(
    measurements.fps10.frames * 2,
  );
  await expect(scenery.locator("img")).toHaveAttribute(
    "src",
    "/assets/players/grass.svg",
  );
  await players
    .getByRole("button", { name: "切换为方块展台", exact: true })
    .click();
  await expect(scenery.locator("img")).toHaveAttribute(
    "src",
    "/assets/players/gallery.svg",
  );
  await page.screenshot({ path: `${evidence}/current-scene.png` });
  check(
    "Settings survive reload, 60 FPS raises the render rate, and the default background follows the chosen scene",
  );

  await nav("设置");
  await select("3D 预览背景", "本地图片");
  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 80;
    canvas.height = 40;
    const context = canvas.getContext("2d");
    context.fillStyle = "#345678";
    context.fillRect(0, 0, 80, 40);
    window.__pixelTest.images = {
      "C:/Test/background.png": canvas.toDataURL(),
    };
    window.__pixelTest.pick = "C:/Test/background.png";
  });
  await settings
    .getByRole("button", { name: "选择 3D 背景图片", exact: true })
    .click();
  await expect(
    settings.getByRole("textbox", {
      name: "3D 背景图片路径或 URL",
      exact: true,
    }),
  ).toHaveValue("C:/Test/background.png");
  await settings
    .locator(".settings-section")
    .filter({ hasText: "角色管理 · 皮肤预览" })
    .screenshot({ path: `${evidence}/settings.png` });
  await save();
  await nav("角色管理");
  await ready3d("wave");
  await expect(scenery).toHaveAttribute("data-custom-background", "true");
  await expect(scenery.locator("img")).toHaveAttribute("src", /^data:image/);
  await expect(scenery.locator("img")).toHaveCSS("object-fit", "cover");
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await expect(scenery.locator("img")).toHaveCSS("filter", "none");
  await page.screenshot({ path: `${evidence}/custom-background-dark.png` });
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  check(
    "Local backgrounds use the file picker and cover the scene without changing model rendering or darkening the image",
  );

  await nav("设置");
  await select("3D 预览背景", "网络图片");
  await settings
    .getByRole("textbox", { name: "3D 背景图片路径或 URL", exact: true })
    .fill("https://example.test/background.png");
  await save();
  await nav("角色管理");
  await ready3d("wave");
  await expect(scenery).toHaveAttribute("data-custom-background", "true");
  await expect(scenery.locator("img")).toHaveAttribute(
    "src",
    "https://example.test/background.png",
  );
  expect(
    await page.evaluate(
      () =>
        !window.__pixelTest.requests.some(
          (request) =>
            request.operation === "image" &&
            request.payload.path === "https://example.test/background.png",
        ),
    ),
  ).toBe(true);
  await expect(scenery.locator("img")).toHaveCSS("object-fit", "cover");
  await nav("设置");
  await settings
    .getByRole("textbox", { name: "3D 背景图片路径或 URL", exact: true })
    .fill("https://example.test/missing.png");
  await save();
  await nav("角色管理");
  await ready3d("wave");
  await expect(scenery.locator("img")).toHaveAttribute(
    "src",
    "/assets/players/gallery.svg",
  );
  await expect(scenery).not.toHaveAttribute("data-custom-background");
  await players
    .getByRole("button", { name: "切换为林间营地", exact: true })
    .click();
  await expect(scenery.locator("img")).toHaveAttribute(
    "src",
    "/assets/players/grass.svg",
  );
  expect(
    await page.evaluate(
      () =>
        window.__pixelTest.requests.filter(
          (request) =>
            request.operation === "image" &&
            request.payload.path === "https://example.test/missing.png",
        ).length,
    ),
  ).toBe(0);
  await players
    .getByRole("button", { name: "切换为方块展台", exact: true })
    .click();
  await nav("设置");
  await select("默认预览方式", "背面");
  await save();
  await nav("角色管理");
  await expect(figure).toHaveAttribute("data-preview-mode", "back");
  await players.getByRole("button", { name: "离线登录", exact: true }).click();
  await expect(figure).toHaveAttribute("data-preview-mode", "back");
  check(
    "Remote backgrounds load directly without the texture bridge, failures fall back to the current scene without extra requests, and the configured 2D default also applies to offline login",
  );

  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/result.json`,
    JSON.stringify({ checks, measurements, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, measurements, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
