import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { launchDockFixture } from "./fixtures/launch-dock.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("evidence/tray-launch");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
});
const page = await browser.newPage({ viewport: { width: 1120, height: 640 } });
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(launchDockFixture);
await page.addInitScript(() => {
  const restored = sessionStorage.getItem("tray-test-snapshot");
  if (restored) window.__SFMCL_T_SESSION__ = JSON.parse(restored);
  const callbacks = new Map();
  const listeners = new Map();
  const bridge = window.__TAURI_INTERNALS__;
  const invoke = bridge.invoke;
  let serial = 0;
  let releaseBootstrap;
  const bootstrap = restored
    ? new Promise((resolve) => (releaseBootstrap = resolve))
    : Promise.resolve();
  const state = (window.__trayTest = {
    visible: false,
    pending: null,
    snapshots: [],
    operations: [],
    phases: [],
    motions: [],
    holdReveal: !!restored,
    releaseBootstrap: () => releaseBootstrap?.(),
    send(action) {
      const payload = { id: ++serial, action };
      state.pending = payload;
      for (const callback of listeners.get("sfmcl-t-window-transition") || [])
        callbacks.get(callback)({ payload });
    },
  });
  bridge.transformCallback = (callback) => {
    const id = ++serial;
    callbacks.set(id, callback);
    return id;
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  bridge.invoke = async (command, args) => {
    if (command === "plugin:event|listen") {
      const entries = listeners.get(args.event) || [];
      entries.push(args.handler);
      listeners.set(args.event, entries);
      return ++serial;
    }
    if (command === "plugin:window|is_visible") return state.visible;
    if (command === "plugin:window|is_minimized") return false;
    if (command === "suspend_launcher_window") {
      state.snapshots.push({
        ...args,
        progress: parseFloat(
          getComputedStyle(
            document.querySelector(".launch-primary"),
          ).getPropertyValue("--launch-button-progress"),
        ),
      });
      if (args.snapshot) {
        sessionStorage.setItem(
          "tray-test-snapshot",
          JSON.stringify(args.snapshot),
        );
        state.send("hide");
      }
      return !!args.snapshot;
    }
    if (command === "complete_window_transition") {
      if (state.pending?.id !== args.id) return false;
      state.operations.push({
        action: state.pending.action,
        opacity: Number(getComputedStyle(document.body).opacity),
      });
      state.visible = state.pending.action !== "hide";
      return true;
    }
    if (command === "startup_window") {
      state.phases.push(args.phase);
      if (args.phase === "loading" || args.phase === "error")
        state.visible = true;
      if (args.phase === "reveal") {
        state.revealOpacity = Number(
          getComputedStyle(document.querySelector("#root")).opacity,
        );
        state.visible = true;
      }
    }
    if (command === "request" && args?.operation === "bootstrap")
      await bootstrap;
    return invoke(command, args);
  };
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (frames, options) {
    const motion = animate.call(this, frames, options);
    if (options?.id?.startsWith("sfmcl-t-window-")) {
      state.motions.push(motion);
      motion.pause();
    }
    if (options?.id === "sfmcl-t-startup-reveal" && restored) {
      state.reveal = motion;
      const play = motion.play.bind(motion);
      motion.play = () => (state.holdReveal ? motion.pause() : play());
    }
    return motion;
  };
});

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420");
  await expect(page.locator("html")).not.toHaveAttribute("data-startup", {
    timeout: 15_000,
  });
  await page.locator(".launch-primary").click();
  await expect
    .poll(() => page.evaluate(() => window.__pixelTest.latestLaunch?.id))
    .toBeTruthy();
  await page.evaluate(() => {
    window.__pixelTest.advanceLaunch(3);
    window.__suspensionDone = false;
    void window
      .__SFMCL_T_SUSPEND__(1, window.__pixelTest.latestLaunch.id)
      .then(() => (window.__suspensionDone = true));
  });
  await expect(page.locator(".launch-primary")).toHaveCSS(
    "--launch-button-progress",
    "75%",
  );
  expect(await page.evaluate(() => window.__trayTest.snapshots)).toEqual([]);

  // Restoring before completion cancels the pending hide without losing the UI.
  await page.evaluate(() => window.__trayTest.send("show"));
  await expect
    .poll(() => page.evaluate(() => window.__suspensionDone))
    .toBe(true);
  await page.evaluate(() => window.__trayTest.motions.at(-1).finish());
  await expect(page.locator("html")).not.toHaveAttribute("data-window-motion");
  expect(await page.evaluate(() => window.__trayTest.snapshots)).toEqual([]);
  checks.push(
    "Restoring while progress is below 100% cancels the pending suspension.",
  );

  await page.evaluate(() => {
    void window.__SFMCL_T_SUSPEND__(2, window.__pixelTest.latestLaunch.id);
    window.__pixelTest.advanceLaunch(4);
  });
  await page.waitForFunction(() => {
    const button = document.querySelector(".launch-primary");
    if (button.dataset.launchRunning !== "true") return false;
    const fill = button
      .getAnimations()
      .find(
        (motion) => motion.transitionProperty === "--launch-button-progress",
      );
    if (!fill) return false;
    fill.pause();
    fill.currentTime = 120;
    window.__progressFill = fill;
    return true;
  });
  const intermediate = await page
    .locator(".launch-primary")
    .evaluate((button) =>
      parseFloat(
        getComputedStyle(button).getPropertyValue("--launch-button-progress"),
      ),
    );
  expect(intermediate).toBeGreaterThan(75);
  expect(intermediate).toBeLessThan(100);
  expect(await page.evaluate(() => window.__trayTest.snapshots)).toEqual([]);
  await page.evaluate(() => window.__progressFill.finish());
  await expect(page.locator("html")).toHaveAttribute(
    "data-window-motion",
    "hide",
  );
  const hide = await page.evaluate(() => {
    const motion = window.__trayTest.motions.at(-1);
    motion.currentTime = 60;
    return {
      duration: motion.effect.getTiming().duration,
      lastFrame: motion.effect.getKeyframes().at(-1),
      opacity: Number(getComputedStyle(document.body).opacity),
      visible: window.__trayTest.visible,
      snapshots: window.__trayTest.snapshots,
      operations: window.__trayTest.operations,
    };
  });
  expect(hide.snapshots[0].progress).toBe(100);
  expect(hide.visible).toBe(true);
  expect(hide.operations.map((operation) => operation.action)).toEqual([
    "show",
  ]);
  expect(hide.duration).toBe(120);
  expect(hide.lastFrame.transform).toBe("translateY(3%) scale(0.93)");
  expect(hide.opacity).toBeGreaterThan(0);
  expect(hide.opacity).toBeLessThan(1);
  await page.screenshot({ path: `${evidence}/hide-mid.png` });
  await page.evaluate(() => window.__trayTest.motions.at(-1).finish());
  await expect
    .poll(() => page.evaluate(() => window.__trayTest.visible))
    .toBe(false);
  expect(
    await page.evaluate(() => window.__trayTest.operations.at(-1)),
  ).toEqual({ action: "hide", opacity: 0 });
  checks.push(
    "The actual animated launch fill reaches 100% before a 120ms minimize animation hides the window.",
  );

  // Block the main module: restoring must animate before React can even mount.
  let releaseMain;
  let mainRequested = false;
  const mainHold = new Promise((resolve) => (releaseMain = resolve));
  const mainModule = /\/(?:src\/main\.tsx|assets\/main-[^/]+\.js)(?:\?|$)/;
  await page.route(mainModule, async (route) => {
    mainRequested = true;
    await mainHold;
    await route.continue();
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => mainRequested).toBe(true);
  await expect(page.locator("#startup-screen")).toBeVisible();
  await expect(page.locator("#root")).toBeEmpty();
  await expect(page.locator("#root")).toHaveCSS("opacity", "0");
  await expect(page.locator(".startup-ink-stroke")).toHaveCount(11);
  await expect(page.locator("#startup-screen")).toHaveAttribute(
    "data-phase",
    "erase",
  );
  expect(await page.evaluate(() => window.__trayTest.visible)).toBe(true);
  expect(await page.evaluate(() => window.__trayTest.phases)).toEqual([
    "loading",
  ]);
  await page.screenshot({ path: `${evidence}/restore-loading-bundle.png` });
  releaseMain();
  await expect
    .poll(() => page.evaluate(() => !!window.__SFMCL_T_SUSPEND__))
    .toBe(true);
  await page.unroute(mainModule);
  await expect(page.locator("#startup-screen")).toBeVisible();
  expect(await page.evaluate(() => window.__trayTest.phases)).toEqual([
    "loading",
  ]);
  await page.screenshot({ path: `${evidence}/restore-loading-bootstrap.png` });
  checks.push(
    "Tray restore shows the animated logo before the main module loads and keeps it visible while bootstrap IPC is pending.",
  );
  await page.evaluate(() => window.__trayTest.releaseBootstrap());
  await expect
    .poll(() =>
      page.evaluate(() => window.__trayTest.phases.includes("reveal")),
    )
    .toBe(true);
  const reveal = await page.evaluate(() => {
    const motion = window.__trayTest.reveal;
    motion.currentTime = 240;
    const style = getComputedStyle(document.querySelector("#root"));
    return {
      phases: window.__trayTest.phases,
      duration: motion.effect.getTiming().duration,
      startOpacity: window.__trayTest.revealOpacity,
      opacity: Number(style.opacity),
      scale: new DOMMatrixReadOnly(style.transform).a,
      inert: document.querySelector("#root").inert,
    };
  });
  expect(reveal.phases).toEqual(["loading", "ready", "reveal"]);
  expect(reveal.duration).toBe(480);
  expect(reveal.startOpacity).toBe(0);
  expect(reveal.opacity).toBeGreaterThan(0);
  expect(reveal.opacity).toBeLessThan(1);
  expect(reveal.scale).toBeGreaterThan(0.94);
  expect(reveal.scale).toBeLessThan(1);
  expect(reveal.inert).toBe(true);
  await page.screenshot({ path: `${evidence}/restore-mid.png` });
  await page.evaluate(() => window.__trayTest.reveal.finish());
  await expect(page.locator("html")).not.toHaveAttribute("data-startup");
  await expect(page.locator("#root")).toHaveCSS("transform", "none");
  await expect(page.locator("#root")).toHaveCSS("opacity", "1");
  expect(await page.evaluate(() => window.__trayTest.phases.at(-1))).toBe(
    "shown",
  );
  checks.push(
    "After the loading logo, the rebuilt tray window reuses the 480ms startup entrance before releasing input and restoring the frame.",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, hide, reveal, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser.close();
}
