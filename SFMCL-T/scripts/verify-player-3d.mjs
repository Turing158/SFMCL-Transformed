import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { runtimePath } from "./lib/paths.mjs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { playersFixture } from "./fixtures/players.mjs";

const evidence = runtimePath("players-implementation/3d");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 640 } });
page.setDefaultTimeout(15000);
const checks = [],
  errors = [],
  measurements = {};
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(playersFixture);
await page.addInitScript(() => {
  const animate = Element.prototype.animate;
  window.__3dAnimations = [];
  Element.prototype.animate = function (...args) {
    const animation = animate.apply(this, args);
    if (
      window.__hold3d &&
      this.matches(".players-figure canvas, .players-name-transition > *")
    ) {
      animation.pause();
      window.__3dAnimations.push(animation);
    }
    return animation;
  };
});
const ui = page.locator(".players-page");
const figure = ui.locator(".players-figure");
const input = ui.locator(".players-3d-input");
const surface = ui.locator(".players-3d-surface");
const title = ui.locator(".players-identity h2");
const cycle = () => ui.locator(".players-facing").click();
const stats = () => page.evaluate(() => ({ ...window.__player3d }));
const pixels = () => surface.evaluate((canvas) => canvas.toDataURL());
const playerPoint = (targetPage = page) =>
  targetPage.locator(".players-3d-surface").evaluate((canvas) => {
    const box = canvas.getBoundingClientRect();
    // Fixed ordinary click, including empty space beside moving limbs. Do not
    // search rendered pixels, which hid the excessively narrow hit area.
    return { x: box.left + box.width * 0.17, y: box.top + box.height * 0.45 };
  });
const clickPlayer = async () => {
  const point = await playerPoint();
  await page.mouse.click(point.x, point.y);
};
const ready = async () => {
  await expect(figure).toHaveAttribute("data-preview-status", "ready");
  await expect(ui.locator(".players-preview-loading")).toHaveCount(0);
  await expect(input).toHaveCount(1);
  await expect.poll(async () => (await stats()).active).toBe(1);
};
const check = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
const arm = () =>
  page.evaluate(() => {
    window.__hold3d = true;
    window.__3dAnimations = [];
  });
