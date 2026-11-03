import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { runtimePath } from "./lib/paths.mjs";
import { assertSurfaceCorners } from "./lib/surface-corners.mjs";

const evidence = runtimePath("evidence/window-motion");
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
await page.addInitScript(() => {
  const callbacks = new Map();
  const listeners = new Map();
  const bridge = window.__TAURI_INTERNALS__;
  const invoke = bridge.invoke;
  let serial = 0;
  let documentHidden = false;
  const state = (window.__windowTest = {
    hold: true,
    motions: [],
    operations: [],
    frameVisible: true,
    frameFinishes: [],
    visible: true,
    minimized: false,
    pending: null,
    emit(event, payload) {
      for (const handler of listeners.get(event) || [])
        callbacks.get(handler)({ event, payload });
    },
    send(action) {
      const payload = { id: ++serial, action };
      state.frameVisible = false;
      state.pending = payload;
      state.emit("sfmcl-t-window-transition", payload);
      return payload.id;
    },
    visibility(hidden) {
      documentHidden = hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    },
  });
  Object.defineProperty(document, "hidden", { get: () => documentHidden });
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
    if (command === "plugin:window|is_minimized") return state.minimized;
    if (command === "minimize_window") {
      state.send("minimize");
      return;
    }
    if (command === "finish_window_transition") {
      if (
        !state.visible ||
        state.minimized ||
        (args.id != null && args.id !== state.pending?.id)
      )
        return;
      if (args.cancel) state.pending = null;
      state.frameFinishes.push({
        opacity: Number(getComputedStyle(document.body).opacity),
        transform: getComputedStyle(document.body).transform,
      });
      state.frameVisible = true;
      return;
    }
    if (command === "complete_window_transition") {
      if (state.pending?.id !== args.id) return false;
      if (state.fail) throw new Error("Simulated native failure");
      const action = state.pending.action;
      state.operations.push({
        action,
        opacity: Number(getComputedStyle(document.body).opacity),
      });
      state.visible = action !== "hide";
      state.minimized = action === "minimize";
      if (state.holdAck)
        await new Promise((resolve) => {
          state.releaseAck = resolve;
        });
      return true;
    }
    return invoke(command, args);
  };
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (...args) {
    const motion = animate.apply(this, args);
    if (args[1]?.id?.startsWith("sfmcl-t-window-")) {
      state.motions.push(motion);
      if (state.hold && args[1].duration) motion.pause();
    }
    return motion;
  };
});

const idle = async () => {
  await expect(page.locator("html")).not.toHaveAttribute("data-window-motion");
  await expect(page.locator("body")).toHaveCSS("transform", "none");
  await expect(page.locator("body")).toHaveCSS("opacity", "1");
  await expect(page.locator("body")).toHaveCSS("pointer-events", "auto");
  await expect(page.locator("body")).toHaveCSS("clip-path", "none");
  await expect
    .poll(() => page.evaluate(() => window.__windowTest.frameVisible))
    .toBe(true);
};
const send = (action) =>
  page.evaluate((action) => window.__windowTest.send(action), action);
const finish = () =>
  page.evaluate(() => window.__windowTest.motions.at(-1).finish());
