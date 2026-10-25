import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runtimePath, projectPath } from "./lib/paths.mjs";

const evidence = runtimePath("players-implementation/3d");
const browser = await chromium.connectOverCDP(
  process.env.SFMCL_T_CDP || "http://127.0.0.1:9463",
);
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
const invoke = (operation, payload = {}) =>
  page.evaluate(
    ({ operation, payload }) =>
      window.__TAURI_INTERNALS__.invoke("request", { operation, payload }),
    { operation, payload },
  );
const boot = await invoke("bootstrap");
if (
  path.resolve(boot.dataDir).toLowerCase() !==
  path.resolve(evidence, "desktop-data").toLowerCase()
)
  throw new Error("Requires this test's isolated desktop-data directory");
const ui = page.locator(".players-page");
const figure = ui.locator(".players-figure");
const checks = [],
  measurements = {},
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const execFileAsync = promisify(execFile);
const processId = Number(
  await readFile(path.join(evidence, "desktop-pid.txt"), "utf8"),
);
const sample = async (label) => {
  const started = Date.now();
  const start = await page.evaluate(() => window.__player3d?.renders || 0);
  const before = await page.evaluate(() => performance.memory?.usedJSHeapSize);
  const [native] = await Promise.all([
    execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      projectPath("scripts/sample-player-3d.ps1"),
      "-RootProcessId",
      String(processId),
      "-Seconds",
      "10",
    ]),
    page.waitForTimeout(10000),
  ]);
  return {
    native: JSON.parse(native.stdout),
    label,
    seconds: (Date.now() - started) / 1000,
    renders:
      (await page.evaluate(() => window.__player3d?.renders || 0)) - start,
    heapBefore: before,
    heapAfter: await page.evaluate(() => performance.memory?.usedJSHeapSize),
  };
};
try {
  await mkdir(evidence, { recursive: true });
  if (!boot.players.length) await invoke("players.add", { name: "Preview3D" });
  const player = (await invoke("bootstrap")).players[0];
  const skinPath = path.join(evidence, "desktop-skin.png");
  const localSkin = await page.evaluate(async () => {
    const image = new Image();
    image.src = "/assets/steve.png";
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0, 64, 64);
    return canvas.toDataURL().split(",")[1];
  });
  await writeFile(skinPath, Buffer.from(localSkin, "base64"));
  await invoke("players.skin", {
    id: player.uuid,
    path: skinPath,
    slim: false,
  });
  await page.reload();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-startup",
    /loading|revealing/,
  );
  await page.locator(".sidebar .profile-button").click();
  await expect(ui).toBeVisible();
  measurements.twoD = await sample("existing 2D");
  await ui.locator(".players-facing").click();
  const firstEntry = Date.now();
  await ui.locator(".players-facing").click();
  await expect(figure).toHaveAttribute("data-preview-status", "ready");
  measurements.firstEntryMs = Date.now() - firstEntry;
  const gpu = await ui.locator(".players-3d-canvas").evaluate((canvas) => {
    const gl = canvas.getContext("webgl2");
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      renderer: info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL),
      vendor: info && gl.getParameter(info.UNMASKED_VENDOR_WEBGL),
      attributes: gl.getContextAttributes(),
      buffer: [canvas.width, canvas.height],
      dpr: devicePixelRatio,
    };
  });
  measurements.gpu = gpu;
  measurements.onDemand = await sample("on-demand 3D");
  expect(measurements.onDemand.renders).toBe(0);
  await page.screenshot({ path: `${evidence}/desktop-grove.png` });
  await ui.locator(".players-facing").click();
  await page.evaluate(
    async ({ width, height, skin }) => {
      const { SkinViewer } =
        await import("/node_modules/.vite/deps/skinview3d.js");
      const canvas = document.createElement("canvas");
      canvas.style.cssText =
        "position:fixed;width:200px;height:280px;left:300px;top:170px;z-index:20";
      document.body.append(canvas);
      window.__defaultBenchmark = new SkinViewer({
        canvas,
        width,
        height,
        pixelRatio: 1,
        skin,
        model: "default",
      });
      window.__defaultCalls = 0;
      const renderer = window.__defaultBenchmark.renderer;
      const render = renderer.render.bind(renderer);
      renderer.render = (...args) => {
        window.__defaultCalls++;
        return render(...args);
      };
    },
    {
      width: gpu.buffer[0],
      height: gpu.buffer[1],
      skin: await invoke("image", {
        path: (await invoke("bootstrap")).players[0].skin,
      }),
    },
  );
  const calls = await page.evaluate(() => window.__defaultCalls);
  const nativeDefault = await sample("default continuous 3D");
  measurements.default3D = {
    seconds: nativeDefault.seconds,
    native: nativeDefault.native,
    renders: (await page.evaluate(() => window.__defaultCalls)) - calls,
    heap: await page.evaluate(() => performance.memory?.usedJSHeapSize),
  };
  await page.evaluate(() => {
    const viewer = window.__defaultBenchmark;
    viewer.composer.dispose();
    viewer.fxaaPass.material.dispose();
    viewer.dispose();
    viewer.scene.traverse((object) => {
      object.geometry?.dispose();
      for (const material of object.material
        ? Array.isArray(object.material)
          ? object.material
          : [object.material]
        : [])
        material.dispose();
    });
    viewer.renderer.forceContextLoss();
    viewer.canvas.remove();
    delete window.__defaultBenchmark;
  });
  checks.push(
    "Same WebView2 samples compare 2D, default continuous skinview3d and the on-demand adapter",
  );
  await ui.locator(".players-facing").click();
  await ui.locator(".players-facing").click();
  await expect(figure).toHaveAttribute("data-preview-status", "ready");
  await ui.locator(".players-model").click();
  await page.evaluate(async () => {
    const { invalidateImages } = await import("/src/images.ts");
    invalidateImages();
  });
  // Trigger the ordinary store refresh through a benign page re-entry.
  await page.reload();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-startup",
    /loading|revealing/,
  );
  await page.locator(".sidebar .profile-button").click();
  await ui.locator(".players-facing").click();
  await ui.locator(".players-facing").click();
  await expect(figure).toHaveAttribute("data-preview-status", "ready");
  await expect(ui.locator(".players-model")).toHaveText("纤细模型");
  checks.push(
    "Real Rust image command loads an isolated local PNG and explicit slim model in WebView2",
  );
  await ui.locator(".players-view-switch").click();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-player-view-transition",
  );
  await page.screenshot({ path: `${evidence}/desktop-gallery.png` });
  for (let i = 0; i < 20; i++) {
    await ui.locator(".players-facing").click();
    await expect
      .poll(() => page.evaluate(() => window.__player3d.active))
      .toBe(0);
    await ui.locator(".players-facing").click();
    await ui.locator(".players-facing").click();
    await expect(figure).toHaveAttribute("data-preview-status", "ready");
  }
  measurements.lifecycle = await page.evaluate(() => ({
    ...window.__player3d,
  }));
  expect(measurements.lifecycle.maxActive).toBe(1);
  checks.push(
    "20 native mode round trips release the viewer; both scene layouts render and capture the transparent preview",
  );
  await ui.locator(".players-facing").click();
  await expect
    .poll(() => page.evaluate(() => window.__player3d.active))
    .toBe(0);
  measurements.afterExit = await sample("2D after 20 viewer round trips");
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/desktop-report.json`,
    JSON.stringify(
      { checks, errors, measurements, webviewVersion: browser.version() },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks, measurements }, null, 2));
} finally {
  await page
    .getByRole("button", { name: "关闭窗口", exact: true })
    .click()
    .catch(() => {});
  await browser.close().catch(() => {});
}