const finish = async () => {
  await page.evaluate(() => {
    window.__hold3d = false;
    window.__3dAnimations.forEach((animation) => {
      if (animation.playState !== "idle") animation.finish();
    });
  });
  await expect(
    ui.locator(
      ".players-skin-outgoing, .players-preview-hold, .players-name-outgoing",
    ),
  ).toHaveCount(0);
};
const setImage = (color, size = 64, legacy = false, delay = 0) =>
  page.evaluate(
    ({ color, size, legacy, delay }) => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = legacy ? size / 2 : size;
      const context = canvas.getContext("2d");
      context.fillStyle = color;
      context.fillRect(0, 0, size, canvas.height);
      // Keep a transparent area so the library preserves the colored second layer.
      context.clearRect(0, 0, 1, 1);
      window.__pixelTest.image = canvas.toDataURL();
      window.__pixelTest.delays.image = delay;
    },
    { color, size, legacy, delay },
  );

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-startup",
    /loading|revealing/,
  );
  await page.locator(".sidebar .profile-button").click();
  await expect(title).toHaveText("Steve");
  expect(await page.evaluate(() => window.__player3d)).toBeUndefined();
  expect(
    await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .some((entry) => /SkinPreview3D|skinview3d/.test(entry.name)),
    ),
  ).toBe(false);
  check("Default front preview does not load or initialize 3D");
  await cycle();
  await expect(ui.locator(".players-facing")).toHaveText("背面");
  await expect(ui.locator(".players-facing")).toHaveAttribute(
    "data-tooltip",
    "当前背面，切换为3D",
  );
  await expect(ui.locator(".skin-body")).toHaveAttribute(
    "aria-label",
    "Steve 的背面皮肤预览",
  );
  await page.waitForTimeout(400);
  await expect(ui.locator(".players-skin-outgoing")).toHaveCount(0);
  let releaseModule;
  const moduleGate = new Promise((resolve) => {
    releaseModule = resolve;
  });
  const modulePattern = "**/src/SkinPreview3D.tsx*";
  await page.route(modulePattern, async (route) => {
    await moduleGate;
    await route.continue();
  });
  await arm();
  const started = Date.now();
  await cycle();
  await expect(figure).toHaveAttribute("data-preview-status", "loading");
  await expect(ui.locator(".players-preview-status")).toHaveCount(0);
  await expect(ui.locator(".players-preview-hold")).toBeVisible();
  const loading = ui.locator(".players-preview-loading");
  await expect(loading).toBeVisible();
  await expect(loading).toHaveAccessibleName("正在加载 3D 模型");
  expect(await loading.textContent()).toBe("");
  await expect(figure).toHaveAttribute("aria-busy", "true");
  const spinner = loading.locator(".spin");
  const startRotation = await spinner.evaluate(
    (el) => getComputedStyle(el).transform,
  );
  await page.waitForTimeout(120);
  expect(
    await spinner.evaluate((el) => getComputedStyle(el).transform),
  ).not.toBe(startRotation);
  await page.mouse.move(800, 400);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => (document.documentElement.dataset.theme = value),
      theme,
    );
    await ui
      .locator(".player-preview")
      .screenshot({ path: `${evidence}/model-loading-${theme}.png` });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  releaseModule();
  await ready();
  await page.unroute(modulePattern);
  check(
    "Delayed 3D loading shows an animated theme-aware spinner without text over the old frame, then removes it on readiness",
  );
  measurements.firstEntryMs = Date.now() - started;
  await expect
    .poll(() => page.evaluate(() => window.__3dAnimations.length))
    .toBe(2);
  await page.evaluate(() =>
    window.__3dAnimations.forEach((animation) => (animation.currentTime = 180)),
  );
  await page.screenshot({ path: `${evidence}/mode-middle.png` });
  await finish();
  const transparent = await surface.evaluate((c) => [
    ...c.getContext("2d").getImageData(0, 0, 1, 1).data,
  ]);
  expect(transparent[3]).toBe(0);
  check(
    "Three-state cycle waits for a transparent 3D first frame and preserves the mode transition",
  );
  await page.waitForTimeout(100);
  const idle = await stats();
  await page.waitForTimeout(10000);
  expect((await stats()).renders).toBe(idle.renders);
  expect((await stats()).pending).toBe(0);
  measurements.idle10s = {
    before: idle.renders,
    after: (await stats()).renders,
  };
  check("10 seconds idle add zero renderer calls and leave no scheduled task");
  const initial = await pixels();
  await expect(ui.locator(".players-3d-action")).toHaveCount(0);
  await expect(ui.locator(".players-stage [title]")).toHaveCount(0);
  const stageBox = await ui.locator(".players-stage").boundingBox();
  expect(await input.boundingBox()).toEqual(stageBox);
  await input.click({ position: { x: 8, y: stageBox.height * 0.6 } });
  await page.waitForTimeout(550);
  await expect(input).toHaveAttribute("data-action", "still");
  await expect(input).toHaveCSS("cursor", "grab");
  await page.mouse.move(stageBox.x + 8, stageBox.y + stageBox.height * 0.6);
  await page.mouse.down();
  await expect(input).toHaveCSS("cursor", "grabbing");
  await page.mouse.move(
    stageBox.x - 24,
    stageBox.y + stageBox.height * 0.6 + 20,
  );
  await page.mouse.up();
  await expect.poll(pixels).not.toBe(initial);
  await page.waitForTimeout(550);
  await expect(input).toHaveAttribute("data-action", "still");
  await input.focus();
  await page.keyboard.press("Home");
  await expect.poll(pixels).toBe(initial);
  const playerHover = await playerPoint();
  await page.mouse.move(playerHover.x, playerHover.y);
  await expect(input).toHaveCSS("cursor", "pointer");
  check(
    "Native tooltip and caption are removed; the stable player preview activates actions, while the rest of the scene supports captured drags with distinct cursors",
  );
  await input.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(pixels).not.toBe(initial);
  await page.keyboard.press("Home");
  await expect.poll(pixels).toBe(initial);
  const box = await input.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const beforeDrag = await stats();
  const dragStart = Date.now();
  await page.mouse.down();
  for (let i = 0; i < 200; i++) {
    await page.mouse.move(
      box.x + box.width / 2 + Math.sin(i / 12) * 35,
      box.y + box.height / 2,
    );
    await page.waitForTimeout(50);
  }
  await page.mouse.up();
  await page.waitForTimeout(80);
  const afterDrag = await stats();
  const elapsed = (Date.now() - dragStart) / 1000;
  measurements.drag = {
    seconds: elapsed,
    renders: afterDrag.renders - beforeDrag.renders,
    fps: (afterDrag.renders - beforeDrag.renders) / elapsed,
  };
  expect(measurements.drag.fps).toBeLessThan(31.5);
  expect(measurements.drag.renders).toBeGreaterThan(5);
  await page.waitForTimeout(150);
  expect((await stats()).renders).toBe(afterDrag.renders);
  await input.dblclick();
  await expect.poll(pixels).toBe(initial);
  await input.hover();
  await page.mouse.wheel(0, 150);
  await expect.poll(pixels).not.toBe(initial);
  await input.focus();
  await page.keyboard.press("Home");
  await expect.poll(pixels).toBe(initial);
  check(
    "Drag is capped at approximately 30 FPS; wheel, keyboard and double-click work and stop rendering afterward",
  );

  // Real pointer clicks must change the animation, not just its status label.
  await expect(input).toHaveAttribute("role", "button");
  await expect(input).toHaveAccessibleName("Steve 的 3D 皮肤预览");
  await expect(input).toHaveAttribute("data-action", "still");
  for (const [action, label] of [
    ["walk", "行走"],
    ["run", "奔跑"],
    ["fly", "飞行"],
    ["wave", "挥手"],
    ["still", "静止"],
  ]) {
    await clickPlayer();
    await expect(input).toHaveAttribute("data-action", action, {
      timeout: 200,
    });
    await expect(input).toHaveAttribute(
      "aria-description",
      new RegExp(`当前${label}。`),
    );
    await page.waitForTimeout(100);
    const frame = await pixels();
    if (action === "still") {
      await page.waitForTimeout(150);
      expect(await pixels()).toBe(initial);
      expect((await stats()).pending).toBe(0);
    } else {
      await page.waitForTimeout(180);
      expect(await pixels()).not.toBe(frame);
      await page.screenshot({ path: `${evidence}/action-${action}.png` });
    }
  }
  check(
    "Click cycles through walking, running, flying, waving and still; each action paints moving frames and still resets the pose",
  );

  // Even a slower double-click or a drag must keep the action.
  await input.dblclick({ delay: 350 });
  await page.waitForTimeout(550);
  await expect(input).toHaveAttribute("data-action", "still");
  expect(await pixels()).toBe(initial);
  await input.focus();
  await page.keyboard.press("Enter");
  await expect(input).toHaveAttribute("data-action", "walk");
  await page.keyboard.press("Space");
  await expect(input).toHaveAttribute("data-action", "run");
  await page.evaluate(() => {
    const canvas = document.querySelector(".players-3d-input");
    canvas.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", repeat: true }),
    );
  });
  await expect(input).toHaveAttribute("data-action", "run");
  await page.keyboard.press("Enter");
  await expect(input).toHaveAttribute("data-action", "fly");
  await page.keyboard.press("Enter");
  await expect(input).toHaveAttribute("data-action", "wave");
  await page.keyboard.press("Enter");
  await expect(input).toHaveAttribute("data-action", "still");
  await expect.poll(pixels).toBe(initial);
  await input.evaluate((canvas) => canvas.click());
  await expect(input).toHaveAttribute("data-action", "walk");
  const actionBox = await input.boundingBox();
  await page.mouse.move(
    actionBox.x + actionBox.width / 2,
    actionBox.y + actionBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    actionBox.x + actionBox.width / 2 + 30,
    actionBox.y + actionBox.height / 2,
  );
  await page.mouse.up();
  await page.waitForTimeout(550);
  await expect(input).toHaveAttribute("data-action", "walk");
  await input.dblclick();
  await page.waitForTimeout(550);
  await expect(input).toHaveAttribute("data-action", "walk");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Enter");
  await expect(input).toHaveAttribute("data-action", "still");
  await expect.poll(pixels).toBe(initial);
  check(
    "Double-click and drag preserve the chosen action; Enter, Space and accessible activation cycle actions without key-repeat jumps",
  );

  await page.keyboard.press("Enter");
  await expect(input).toHaveAttribute("data-action", "walk");
  const playingStart = await stats();
  const playingTime = Date.now();
  await page.waitForTimeout(1200);
  const playingEnd = await stats();
  measurements.animation = {
    seconds: (Date.now() - playingTime) / 1000,
    renders: playingEnd.renders - playingStart.renders,
  };
  measurements.animation.fps =
    measurements.animation.renders / measurements.animation.seconds;
  expect(measurements.animation.fps).toBeLessThan(31.5);
  expect(measurements.animation.renders).toBeGreaterThan(15);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hiddenAnimation = await stats();
  await page.waitForTimeout(200);
  expect((await stats()).renders).toBe(hiddenAnimation.renders);
  expect((await stats()).pending).toBe(0);
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(async () => (await stats()).renders)
    .toBeGreaterThan(hiddenAnimation.renders);
  for (let i = 0; i < 4; i++) await page.keyboard.press("Enter");
  await expect(input).toHaveAttribute("data-action", "still");
  await expect.poll(pixels).toBe(initial);
  await page.waitForTimeout(100);
  const stopped = await stats();
  await page.waitForTimeout(200);
  expect((await stats()).renders).toBe(stopped.renders);
  expect((await stats()).pending).toBe(0);
  check(
    "Animations use the capped 30 FPS renderer, pause while hidden, resume when visible and leave no work after stopping",
  );

  await page.keyboard.press("Enter");
  await expect(input).toHaveAttribute("data-action", "walk");
  const animatedInstance = (await stats()).created;
  await ui.getByRole("button", { name: "选择角色 Alex", exact: true }).click();
  await expect(title).toHaveText("Alex");
  await expect(input).toHaveAttribute("data-action", "walk");
  await expect(input).toHaveAccessibleName("Alex 的 3D 皮肤预览");
  await page.waitForTimeout(450);
  const switchedFrame = await pixels();
  await page.waitForTimeout(180);
  expect(await pixels()).not.toBe(switchedFrame);
  expect((await stats()).created).toBe(animatedInstance);
  await ui.getByRole("button", { name: "选择角色 Steve", exact: true }).click();
  await expect(title).toHaveText("Steve");
  await expect(input).toHaveAttribute("data-action", "walk");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "开始游戏", exact: true })
    .click();
  await expect.poll(async () => (await stats()).active).toBe(0);
  await expect(input).toHaveCount(0);
  expect((await stats()).pending).toBe(0);
  const leftPage = (await stats()).renders;
  await page.waitForTimeout(200);
  expect((await stats()).renders).toBe(leftPage);
  await page.locator(".sidebar .profile-button").click();
  await ready();
  await expect(input).toHaveAttribute("data-action", "still");
  await expect.poll(pixels).toBe(initial);
  await input.focus();
  await page.keyboard.press("Enter");
  await expect(input).toHaveAttribute("data-action", "walk");
  await cycle();
  await expect(figure).toHaveAttribute("data-preview-mode", "front");
  await expect.poll(async () => (await stats()).active).toBe(0);
  await expect(input).toHaveCount(0);
  expect((await stats()).pending).toBe(0);
  const leftMode = (await stats()).renders;
  await page.waitForTimeout(200);
  expect((await stats()).renders).toBe(leftMode);
  await cycle();
  await cycle();
  await ready();
  await expect(input).toHaveAttribute("data-action", "still");
  await expect.poll(pixels).toBe(initial);
  await page.waitForTimeout(400);
  check(
    "Character switches keep the selected animation in one viewer; leaving the page or 3D stops all drawing and re-entry starts still",
  );

  // Atlas landmarks verify visible head/sole faces through the actual renderer.
  await page.evaluate(() => {
    const atlas = document.createElement("canvas");
    atlas.width = atlas.height = 64;
    const ctx = atlas.getContext("2d");
    ctx.fillStyle = "#2879c9";
    for (const rect of [
      [0, 0, 32, 16],
      [0, 16, 56, 16],
      [16, 48, 32, 16],
    ])
      ctx.fillRect(...rect);
    ctx.fillStyle = "#ee2211";
    ctx.fillRect(8, 0, 8, 8);
    ctx.fillStyle = "#eeee11";
    ctx.fillRect(8, 16, 4, 4);
    ctx.fillRect(24, 48, 4, 4);
    ctx.fillStyle = "rgba(17,238,238,0.5)";
    ctx.fillRect(40, 8, 8, 8);
    window.__pixelTest.image = atlas.toDataURL();
  });
  await ui.getByRole("button", { name: "更换皮肤", exact: true }).click();
  await expect(ui.locator(".players-skin-outgoing")).toHaveCount(1);
  await expect(ui.locator(".players-skin-outgoing")).toHaveCount(0);
  const inspectSkin = () =>
    surface.evaluate((canvas) => {
      const data = canvas
        .getContext("2d")
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let translucent = 0,
        solid = 0,
        headTop = 0,
        soles = 0,
        originalBlue = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b, a] = data.slice(i, i + 4);
        if (a > 0 && a < 255) translucent++;
        if (a === 255) solid++;
        if (a && r > g * 2 && r > b * 2) headTop++;
        if (a && r > b * 2 && g > b * 2) soles++;
        if (a === 255 && r < 50 && g > 90 && g < 130 && b > 170 && b < 210)
          originalBlue++;
      }
      return { translucent, solid, headTop, soles, originalBlue };
    });
  expect((await inspectSkin()).translucent).toBe(0);
  expect((await inspectSkin()).solid).toBeGreaterThan(100);
  expect((await inspectSkin()).originalBlue).toBeGreaterThan(100);
  await input.focus();
  for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowUp");
  await expect
    .poll(async () => (await inspectSkin()).headTop)
    .toBeGreaterThan(20);
  await page.screenshot({ path: `${evidence}/opaque-head-top.png` });
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await inspectSkin()).soles).toBeGreaterThan(5);
  expect((await inspectSkin()).translucent).toBe(0);
  await page.screenshot({ path: `${evidence}/opaque-soles.png` });
  await page.keyboard.press("Home");
  await ui.getByRole("button", { name: "重置皮肤", exact: true }).click();
  await expect.poll(pixels).toBe(initial);
  check(
    "Opaque skin preserves original dark colors; 30-degree pitch exposes head-top and sole textures",
  );

  for (const [size, legacy] of [
    [64, false],
    [128, false],
    [64, true],
  ]) {
    await setImage(size === 128 ? "#cc3322" : "#3355cc", size, legacy, 500);
    const before = await pixels();
    await arm();
    await ui.getByRole("button", { name: "更换皮肤", exact: true }).click();
    await page.waitForTimeout(100);
    expect(await pixels()).toBe(before);
    await expect
      .poll(() => page.evaluate(() => window.__3dAnimations.length))
      .toBe(4);
    const frozen = await ui
      .locator(".players-skin-outgoing")
      .evaluate((c) => c.toDataURL());
    expect(frozen).toBe(before);
    await page.evaluate(() =>
      window.__3dAnimations.forEach(
        (animation) => (animation.currentTime = 150),
      ),
    );
    await page.screenshot({
      path: `${evidence}/skin-${size}-${legacy}-middle.png`,
    });
    await finish();
  }
  check(
    "Modern, high-resolution and legacy skins reuse one instance and preserve delayed skin/name transitions",
  );
  await ui.locator(".players-model").click();
  await ready();
  await ui.getByRole("button", { name: "重置皮肤", exact: true }).click();
  await ready();
  await page.waitForTimeout(400);
  await arm();
  await ui.getByRole("button", { name: "选择角色 Alex", exact: true }).click();
  await expect(title).toHaveText("Alex");
  await expect
    .poll(() => page.evaluate(() => window.__3dAnimations.length))
    .toBe(4);
  await finish();
  await arm();
  await ui.getByRole("button", { name: "刷新 Alex 登录", exact: true }).click();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__3dAnimations.length)).toBe(0);
  await finish();
  check(
    "Model/reset/character changes work; unchanged refresh does not replay an appearance animation",
  );

  const refreshAlex = () =>
    ui.getByRole("button", { name: "刷新 Alex 登录", exact: true }).click();
  const capePixels = () =>
    surface.evaluate((canvas) => {
      const data = canvas
        .getContext("2d")
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let pink = 0,
        green = 0,
        translucent = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 0 && data[i + 3] < 255) translucent++;
        if (data[i + 3] !== 255) continue;
        if (data[i] > 100 && data[i + 1] < 60 && data[i + 2] > 100) pink++;
        if (data[i] < 60 && data[i + 1] > 100 && data[i + 2] < 60) green++;
      }
      return { pink, green, translucent };
    });
  const capeA = "https://textures.minecraft.net/texture/ca";
  const capeB = "https://textures.minecraft.net/texture/cb";
  await input.focus();
  await page.keyboard.press("Home");
  for (let i = 0; i < 26; i++) await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(100);
  const withoutCape = await pixels();
  await cycle();
  await page.evaluate(
    ({ capeA, capeB }) => {
      const atlas = (color) => {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 32;
        const context = canvas.getContext("2d");
        context.fillStyle = color;
        context.fillRect(0, 0, 64, 32);
        return canvas.toDataURL();
      };
      const fixture = window.__pixelTest;
      fixture.images = {
        [capeA]: atlas("rgba(230, 20, 230, 0.6)"),
        [capeB]: atlas("#10e010"),
      };
      fixture.data.players.find((player) => player.uuid === "alex").cape =
        capeA;
    },
    { capeA, capeB },
  );
  await refreshAlex();
  await page.waitForTimeout(400);
  expect(
    await page.evaluate(
      (path) =>
        window.__pixelTest.requests.some(
          (request) =>
            request.operation === "image" && request.payload.path === path,
        ),
      capeA,
    ),
  ).toBe(false);
  await cycle();
  await cycle();
  await ready();
  await expect.poll(async () => (await capePixels()).pink).toBeGreaterThan(100);
  await page.waitForTimeout(400);
  expect((await capePixels()).translucent).toBe(0);
  await page.screenshot({ path: `${evidence}/equipped-cape.png` });
  expect((await stats()).created - (await stats()).disposed).toBe(1);
  const capeInstance = (await stats()).created;
  const capeFrame = await pixels();
  const idleCape = await stats();
  await page.waitForTimeout(300);
  expect((await stats()).renders).toBe(idleCape.renders);
  await arm();
  await refreshAlex();
  await page.waitForTimeout(500);
  expect(await pixels()).toBe(capeFrame);
  expect(await page.evaluate(() => window.__3dAnimations.length)).toBe(0);
  await finish();
  check(
    "Equipped cape loads only in 3D, renders opaque, and stays idle without replaying unchanged refreshes",
  );

  await page.evaluate(
    ({ capeA, capeB }) => {
      // Refreshing the same texture address must notice changed cape pixels.
      window.__pixelTest.images[capeA] = window.__pixelTest.images[capeB];
    },
    { capeA, capeB },
  );
  await arm();
  await refreshAlex();
  await expect
    .poll(async () => (await capePixels()).green)
    .toBeGreaterThan(100);
  await expect
    .poll(() => page.evaluate(() => window.__3dAnimations.length))
    .toBe(4);
  await finish();
  await page.evaluate(() => {
    window.__pixelTest.data.players.find(
      (player) => player.uuid === "alex",
    ).cape = "";
  });
  await refreshAlex();
  await expect.poll(pixels).toBe(withoutCape);
  await page.waitForTimeout(400);
  check(
    "Same-address cape changes animate; unequipping removes the cape without rebuilding the viewer",
  );

  await page.evaluate((capeB) => {
    const fixture = window.__pixelTest;
    fixture.data.players.find((player) => player.uuid === "alex").cape = capeB;
    fixture.imageFailures = { [capeB]: "cape download unavailable" };
  }, capeB);
  await refreshAlex();
  await expect
    .poll(() =>
      page.evaluate(
        (path) =>
          window.__pixelTest.requests.filter(
            (request) =>
              request.operation === "image" && request.payload.path === path,
          ).length,
        capeB,
      ),
    )
    .toBeGreaterThan(0);
  await page.waitForTimeout(300);
  await ready();
  expect(await pixels()).toBe(withoutCape);
  await page.evaluate((capeB) => {
    delete window.__pixelTest.imageFailures;
    window.__pixelTest.images[capeB] = "data:image/png;base64,broken";
  }, capeB);
  await refreshAlex();
  await page.waitForTimeout(300);
  await ready();
  expect(await pixels()).toBe(withoutCape);
  await page.evaluate((capeB) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    window.__pixelTest.images[capeB] = canvas.toDataURL();
  }, capeB);
  await refreshAlex();
  await page.waitForTimeout(300);
  await ready();
  expect(await pixels()).toBe(withoutCape);
  check(
    "Unavailable, damaged, and invalid-size capes preserve the 3D skin preview",
  );

  await page.evaluate((capeB) => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 32;
    const context = canvas.getContext("2d");
    context.fillStyle = "#10e010";
    context.fillRect(0, 0, 64, 32);
    const fixture = window.__pixelTest;
    fixture.images[capeB] = canvas.toDataURL();
    fixture.imageDelays = { [capeB]: 900 };
  }, capeB);
  const beforeSlowCape = await page.evaluate(
    (path) =>
      window.__pixelTest.requests.filter(
        (request) =>
          request.operation === "image" && request.payload.path === path,
      ).length,
    capeB,
  );
  await refreshAlex();
  await expect
    .poll(() =>
      page.evaluate(
        (path) =>
          window.__pixelTest.requests.filter(
            (request) =>
              request.operation === "image" && request.payload.path === path,
          ).length,
        capeB,
      ),
    )
    .toBeGreaterThan(beforeSlowCape);
  await ui
    .getByRole("button", { name: "选择角色 Builder_07", exact: true })
    .click();
  await expect(title).toHaveText("Builder_07");
  const otherCharacter = await pixels();
  await page.waitForTimeout(1000);
  expect(await pixels()).toBe(otherCharacter);
  expect((await capePixels()).green).toBe(0);
  expect((await stats()).created).toBe(capeInstance);
  await page.evaluate(() => {
    delete window.__pixelTest.imageDelays;
    window.__pixelTest.data.players.find(
      (player) => player.uuid === "alex",
    ).cape = "";
  });
  await refreshAlex();
  await ui.getByRole("button", { name: "选择角色 Alex", exact: true }).click();
  await expect(title).toHaveText("Alex");
  await expect.poll(pixels).toBe(withoutCape);
  await input.focus();
  await page.keyboard.press("Home");
  await page.waitForTimeout(400);
  check(
    "A delayed cape cannot appear on a newly selected account; switches reuse one viewer",
  );
  await page.evaluate((capeB) => {
    window.__pixelTest.data.players.find(
      (player) => player.uuid === "alex",
    ).cape = capeB;
  }, capeB);
  await refreshAlex();
  // Leave the cape equipped for the existing layout, lifecycle, and recovery checks.
  await input.focus();
  for (let i = 0; i < 26; i++) await page.keyboard.press("ArrowRight");
  await expect
    .poll(async () => (await capePixels()).green)
    .toBeGreaterThan(100);
  await page.keyboard.press("Home");
  await page.waitForTimeout(400);

  for (const view of ["grove", "gallery"]) {
    if ((await ui.getAttribute("data-view")) !== view)
      await ui.locator(".players-view-switch").click();
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-player-view-transition",
    );
    expect(await input.boundingBox()).toEqual(
      await ui.locator(".players-stage").boundingBox(),
    );
    await input.click({ position: { x: 8, y: 70 } });
    await page.waitForTimeout(550);
    await expect(input).toHaveAttribute("data-action", "still");
    await clickPlayer();
    await expect(input).toHaveAttribute("data-action", "walk");
    await input.focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press("Enter");
    await expect(input).toHaveAttribute("data-action", "still");
    for (const accent of ["forest", "puce", "ebony"])
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          ({ accent, theme }) => {
            document.documentElement.dataset.accent = accent;
            document.documentElement.dataset.theme = theme;
          },
          { accent, theme },
        );
        await page.screenshot({
          path: `${evidence}/${view}-${accent}-${theme}.png`,
        });
      }
  }
  for (const [width, height] of [
    [850, 600],
    [375, 600],
    [1440, 900],
    [1120, 640],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    const dimensions = await surface.evaluate((canvas) => ({
      w: canvas.width,
      h: canvas.height,
    }));
    expect(dimensions.w).toBeLessThanOrEqual(512);
    expect(dimensions.h).toBeLessThanOrEqual(512);
    await expect(ui.locator(".players-facing")).toBeVisible();
    await expect(ui.locator(".players-model")).toBeVisible();
    expect(await input.boundingBox()).toEqual(
      await ui.locator(".players-stage").boundingBox(),
    );
    await expect(ui.locator(".players-3d-action")).toHaveCount(0);
    await clickPlayer();
    await expect(input).toHaveAttribute("data-action", "walk");
    await input.focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press("Enter");
    await expect(input).toHaveAttribute("data-action", "still");
  }
  check(
    "Both scenery layouts, six theme colors and narrow/short windows preserve canvas budget and buttons",
  );

  await input.focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(80);
  const saved = await pixels();
  const nav = page.getByRole("navigation", { name: "主导航" });
  for (let i = 0; i < 20; i++) {
    await nav.getByRole("button", { name: "开始游戏", exact: true }).click();
    await expect.poll(async () => (await stats()).active).toBe(0);
    expect((await stats()).pending).toBe(0);
    await page.locator(".sidebar .profile-button").click();
    await ready();
  }
  await expect.poll(pixels).toBe(saved);
  for (let i = 0; i < 20; i++) {
    await cycle();
    await cycle();
    await cycle();
    await ready();
  }
  expect((await stats()).maxActive).toBe(1);
  expect((await stats()).created - (await stats()).disposed).toBe(1);
  check(
    "20 page round trips and 20 mode round trips retain camera state and at most one active viewer",
  );
  await ui.getByRole("button", { name: "离线登录", exact: true }).click();
  await expect(figure).toHaveAttribute("data-preview-mode", "front");
  expect((await stats()).active).toBe(0);
  await cycle();
  await cycle();
  await ready();
  await input.focus();
  await page.keyboard.press("Enter");
  await expect(input).toHaveAttribute("data-action", "walk");
  await page.getByLabel("角色名称", { exact: true }).fill("Offline3D");
  await expect(title).toHaveText("Offline3D");
  await expect(input).toHaveAttribute("data-action", "walk");
  await ui.getByRole("button", { name: "Microsoft 登录", exact: true }).click();
  await expect(ui.locator(".device-code")).toBeVisible();
  await expect.poll(async () => (await stats()).active).toBe(0);
  await page
    .getByRole("navigation", { name: "页面路径" })
    .getByRole("button", { name: "返回上一级", exact: true })
    .click();
  await ready();
  check(
    "Offline login starts in front and supports 3D; Microsoft authorization releases the viewer",
  );

  await ui.locator(".players-3d-canvas").evaluate((canvas) => {
    window.__lost3dCanvas = canvas;
    window.__lost3dExtension = canvas
      .getContext("webgl2")
      .getExtension("WEBGL_lose_context");
    window.__lost3dExtension.loseContext();
  });
  await expect(figure).toHaveAttribute("data-preview-status", "failed");
  await expect(ui.locator(".skin-body")).toBeVisible();
  await expect.poll(async () => (await stats()).active).toBe(0);
  await page.evaluate(() => window.__lost3dExtension.restoreContext());
  await ready();
  check(
    "Context loss falls back to 2D and a restoration event rebuilds the preview",
  );
  const beforeHidden = (await stats()).renders;
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await input.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(100);
  expect((await stats()).renders).toBe(beforeHidden);
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(async () => (await stats()).renders)
    .toBeGreaterThan(beforeHidden);
  check(
    "Hidden documents cancel rendering; visibility restoration draws only the changed view",
  );
  await ui.getByRole("button", { name: "选择角色 Steve", exact: true }).click();
  await expect(title).toHaveText("Steve");
  await setImage("#7733cc", 64, false, 700);
  await ui.getByRole("button", { name: "更换皮肤", exact: true }).click();
  await ui.getByRole("button", { name: "选择角色 Alex", exact: true }).click();
  await expect(title).toHaveText("Alex");
  const alexPixels = await pixels();
  await page.waitForTimeout(900);
  expect(await pixels()).toBe(alexPixels);
  await expect(title).toHaveText("Alex");
  check(
    "A delayed 3D skin cannot overwrite a later character or its displayed name",
  );
  await ui
    .getByRole("button", { name: "选择角色 Builder_07", exact: true })
    .click();
  await expect(title).toHaveText("Builder_07");
  await page.waitForTimeout(400);
  await ui.getByRole("button", { name: "更改名称", exact: true }).click();
  await page.getByLabel("新的名称", { exact: true }).fill("Builder3D");
  await arm();
  await ui.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(title).toHaveText("Builder3D");
  await expect
    .poll(() => page.evaluate(() => window.__3dAnimations.length))
    .toBe(4);
  await finish();
  await arm();
  await ui.getByRole("button", { name: "选择角色 Steve", exact: true }).click();
  await expect(title).toHaveText("Steve");
  const firstOutgoing = await ui
    .locator(".players-skin-outgoing")
    .evaluate((canvas) => canvas.toDataURL());
  await ui.getByRole("button", { name: "选择角色 Alex", exact: true }).click();
  await expect(title).toHaveText("Alex");
  expect(
    await ui
      .locator(".players-skin-outgoing")
      .evaluate((canvas) => canvas.toDataURL()),
  ).toBe(firstOutgoing);
  await finish();
  check(
    "3D rename keeps name/skin transitions; rapid interrupted changes continue from the visible outgoing frame",
  );
  await cycle();
  await expect.poll(async () => (await stats()).active).toBe(0);
  measurements.final = await stats();
  for (const fault of ["module", "webgl"]) {
    const failurePage = await browser.newPage({
      viewport: { width: 1120, height: 640 },
    });
    await failurePage.addInitScript(pixelAppFixture);
    await failurePage.addInitScript(playersFixture);
    if (fault === "module")
      await failurePage.route("**/src/SkinPreview3D.tsx*", (route) =>
        route.abort(),
      );
    else
      await failurePage.addInitScript(() => {
        window.__disable3d = true;
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          if (window.__disable3d && /webgl/.test(type)) return null;
          return getContext.call(this, type, ...args);
        };
      });
    await failurePage.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
    await expect(failurePage.locator("html")).not.toHaveAttribute(
      "data-startup",
      /loading|revealing/,
    );
    await failurePage.locator(".profile-button").click();
    await failurePage.locator(".players-facing").click();
    await failurePage.locator(".players-facing").click();
    await expect(failurePage.locator(".players-figure")).toHaveAttribute(
      "data-preview-status",
      "failed",
    );
    await expect(failurePage.locator(".players-page .skin-body")).toBeVisible();
    await expect(failurePage.locator(".players-preview-loading")).toHaveCount(
      0,
    );
    if (fault === "webgl") {
      await failurePage.evaluate(() => (window.__disable3d = false));
      await failurePage
        .getByRole("button", { name: "重试", exact: true })
        .click();
      await expect(failurePage.locator(".players-figure")).toHaveAttribute(
        "data-preview-status",
        "ready",
      );
    }
    await failurePage.close();
  }
  check(
    "Module-load failure and unavailable WebGL preserve 2D; explicit retry recreates a usable viewer",
  );
  for (const scale of [1.5, 2]) {
    const context = await browser.newContext({
      viewport: { width: 1120, height: 640 },
      deviceScaleFactor: scale,
      hasTouch: true,
    });
    const dpiPage = await context.newPage();
    await dpiPage.addInitScript(pixelAppFixture);
    await dpiPage.addInitScript(playersFixture);
    await dpiPage.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
    await expect(dpiPage.locator("html")).not.toHaveAttribute(
      "data-startup",
      /loading|revealing/,
    );
    await dpiPage.locator(".profile-button").click();
    await dpiPage.locator(".players-facing").click();
    await dpiPage.locator(".players-facing").click();
    await expect(dpiPage.locator(".players-figure")).toHaveAttribute(
      "data-preview-status",
      "ready",
    );
    const dpiSurface = dpiPage.locator(".players-3d-surface");
    const dpiInput = dpiPage.locator(".players-3d-input");
    expect(
      await dpiSurface.evaluate((canvas) => canvas.width),
    ).toBeLessThanOrEqual(512);
    const tapPoint = await playerPoint(dpiPage);
    await dpiPage.touchscreen.tap(tapPoint.x, tapPoint.y);
    await expect(dpiInput).toHaveAttribute("data-action", "walk");
    const tappingFrame = await dpiSurface.evaluate((canvas) =>
      canvas.toDataURL(),
    );
    await dpiPage.waitForTimeout(180);
    expect(await dpiSurface.evaluate((canvas) => canvas.toDataURL())).not.toBe(
      tappingFrame,
    );
    await dpiInput.focus();
    for (let i = 0; i < 4; i++) await dpiPage.keyboard.press("Enter");
    await expect(dpiInput).toHaveAttribute("data-action", "still");
    await dpiPage.waitForTimeout(100);
    const initialTouch = await dpiSurface.evaluate((canvas) =>
      canvas.toDataURL(),
    );
    const bounds = await dpiInput.boundingBox();
    const client = await context.newCDPSession(dpiPage);
    const x = bounds.x + bounds.width / 2,
      y = bounds.y + bounds.height / 2;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    });
    await dpiPage.waitForTimeout(550);
    await expect(dpiInput).toHaveAttribute("data-action", "still");
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + 25, y: y + 8 }],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(() => dpiSurface.evaluate((canvas) => canvas.toDataURL()))
      .not.toBe(initialTouch);
    await dpiPage.waitForTimeout(550);
    await expect(dpiInput).toHaveAttribute("data-action", "still");
    const beforePinch = await dpiSurface.evaluate((canvas) =>
      canvas.toDataURL(),
    );
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: x - 12, y },
        { x: x + 12, y },
      ],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: x - 24, y },
        { x: x + 24, y },
      ],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(() => dpiSurface.evaluate((canvas) => canvas.toDataURL()))
      .not.toBe(beforePinch);
    await dpiPage.waitForTimeout(550);
    await expect(dpiInput).toHaveAttribute("data-action", "still");
    await dpiPage.screenshot({ path: `${evidence}/dpi-${scale}-touch.png` });
    await context.close();
  }
  check(
    "Browser 150%/200% DPI retains the pixel budget; taps animate while cancelled touches, drags and pinches preserve the action",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/report.json`,
    JSON.stringify(
      { checks, errors, measurements, browser: browser.version() },
      null,
      2,
    ),
  );
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
