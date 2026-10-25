import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { projectPath, runtimePath } from "./lib/paths.mjs";

const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:4180";
const evidence = runtimePath("startup-implementation");
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
const checks = [];
const errors = [];
const contexts = [];
const fresh = async (fixture = true) => {
  const context = await browser.newContext({
    viewport: { width: 1120, height: 640 },
  });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  if (fixture) await page.addInitScript(pixelAppFixture);
  return page;
};
const held = async (page, error = false) => {
  await expect(page.locator("html")).toHaveAttribute("data-startup", "loading");
  await expect(page.locator("#startup-screen")).toBeVisible();
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  expect(
    await page
      .locator("#root")
      .evaluate((node) => getComputedStyle(node).opacity),
  ).toBe("0");
  expect(
    await page.evaluate(() =>
      [
        document.documentElement,
        document.body,
        document.getElementById("startup-screen"),
      ].map((node) => getComputedStyle(node).backgroundColor),
    ),
  ).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
  if (!error) {
    await expect(page.locator("#startup-close")).toBeHidden();
    await expect(page.locator("#startup-error")).toBeHidden();
  }
};
const transparentCorners = async (page, path) => {
  const png = await page.screenshot({ path, omitBackground: true });
  const alpha = await page.evaluate(async (png) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return [
      [0, 0],
      [image.width - 1, 0],
      [0, image.height - 1],
      [image.width - 1, image.height - 1],
    ].map(([x, y]) => context.getImageData(x, y, 1, 1).data[3]);
  }, png.toString("base64"));
  expect(alpha).toEqual([0, 0, 0, 0]);
};
const ready = async (page) => {
  await page.waitForFunction(
    () => !document.documentElement.hasAttribute("data-startup"),
  );
  await expect(page.locator("#startup-screen")).toHaveCount(0);
  await expect(page.locator(".app")).toBeVisible();
  expect(
    await page.locator("#root").evaluate((node) => ({
      inert: node.inert,
      transform: getComputedStyle(node).transform,
      opacity: getComputedStyle(node).opacity,
    })),
  ).toEqual({ inert: false, transform: "none", opacity: "1" });
};
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#32785b"/></svg>';