const sample = (progress) =>
  page.evaluate((progress) => {
    const motion = window.__windowTest.motions.at(-1);
    motion.pause();
    motion.currentTime = motion.effect.getTiming().duration * progress;
    const style = getComputedStyle(document.body);
    const matrix = new DOMMatrix(style.transform);
    const bounds = document.body.getBoundingClientRect();
    return {
      scale: matrix.a,
      y: matrix.f,
      opacity: Number(style.opacity),
      target: motion.effect.target.tagName,
      canvasColor: getComputedStyle(document.documentElement).backgroundColor,
      canvasScheme: getComputedStyle(document.documentElement).colorScheme,
      operations: window.__windowTest.operations.length,
      frameVisible: window.__windowTest.frameVisible,
      duration: motion.effect.getTiming().duration,
      bounds: {
        top: bounds.top,
        left: bounds.left,
        right: bounds.right,
        bottom: bounds.bottom,
      },
      viewport: { width: innerWidth, height: innerHeight },
    };
  }, progress);

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1431");
  await expect(page.locator("html")).not.toHaveAttribute("data-startup");
  await idle();
  await page.evaluate(() => {
    const popover = document.createElement("div");
    popover.id = "window-motion-popover";
    popover.textContent = "弹出层随整个窗口一起切换";
    popover.style.cssText =
      "position:fixed;right:40px;top:70px;padding:16px;background:var(--panel);color:var(--ink);z-index:2000";
    document.body.append(popover);
  });

  await page.getByRole("button", { name: "最小化窗口", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-window-motion",
    "minimize",
  );
  const start = await sample(0);
  const middle = await sample(0.5);
  expect(start.opacity).toBe(1);
  expect(middle.opacity).toBeGreaterThan(0);
  expect(middle.opacity).toBeLessThan(1);
  expect(middle.scale).toBeLessThan(1);
  expect(middle.y).toBeGreaterThan(0);
  expect(middle.target).toBe("BODY");
  expect(middle.operations).toBe(0);
  expect(middle.frameVisible).toBe(false);
  const outgoingFrames = [];
  for (let i = 0; i <= 12; i++) outgoingFrames.push(await sample(i / 12));
  for (const [index, frame] of outgoingFrames.entries()) {
    expect(frame.bounds.top).toBeGreaterThanOrEqual(-0.1);
    expect(frame.bounds.left).toBeGreaterThanOrEqual(-0.1);
    expect(frame.bounds.bottom).toBeLessThanOrEqual(
      frame.viewport.height + 0.1,
    );
    expect(frame.bounds.right).toBeLessThanOrEqual(frame.viewport.width + 0.1);
    if (index) {
      expect(frame.opacity).toBeLessThanOrEqual(
        outgoingFrames[index - 1].opacity,
      );
      expect(frame.scale).toBeLessThanOrEqual(outgoingFrames[index - 1].scale);
      expect(frame.y).toBeGreaterThanOrEqual(outgoingFrames[index - 1].y);
    }
  }
  // Move before dissolving; the last transparent frame stays inside the native
  // canvas, avoiding the cut-off bottom edge of the previous animation.
  expect(outgoingFrames[1].scale).toBeLessThan(1);
  expect(outgoingFrames[1].opacity).toBe(1);
  await sample(0.5);
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await assertSurfaceCorners(page, "body", evidence + "/minimize-mid.png");
  await finish();
  await expect
    .poll(() => page.evaluate(() => window.__windowTest.minimized))
    .toBe(true);
  expect(
    await page.evaluate(() => window.__windowTest.operations[0].opacity),
  ).toBe(0);
  checks.push(
    "Titlebar minimizes only after the full UI and its body portal fade and shrink.",
  );

  await page.evaluate(() => {
    window.__windowTest.minimized = false;
    window.__windowTest.visibility(false);
  });
  await expect(page.locator("html")).toHaveAttribute(
    "data-window-motion",
    "show",
  );
  const restoreStart = await sample(0);
  const restoreMiddle = await sample(0.5);
  expect(restoreStart.opacity).toBe(0);
  expect(restoreMiddle.opacity).toBeGreaterThan(0);
  expect(restoreMiddle.scale).toBeGreaterThan(restoreStart.scale);
  const incomingFrames = [];
  for (let i = 0; i <= 12; i++) incomingFrames.push(await sample(i / 12));
  for (const [index, frame] of incomingFrames.entries()) {
    expect(frame.scale).toBeLessThanOrEqual(1);
    expect(frame.bounds.bottom).toBeLessThanOrEqual(
      frame.viewport.height + 0.1,
    );
    if (index) {
      expect(frame.opacity).toBeGreaterThanOrEqual(
        incomingFrames[index - 1].opacity,
      );
      expect(frame.scale).toBeGreaterThanOrEqual(
        incomingFrames[index - 1].scale,
      );
      expect(frame.y).toBeLessThanOrEqual(incomingFrames[index - 1].y);
    }
  }
  expect(incomingFrames[10].opacity).toBe(1);
  expect(incomingFrames[10].scale).toBeLessThan(1);
  await finish();
  await idle();
  checks.push(
    "Taskbar restore animates in and releases transform and pointer blocking.",
  );
  checks.push(
    "The new motion remains inside the canvas, moves before fading out, and becomes opaque before its smooth final settling without overshoot.",
  );

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await send("hide");
  await expect(page.locator("html")).toHaveAttribute(
    "data-window-motion",
    "hide",
  );
  const dark = await sample(0.5);
  expect(dark.frameVisible).toBe(false);
  expect(dark.canvasColor).toBe("rgba(0, 0, 0, 0)");
  expect(dark.canvasScheme).toBe("light");
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await assertSurfaceCorners(page, "body", evidence + "/hide-dark-mid.png");
  await finish();
  await expect
    .poll(() => page.evaluate(() => window.__windowTest.visible))
    .toBe(false);
  await send("show");
  await expect
    .poll(() => page.evaluate(() => window.__windowTest.visible))
    .toBe(true);
  expect(
    await page.evaluate(() => window.__windowTest.operations.at(-1).opacity),
  ).toBe(0);
  await sample(0.5);
  await assertSurfaceCorners(page, "body", evidence + "/show-dark-mid.png");
  await finish();
  await idle();
  expect(
    await page.evaluate(() =>
      window.__windowTest.frameFinishes.every(
        ({ opacity, transform }) => opacity === 1 && transform === "none",
      ),
    ),
  ).toBe(true);
  checks.push(
    "Hide/show preserves a transparent native canvas, suppresses the frame during motion, and restores it only after the full UI is visible.",
    "Minimize, hide and show retain four rounded surface corners in light and dark themes; idle releases the animation clip for popovers.",
  );

  const beforeRace = await page.evaluate(
    () => window.__windowTest.operations.length,
  );
  await send("hide");
  const beforeReverse = await sample(0.5);
  await send("show");
  const afterReverse = await sample(0);
  expect(afterReverse.opacity).toBeCloseTo(beforeReverse.opacity, 5);
  expect(afterReverse.scale).toBeCloseTo(beforeReverse.scale, 5);
  expect(afterReverse.y).toBeCloseTo(beforeReverse.y, 3);
  await finish();
  await idle();
  expect(
    await page.evaluate(
      (start) =>
        window.__windowTest.operations
          .slice(start)
          .map((entry) => entry.action),
      beforeRace,
    ),
  ).toEqual(["show"]);
  checks.push(
    "A restore supersedes an unfinished hide without executing the stale hide.",
  );

  await page.evaluate(() => {
    window.__windowTest.minimized = true;
    window.__windowTest.visibility(true);
  });
  await expect(page.locator("body")).toHaveCSS("opacity", "0");
  await page.evaluate(() => {
    window.__windowTest.minimized = false;
    window.__windowTest.visibility(false);
  });
  await expect(page.locator("html")).toHaveAttribute(
    "data-window-motion",
    "show",
  );
  await finish();
  await idle();
  checks.push(
    "System minimize prepares the next restore without replaying startup or losing UI state.",
  );

  await page.evaluate(() => {
    window.__windowTest.minimized = true;
    window.__windowTest.emit("tauri://resize", { width: 0, height: 0 });
  });
  await expect(page.locator("body")).toHaveCSS("opacity", "0");
  await page.evaluate(() => {
    window.__windowTest.minimized = false;
    window.__windowTest.emit("tauri://resize", { width: 1120, height: 640 });
  });
  await expect(page.locator("html")).toHaveAttribute(
    "data-window-motion",
    "show",
  );
  await finish();
  await idle();
  checks.push(
    "Native resize events cover WebView2 minimization without a visibilitychange event.",
  );

  await page.evaluate(() => {
    window.__windowTest.holdAck = true;
  });
  await send("minimize");
  await finish();
  await expect
    .poll(() => page.evaluate(() => window.__windowTest.minimized))
    .toBe(true);
  await page.evaluate(() => {
    window.__windowTest.minimized = false;
    window.__windowTest.emit("tauri://resize", { width: 1120, height: 640 });
    window.__windowTest.holdAck = false;
    window.__windowTest.releaseAck();
  });
  await expect(page.locator("html")).toHaveAttribute(
    "data-window-motion",
    "show",
  );
  await finish();
  await idle();
  checks.push(
    "An OS restore arriving before the minimize acknowledgement cannot leave an invisible window.",
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const action of ["minimize", "hide"]) {
    const before = await page.evaluate(
      () => window.__windowTest.operations.length,
    );
    await send(action);
    const exit = await sample(0.5);
    expect(exit.opacity).toBeGreaterThan(0);
    expect(exit.opacity).toBeLessThan(1);
    expect(exit.operations).toBe(before);
    await finish();
    await expect
      .poll(() =>
        page.evaluate(
          (action) =>
            action === "hide"
              ? !window.__windowTest.visible
              : window.__windowTest.minimized,
          action,
        ),
      )
      .toBe(true);
    await send("show");
    const enter = await sample(0.5);
    expect(enter.opacity).toBeGreaterThan(0);
    expect(enter.opacity).toBeLessThan(1);
    await finish();
    await idle();
  }
  expect(
    await page.evaluate(() =>
      window.__windowTest.motions
        .slice(-4)
        .map((motion) => motion.effect.getTiming().duration),
    ),
  ).toEqual([120, 150, 100, 150]);
  checks.push(
    "System reduced-motion preference preserves the complete minimize, hide and show animations with intermediate frames and native-operation ordering.",
  );

  await page.evaluate(() => {
    window.__windowTest.fail = true;
  });
  await send("hide");
  await finish();
  await idle();
  expect(errors).toEqual([]);
  checks.push("A failed native operation restores a usable, fully visible UI.");
  await writeFile(
    evidence + "/checks.json",
    JSON.stringify({ checks, errors, start, middle, dark }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser.close();
}
