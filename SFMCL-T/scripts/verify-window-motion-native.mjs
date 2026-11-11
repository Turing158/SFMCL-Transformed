import { chromium, expect } from "@playwright/test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectPath, runtimePath } from "./lib/paths.mjs";
import { assertSurfaceCorners } from "./lib/surface-corners.mjs";

// Requires cargo build -p sfmcl-t and Vite on the configured Tauri devUrl.
if (process.platform !== "win32")
  throw new Error("This regression checks Win32/WebView2 geometry.");
const evidence = runtimePath("evidence/window-motion/native-layout");
await mkdir(evidence, { recursive: true });
const dataDirectory = await mkdtemp(path.join(evidence, "data-"));
const portServer = createServer();
await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
const port = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
const executable = projectPath("target/debug/sfmcl-t.exe");
const launcher = spawn(executable, [], {
  cwd: projectPath(),
  windowsHide: true,
  stdio: "ignore",
  env: {
    ...process.env,
    SFMCL_T_DATA_DIR: dataDirectory,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
});
const execute = promisify(execFile);
const checks = [];
let browser;
try {
  await expect
    .poll(
      async () => {
        try {
          browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 15000 },
    )
    .toBe(true);
  const page = browser.contexts()[0].pages()[0];
  const invoke = (command, args = {}) =>
    page.evaluate(
      ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
      { command, args },
    );
  const native = async (action = "State", clientSize, captureName) => {
    const result = await execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        projectPath("scripts/lib/window-motion-native.ps1"),
        "-LauncherProcessId",
        String(launcher.pid),
        "-ExecutablePath",
        executable,
        "-Action",
        action,
        ...(clientSize
          ? [
              "-ClientWidth",
              String(clientSize.width),
              "-ClientHeight",
              String(clientSize.height),
            ]
          : []),
        ...(captureName
          ? ["-CapturePath", path.join(evidence, `${captureName}.png`)]
          : []),
      ],
      { windowsHide: true },
    );
    return JSON.parse(result.stdout);
  };
  const idle = async () => {
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-window-motion",
    );
    await expect(page.locator("body")).toHaveCSS("transform", "none");
    await expect.poll(async () => (await native()).rendering).toBe(1);
    const maximized = await invoke("plugin:window|is_maximized", {
      label: "main",
    });
    await expect
      .poll(async () => (await native()).shadowVisible)
      .toBe(!maximized);
  };
  const geometry = () =>
    page.evaluate(async () => ({
      size: await window.__TAURI_INTERNALS__.invoke(
        "plugin:window|inner_size",
        { label: "main" },
      ),
      position: await window.__TAURI_INTERNALS__.invoke(
        "plugin:window|inner_position",
        { label: "main" },
      ),
    }));
  const assertTopEdge = async (label) => {
    const expected = await page.evaluate(() => {
      const color = (selector) =>
        getComputedStyle(document.querySelector(selector))
          .backgroundColor.match(/\d+/g)
          .slice(0, 3)
          .join(",");
      return { left: color(".sidebar"), right: color(".topbar") };
    });
    const edge = await native("TopEdge", undefined, label);
    if (
      edge.leftColor !== expected.left ||
      edge.rightColor !== expected.right
    ) {
      await page.screenshot({
        path: path.join(evidence, `${label}-webview.png`),
      });
      console.log({
        label,
        edge,
        style: await page.locator("body").evaluate((body) => ({
          opacity: getComputedStyle(body).opacity,
          transform: getComputedStyle(body).transform,
          motion: document.documentElement.dataset.windowMotion,
        })),
      });
    }
    expect(edge.topInset).toBe(0);
    expect(edge.leftColor).toBe(expected.left);
    expect(edge.rightColor).toBe(expected.right);
    expect(edge.shadowVisible).toBe(true);
    expect(edge.shadowPassThrough).toBe(true);
    expect(edge.shadowLeft).toBeLessThan(edge.clientLeft);
    expect(edge.shadowTop).toBeLessThan(edge.clientTop);
    expect(edge.shadowRight).toBeGreaterThan(
      edge.clientLeft + edge.clientWidth,
    );
    expect(edge.shadowBottom).toBeGreaterThan(
      edge.clientTop + edge.clientHeight,
    );
    expect(edge.shadowLeft + edge.shadowRight).toBe(
      2 * edge.clientLeft + edge.clientWidth,
    );
    expect(edge.shadowTop + edge.shadowBottom).toBe(
      2 * edge.clientTop + edge.clientHeight,
    );
    checks.push(
      `${label}: the first native pixel row paints the sidebar and titlebar, with no caption strip.`,
    );
  };
  const beginRecording = () =>
    page.evaluate(() => {
      const read = () => ({
        width: innerWidth,
        height: innerHeight,
        narrow: matchMedia("(max-width: 850px)").matches,
        bodyHeight: document.body.offsetHeight,
        appWidth: document.querySelector(".app").offsetWidth,
        sidebarWidth: document.querySelector(".sidebar").offsetWidth,
        sidebarClass: document.querySelector(".sidebar").className,
      });
      const recording = (window.__layoutRecording = {
        expected: read(),
        samples: [],
        running: true,
      });
      const sample = () => recording.samples.push(read());
      const frame = () => {
        if (recording.running) {
          sample();
          requestAnimationFrame(frame);
        }
      };
      const media = matchMedia("(max-width: 850px)");
      const observer = new ResizeObserver(sample);
      observer.observe(document.querySelector(".app"));
      window.addEventListener("resize", sample);
      media.addEventListener("change", sample);
      recording.stop = () => {
        recording.running = false;
        observer.disconnect();
        window.removeEventListener("resize", sample);
        media.removeEventListener("change", sample);
      };
      frame();
    });
  const assertStable = async (label) => {
    // Include the frames after the native finish acknowledgement. Checking only
    // the final size misses a transient resize that collapses the sidebar.
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          let remaining = 6;
          const frame = () =>
            --remaining ? requestAnimationFrame(frame) : resolve();
          requestAnimationFrame(frame);
        }),
    );
    const result = await page.evaluate(() => {
      const recording = window.__layoutRecording;
      recording.stop();
      return { expected: recording.expected, samples: recording.samples };
    });
    await writeFile(
      path.join(evidence, `${label}.json`),
      JSON.stringify(result, null, 2),
    );
    expect(result.samples.length).toBeGreaterThan(6);
    expect(
      result.samples.every(
        (sample) => JSON.stringify(sample) === JSON.stringify(result.expected),
      ),
    ).toBe(true);
    checks.push(
      `${label}: every frame and resize observation preserves the viewport and sidebar layout.`,
    );
  };
  await expect(page.locator(".app")).toBeVisible({ timeout: 20000 });
  await expect(page.locator("html")).not.toHaveAttribute("data-startup", /.+/, {
    timeout: 20000,
  });
  await idle();
  await assertTopEdge("top-edge-light");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await assertTopEdge("top-edge-dark");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await page.evaluate(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const motion = animate.apply(this, args);
      if (args[1]?.id?.startsWith("sfmcl-t-window-")) {
        window.__heldWindowMotion = motion;
        motion.pause();
      }
      return motion;
    };
  });
  const finishMotion = () =>
    page.evaluate(() => window.__heldWindowMotion.finish());
  for (const width of [864, 851, 850]) {
    const scale = await page.evaluate(() => devicePixelRatio);
    await native("Resize", {
      width: Math.round(width * scale),
      height: Math.round(591 * scale),
    });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    // Let intentional responsive layout animations finish before recording.
    await page.waitForTimeout(400);
    const original = await geometry();
    await beginRecording();
    await page.getByRole("button", { name: "最小化窗口", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-window-motion",
      "minimize",
    );
    const outgoing = await native();
    expect(outgoing.rendering).toBe(1);
    expect(outgoing.corners).toBe(1);
    expect(outgoing.shadowVisible).toBe(false);
    expect(outgoing.width).toBe(outgoing.clientWidth);
    expect(outgoing.height).toBe(outgoing.clientHeight);
    await finishMotion();
    await expect
      .poll(() => invoke("plugin:window|is_minimized", { label: "main" }))
      .toBe(true);
    await native("Restore");
    await expect(page.locator("html")).toHaveAttribute(
      "data-window-motion",
      "show",
    );
    const incoming = await native();
    expect(incoming.rendering).toBe(1);
    expect(incoming.corners).toBe(1);
    expect(incoming.shadowVisible).toBe(false);
    await finishMotion();
    await idle();
    expect(await geometry()).toEqual(original);
    await assertStable(`minimize-restore-${width}`);
    await assertTopEdge(`top-edge-restored-${width}`);
  }
  await native("Move");
  const moved = await geometry();
  await native("Minimize");
  await expect(page.locator("body")).toHaveCSS("opacity", "0");
  await native("Restore");
  await expect(page.locator("html")).toHaveAttribute(
    "data-window-motion",
    "show",
  );
  await beginRecording();
  await finishMotion();
  await idle();
  expect(await geometry()).toEqual(moved);
  await assertStable("system-restore-finish");
  await assertTopEdge("top-edge-system-restore");
  const normal = await geometry();
  await page.getByRole("button", { name: "最大化窗口", exact: true }).click();
  await expect
    .poll(() => invoke("plugin:window|is_maximized", { label: "main" }))
    .toBe(true);
  const maximized = await geometry();
  await page.getByRole("button", { name: "最小化窗口", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-window-motion",
    "minimize",
  );
  await finishMotion();
  await expect
    .poll(() => invoke("plugin:window|is_minimized", { label: "main" }))
    .toBe(true);
  await native("Restore");
  await expect(page.locator("html")).toHaveAttribute(
    "data-window-motion",
    "show",
  );
  await finishMotion();
  await idle();
  await expect
    .poll(() => invoke("plugin:window|is_maximized", { label: "main" }))
    .toBe(true);
  expect(await geometry()).toEqual(maximized);
  await page.getByRole("button", { name: "还原窗口", exact: true }).click();
  await expect
    .poll(() => invoke("plugin:window|is_maximized", { label: "main" }))
    .toBe(false);
  expect(await geometry()).toEqual(normal);
  await assertTopEdge("top-edge-unmaximized");
  checks.push(
    "Maximize, minimize/restore and unmaximize preserve the maximized viewport and the original client geometry.",
  );
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const motion = animate.apply(this, args);
      if (args[1]?.id === "sfmcl-t-startup-reveal") {
        window.__heldStartup = motion;
        motion.pause();
      }
      return motion;
    };
  });
  // Hold the app import so activation is exercised on the transparent logo
  // screen, before the main window reveal can restore its shadow.
  let releaseMain;
  const mainReady = new Promise((resolve) => {
    releaseMain = resolve;
  });
  const mainModule = /\/src\/main\.tsx(?:\?.*)?$/;
  await page.route(mainModule, async (route) => {
    await mainReady;
    await route.continue();
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  try {
    await expect(page.locator("html")).toHaveAttribute(
      "data-startup",
      "loading",
    );
    await expect(page.locator(".startup-icon-main")).toBeVisible();
    await native("Minimize");
    await native("Restore");
    const loading = await native("TopEdge", undefined, "startup-activated");
    expect(loading.rendering).toBe(1);
    expect(loading.width).toBe(loading.clientWidth);
    expect(loading.height).toBe(loading.clientHeight);
    expect(loading.topInset).toBe(0);
    expect(loading.leftColor).toBe("0,0,0");
    expect(loading.rightColor).toBe("0,0,0");
    checks.push(
      "Restoring the startup logo keeps DWM enabled and the transparent top row free of a native titlebar or frame.",
    );
  } finally {
    releaseMain();
  }
  await expect(page.locator("html")).toHaveAttribute(
    "data-startup",
    "revealing",
    { timeout: 20000 },
  );
  await page.unroute(mainModule);
  await native("Minimize");
  await native("Restore");
  expect((await native()).rendering).toBe(1);
  await beginRecording();
  await page.evaluate(() => {
    window.__heldStartup.currentTime =
      window.__heldStartup.effect.getTiming().duration / 2;
  });
  await assertSurfaceCorners(
    page,
    "#root",
    path.join(evidence, "startup-rounded-mid.png"),
  );
  await page.evaluate(() => window.__heldStartup.finish());
  await expect(page.locator("html")).not.toHaveAttribute("data-startup");
  await idle();
  await assertStable("startup-finish");
  await assertTopEdge("top-edge-startup");
  checks.push(
    "External shadow follows move/resize/restore, stays outside the client, cannot take mouse input or focus, and hides during motion and maximization.",
    "Native rounding stays disabled while hiding/restoring the shadow, and CSS preserves four transparent pixel-stepped corners during startup and window motion.",
  );
  await writeFile(
    path.join(evidence, "checks.json"),
    JSON.stringify({ checks }, null, 2),
  );
  console.log(JSON.stringify({ checks }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  if (launcher.exitCode === null) launcher.kill();
}