try {
  // A delayed application bundle must not delay or hide the small splash entry.
  const bundle = await fresh(false);
  await bundle.addInitScript(() => {
    window.__startupTFrames = [];
    let previous = "";
    new MutationObserver(() => {
      const paths = [...document.querySelectorAll(".startup-icon-t-stroke")];
      if (paths.length !== 3) return;
      const phase = document.querySelector("#startup-screen")?.dataset.phase;
      const offsets = paths.map((path) => Number(path.style.strokeDashoffset));
      const nibbles = [
        ...document.querySelectorAll(".startup-icon-t [data-nib]"),
      ].map((nib) => ({
        x: Number(nib.getAttribute("cx")),
        opacity: Number(nib.style.opacity),
      }));
      const state = { phase, offsets, nibbles };
      const key = JSON.stringify(state);
      if (key !== previous) {
        previous = key;
        window.__startupTFrames.push({ time: performance.now(), ...state });
      }
      if (document.documentElement.dataset.startup === "revealing")
        window.__startupTAtReveal = offsets;
    }).observe(document, { subtree: true, childList: true, attributes: true });
  });
  let releaseBundle;
  let bundleRequested = false;
  const bundleHold = new Promise((resolve) => {
    releaseBundle = resolve;
  });
  await bundle.route(/\/assets\/main-[^/]+\.js$/, async (route) => {
    bundleRequested = true;
    await bundleHold;
    await route.continue();
  });
  await bundle.goto(url, { waitUntil: "domcontentloaded" });
  await expect.poll(() => bundleRequested).toBe(true);
  await bundle.waitForFunction(
    () =>
      document.querySelector("#startup-screen")?.getAttribute("data-phase") ===
      "erase",
  );
  await held(bundle);
  expect(
    await bundle.locator("#root").evaluate((node) => node.childElementCount),
  ).toBe(0);
  await transparentCorners(bundle, `${evidence}/splash-waiting.png`);
  // The second draw must repeat the same two-sided bar before the stem.
  await bundle.waitForFunction(() => {
    const screen = document.querySelector("#startup-screen");
    const stem = screen?.querySelector('[data-stroke="stem"]');
    const offset = Number(stem?.style.strokeDashoffset);
    return screen?.dataset.phase === "draw" && offset > 0 && offset < 39;
  });
  const markFrames = await bundle.evaluate(() => window.__startupTFrames);
  for (const phase of ["intro", "draw"]) {
    const frames = markFrames.filter((frame) => frame.phase === phase);
    expect(
      frames.some(
        ({ offsets: [left, right, stem] }) =>
          left > 0 && left < 22 && left === right && stem === 39,
      ),
    ).toBe(true);
    expect(
      frames.every(
        ({ offsets: [left, right, stem] }) =>
          left === right && (stem === 39 || (left === 0 && right === 0)),
      ),
    ).toBe(true);
    const horizontalDone = frames.find(({ offsets }) => offsets[0] === 0);
    const verticalStarted = frames.find(({ offsets }) => offsets[2] < 39);
    // Render-frame quantization allows one frame on either side of the 50ms pause.
    expect(verticalStarted.time - horizontalDone.time).toBeGreaterThanOrEqual(
      30,
    );
    const pairedNibs = frames.find(
      ({ nibbles }) => nibbles[0].opacity > 0 && nibbles[1].opacity > 0,
    );
    expect(pairedNibs.nibbles[0].x + pairedNibs.nibbles[1].x).toBeCloseTo(
      104,
      3,
    );
  }
  const gaps = markFrames.filter((frame) => frame.phase === "gap");
  expect(gaps.length).toBeGreaterThan(0);
  expect(gaps.every(({ offsets }) => offsets.join(",") === "22,22,39")).toBe(
    true,
  );
  expect(await bundle.locator(".startup-ink-stroke").count()).toBe(11);
  expect(
    await bundle.locator(".startup-icon-t-texture").getAttribute("href"),
  ).toBe(
    await bundle.locator(".startup-icon-main").evaluate((image) => image.src),
  );
  releaseBundle();
  await ready(bundle);
  expect(await bundle.evaluate(() => window.__startupTAtReveal)).toEqual([
    0, 0, 0,
  ]);
  await writeFile(
    `${evidence}/icon-t-motion.json`,
    JSON.stringify(markFrames, null, 2),
  );
  checks.push(
    "Option B draws both sides of the T together, pauses before the vertical stroke, preserves icon texture and repeats while loading; reveal waits for the complete T.",
  );
  checks.push(
    "Splash animates before the main JS bundle arrives; the main document stays hidden.",
  );

  // Release each real first-screen dependency independently, without sleeping a
  // fixed startup duration. This also exercises a late notice mounted after IPC.
  const page = await fresh();
  await page.addInitScript(() => {
    const gates = {};
    const waiting = new Map();
    for (const name of [
      "bootstrap",
      "versions.list",
      "tasks",
      "notices.list",
      "image",
    ]) {
      waiting.set(
        name,
        new Promise((resolve) => {
          gates[name] = resolve;
        }),
      );
    }
    const fixture = window.__pixelTest;
    fixture.data.settings.showNotices = true;
    fixture.data.settings.theme = "dark";
    fixture.data.settings.accent = "ebony";
    fixture.data.players[0].skin = "C:/Pixel-Test/skin.png";
    fixture.data.backgroundPath = "C:/Pixel-Test/background.png";
    window.__SFMCL_T_APPEARANCE__ = { theme: "dark", accent: "ebony" };
    window.__startupTest = {
      release: (name) => gates[name](),
      entered: [],
      reveal: null,
    };
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "request") {
        const name = args.operation;
        window.__startupTest.entered.push(name);
        if (waiting.has(name)) await waiting.get(name);
        if (name === "image")
          return args.payload.path.endsWith("skin.png")
            ? "/assets/startup-skin.png"
            : "/assets/startup-background.svg";
        if (name === "notices.list")
          return [
            {
              title: "启动验证公告",
              content: "![已加载的公告](/assets/startup-notice.svg)",
              icon: "",
            },
          ];
      }
      return invoke(command, args);
    };
    new MutationObserver(() => {
      if (
        document.documentElement.dataset.startup !== "revealing" ||
        window.__startupTest.reveal
      )
        return;
      const root = document.querySelector("#root");
      const animation = root
        .getAnimations()
        .find((item) => item.id === "sfmcl-t-startup-reveal");
      const face = root.querySelector(".skin-face");
      window.__startupTest.reveal = {
        frames: animation?.effect
          .getKeyframes()
          .map(({ opacity, transform }) => ({ opacity, transform })),
        duration: animation?.effect.getTiming().duration,
        imagesReady: [...root.querySelectorAll("img")].every(
          (image) => image.complete,
        ),
        fonts: document.fonts.status,
        skinAlpha: face?.getContext("2d").getImageData(3, 3, 1, 1).data[3],
      };
    }).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-startup"],
    });
  });
  const releases = {};
  const requested = new Set();
  for (const name of ["font", "skin", "background", "notice"]) {
    const wait = new Promise((resolve) => {
      releases[name] = resolve;
    });
    const pattern =
      name === "font"
        ? /PixelifySans-Bold\.ttf$/
        : new RegExp(`/assets/startup-${name}\\.(?:png|svg)$`);
    await page.route(pattern, async (route) => {
      requested.add(name);
      await wait;
      if (name === "font") await route.continue();
      else if (name === "skin")
        await route.fulfill({
          contentType: "image/png",
          body: await readFile(projectPath("public/assets/steve.png")),
        });
      else await route.fulfill({ contentType: "image/svg+xml", body: svg });
    });
  }
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const entered = async (name) =>
    expect
      .poll(() =>
        page.evaluate(
          (name) => window.__startupTest.entered.includes(name),
          name,
        ),
      )
      .toBe(true);
  const release = (name) =>
    page.evaluate((name) => window.__startupTest.release(name), name);
  await entered("bootstrap");
  await held(page);
  await release("bootstrap");
  await entered("versions.list");
  await held(page);
  await release("versions.list");
  await entered("tasks");
  await entered("notices.list");
  await entered("image");
  await held(page);
  await release("tasks");
  await release("notices.list");
  await expect.poll(() => requested.has("notice")).toBe(true);
  await held(page);
  await release("image");
  await expect
    .poll(
      () =>
        requested.has("skin") &&
        requested.has("background") &&
        requested.has("font"),
    )
    .toBe(true);
  await held(page);
  releases.font();
  releases.skin();
  releases.background();
  await expect
    .poll(() =>
      page
        .locator(".skin-face")
        .evaluate(
          (canvas) => canvas.getContext("2d").getImageData(3, 3, 1, 1).data[3],
        ),
    )
    .toBe(255);
  await held(page);
  await transparentCorners(page, `${evidence}/splash-transparent-dark.png`);
  releases.notice();
  await ready(page);
  const reveal = await page.evaluate(() => window.__startupTest.reveal);
  expect(reveal).toEqual({
    frames: [
      { opacity: "0", transform: "scale(0.8)" },
      { opacity: "1", transform: "scale(1)" },
    ],
    duration: 380,
    imagesReady: true,
    fonts: "loaded",
    skinAlpha: 255,
  });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "ebony");
  expect(await page.evaluate(() => window.__pixelTest.startupPhases)).toEqual([
    "loading",
    "ready",
    "shown",
  ]);
  await page.screenshot({ path: `${evidence}/ready-dark.png` });
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "版本管理" })
    .click();
  await expect(page.locator("#startup-screen")).toHaveCount(0);
  checks.push(
    "Bootstrap, version list, initial tasks/notices, IPC image resolution, background, canvas skin, lazy notice image and font independently block reveal.",
  );
  checks.push(
    "The fully loaded UI enters at scale .8 / opacity 0, finishes at 1 / 1 in 380 ms; startup never replays on navigation.",
  );

  const failure = await fresh();
  await failure.addInitScript(() => {
    if (!sessionStorage.getItem("startup-retry-test"))
      window.__pixelTest.failures.bootstrap = "无法读取测试配置";
  });
  await failure.goto(url);
  await expect(failure.locator("#startup-error")).toBeVisible();
  await expect(failure.locator("#startup-error-message")).toContainText(
    "无法读取测试配置",
  );
  await held(failure, true);
  expect(
    await failure.evaluate(() => window.__pixelTest.startupPhases),
  ).toEqual(["loading", "error"]);
  await failure.setViewportSize({ width: 400, height: 332 });
  await expect(failure.locator("#startup-close")).toBeVisible();
  await expect(failure.locator("#startup-retry")).toBeFocused();
  await failure
    .locator(".startup-panel")
    .evaluate((panel) =>
      Promise.all(panel.getAnimations().map((animation) => animation.finished)),
    );
  const panel = await failure.locator(".startup-panel").boundingBox();
  expect(panel.width).toBeLessThanOrEqual(368);
  expect(panel.height).toBe(300);
  await transparentCorners(failure, `${evidence}/startup-error.png`);
  await expect(failure.locator("#startup-screen")).toHaveAttribute(
    "data-phase",
    "complete",
  );
  expect(
    await failure.locator(".startup-icon-t").evaluate((icon) => ({
      width: icon.getBoundingClientRect().width,
      height: icon.getBoundingClientRect().height,
    })),
  ).toEqual({ width: 64, height: 64 });
  expect(
    await failure
      .locator(".startup-icon-t-stroke")
      .evaluateAll((paths) =>
        paths.map((path) => Number(path.style.strokeDashoffset)),
      ),
  ).toEqual([0, 0, 0]);
  await failure.evaluate(() =>
    sessionStorage.setItem("startup-retry-test", "1"),
  );
  await failure.getByRole("button", { name: "重试启动" }).click();
  await failure.setViewportSize({ width: 1120, height: 640 });
  await ready(failure);
  checks.push(
    "Failed bootstrap keeps the app hidden, exposes a retry, and a successful retry reveals the app.",
  );
  checks.push(
    "Loading has no background or close button; light/dark corners have alpha 0; errors use a 368 × 300 panel and request a compact native window.",
  );

  // A suspended document pauses both lettering and the readiness deadline.
  const hidden = await fresh();
  await hidden.clock.install();
  await hidden.addInitScript(() => {
    window.__startupHidden = true;
    Object.defineProperty(document, "hidden", {
      get: () => window.__startupHidden,
    });
    const invoke = window.__TAURI_INTERNALS__.invoke;
    let release;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    window.__releaseStartup = release;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "request" && args.operation === "bootstrap") await hold;
      return invoke(command, args);
    };
  });
  await hidden.goto(url, { waitUntil: "domcontentloaded" });
  await hidden.clock.runFor(100);
  await hidden.clock.fastForward(60_000);
  await held(hidden);
  await hidden.evaluate(() => {
    window.__startupHidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await hidden.clock.runFor(200);
  await hidden.evaluate(() => window.__releaseStartup());
  // Let network resources settle while animation/paint time advances.
  for (let i = 0; i < 20; i++) {
    await hidden.clock.runFor(200);
    if (await hidden.evaluate(() => !document.documentElement.dataset.startup))
      break;
  }
  await ready(hidden);
  checks.push(
    "A hidden startup remains healthy beyond 30 seconds and resumes normally when visible.",
  );

  const stalled = await fresh();
  await stalled.clock.install();
  await stalled.addInitScript(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) =>
      command === "request" && args.operation === "bootstrap"
        ? new Promise(() => {})
        : invoke(command, args);
  });
  await stalled.goto(url, { waitUntil: "domcontentloaded" });
  await stalled.clock.fastForward(31_000);
  await held(stalled, true);
  await expect(stalled.locator("#startup-error-message")).toContainText("超时");
  checks.push(
    "A genuinely stalled visible startup still times out into the compact error panel.",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, reveal, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, reveal, errors }, null, 2));
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
