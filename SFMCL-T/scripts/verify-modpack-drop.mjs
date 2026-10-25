import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { runtimePath } from "./lib/paths.mjs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";

const evidence = runtimePath("evidence/modpack-drop");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 640 } });
const checks = [],
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(() => {
  const native = window.__TAURI_INTERNALS__;
  const base = native.invoke;
  const state = window.__pixelTest;
  const callbacks = new Map(),
    listeners = new Map();
  let nextCallback = 0,
    nextListener = 0,
    nextToken = 0;
  state.data.settings.showNotices = false;
  state.dropError = "";
  state.dropDelay = 0;
  native.transformCallback = (callback) => {
    const id = ++nextCallback;
    callbacks.set(id, callback);
    return id;
  };
  native.unregisterCallback = (id) => callbacks.delete(id);
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (_event, id) => {
      const listener = listeners.get(id);
      if (listener) callbacks.delete(listener.handler);
      listeners.delete(id);
    },
  };
  state.emitNative = (event, paths = []) => {
    for (const [id, listener] of listeners) {
      if (listener.event === event)
        callbacks.get(listener.handler)?.({
          event,
          id,
          payload: { paths, position: { x: 400, y: 240 } },
        });
    }
  };
  state.dragListeners = () =>
    [...listeners.values()].filter((listener) =>
      listener.event.startsWith("tauri://drag-"),
    ).length;
  native.invoke = async (command, args) => {
    if (command === "plugin:event|listen") {
      const id = ++nextListener;
      listeners.set(id, args);
      return id;
    }
    if (command === "plugin:event|unlisten") return;
    if (command === "request" && args.operation.startsWith("modpacks.")) {
      state.requests.push(structuredClone(args));
      if (args.operation === "modpacks.inspect") {
        if (state.dropDelay)
          await new Promise((resolve) => setTimeout(resolve, state.dropDelay));
        if (state.dropError) throw new Error(state.dropError);
        return {
          token: `drop-preview-${++nextToken}`,
          format: "Modrinth",
          name: "探索整合包",
          version: "1.0",
          minecraft: "1.20.1",
          loader: { kind: "Fabric", version: "0.16.9" },
          optionalFiles: ["mods/optional.jar"],
          fileCount: 2,
        };
      }
      return args.operation === "modpacks.install" ? "drop-job" : true;
    }
    return base(command, args);
  };
});
const emit = (event, paths = []) =>
  page.evaluate(
    ({ event, paths }) => window.__pixelTest.emitNative(event, paths),
    { event: `tauri://drag-${event}`, paths },
  );
const requests = (operation) =>
  page.evaluate(
    (operation) =>
      window.__pixelTest.requests
        .filter((request) => request.operation === operation)
        .map((request) => request.payload),
    operation,
  );
const nav = (name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const overlay = page.locator(".modpack-drop-overlay");
const dialog = page.locator(".modpack-install-dialog[open]");
const capture = (name) =>
  page.screenshot({
    path: `${evidence}/${name}.png`,
    animations: "disabled",
  });
const motionFrame = (event, kind, time, paths = []) =>
  page.evaluate(
    async ({ event, kind, time, paths }) => {
      window.__pixelTest.emitNative(`tauri://drag-${event}`, paths);
      for (let frame = 0; frame < 6; frame++) {
        await new Promise(requestAnimationFrame);
        const element = document.querySelector(".modpack-drop-overlay");
        const animation = element
          ?.getAnimations()
          .find((item) => item.id === `sfmcl-t-modpack-drop-${kind}`);
        if (!animation) continue;
        element.getAnimations({ subtree: true }).forEach((item) => {
          if (!item.id.startsWith("sfmcl-t-modpack-drop-")) return;
          item.pause();
          item.currentTime = time;
        });
        const transform = getComputedStyle(
          element.querySelector(".modpack-drop-content"),
        ).transform;
        return {
          opacity: Number(getComputedStyle(element).opacity),
          open: element.matches(":popover-open"),
          exiting: element.dataset.exiting === "true",
          title: element.querySelector("h2").textContent,
          duration: animation.effect.getTiming().duration,
          transform,
          offsetY: new DOMMatrix(transform).m42,
        };
      }
      throw new Error(`Missing ${kind} animation after drag-${event}`);
    },
    { event, kind, time, paths },
  );
const finishMotion = () =>
  overlay.evaluate((element) => {
    element.getAnimations({ subtree: true }).forEach((animation) => {
      if (animation.id.startsWith("sfmcl-t-modpack-drop-")) animation.finish();
    });
  });

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__pixelTest.dragListeners()))
    .toBe(4);
  await nav("设置");
  await emit("enter", ["C:/整合包/探索.mrpack"]);
  await expect(overlay.getByRole("heading")).toHaveText("松开以导入整合包");
  await expect(overlay).toContainText("探索.mrpack");
  expect(await requests("modpacks.inspect")).toEqual([]);
  expect(
    await overlay.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        element.matches(":popover-open") &&
        rect.x === 0 &&
        rect.y === 0 &&
        rect.width === innerWidth &&
        rect.height === innerHeight
      );
    }),
  ).toBe(true);
  await capture("hover-light");
  await emit("over");
  await expect(overlay).toBeVisible();
  await emit("leave");
  await expect(overlay).toHaveCount(0);
  expect(await requests("modpacks.inspect")).toEqual([]);
  checks.push(
    "Dragging over any page covers the full viewport; leaving cancels without inspecting.",
  );

  const entering = await motionFrame("enter", "enter", 90, [
    "C:/Packs/animated.mrpack",
  ]);
  expect(entering.open).toBe(true);
  expect(entering.opacity).toBeGreaterThan(0);
  expect(entering.opacity).toBeLessThan(0.75);
  expect(entering.offsetY).toBeGreaterThan(0);
  await page.screenshot({ path: `${evidence}/enter-midpoint.png` });
  await finishMotion();
  await expect(overlay).toHaveCSS("opacity", "0.75");
  const leaving = await motionFrame("leave", "exit", 90);
  expect(leaving.open).toBe(true);
  expect(leaving.exiting).toBe(true);
  expect(leaving.opacity).toBeGreaterThan(0);
  expect(leaving.opacity).toBeLessThan(0.75);
  expect(leaving.offsetY).toBeGreaterThan(0);
  await page.screenshot({ path: `${evidence}/exit-midpoint.png` });
  // Resume midway through exit: the same node reverses without jumping to 0.
  const resumed = await motionFrame("enter", "enter", 0, [
    "C:/Packs/resumed.mrpack",
  ]);
  expect(resumed.opacity).toBeCloseTo(leaving.opacity, 3);
  expect(resumed.transform).toBe(leaving.transform);
  expect(resumed.exiting).toBe(false);
  await finishMotion();
  await expect(overlay).toHaveCSS("opacity", "0.75");
  const settledExit = await motionFrame("leave", "exit", 0);
  expect(settledExit.opacity).toBe(0.75);
  await finishMotion();
  await expect(overlay).toHaveCount(0);
  expect(await requests("modpacks.inspect")).toEqual([]);
  checks.push(
    "Enter fades to 0.75; exit retains the popover until faded out, and rapid re-entry reverses smoothly.",
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  const systemEnter = await motionFrame("enter", "enter", 90, [
    "C:/Packs/system-preference.zip",
  ]);
  expect(systemEnter.duration).toBe(240);
  expect(systemEnter.opacity).toBeGreaterThan(0);
  expect(systemEnter.opacity).toBeLessThan(0.75);
  expect(systemEnter.offsetY).toBeGreaterThan(0);
  await finishMotion();
  await expect(overlay).toHaveCSS("opacity", "0.75");
  const systemExit = await motionFrame("leave", "exit", 90);
  expect(systemExit.duration).toBe(200);
  expect(systemExit.open).toBe(true);
  expect(systemExit.opacity).toBeGreaterThan(0);
  expect(systemExit.opacity).toBeLessThan(0.75);
  expect(systemExit.offsetY).toBeGreaterThan(0);
  await finishMotion();
  await expect(overlay).toHaveCount(0);
  checks.push(
    "System reduced-motion preference preserves the complete 240ms entry and 200ms exit animations.",
  );

  await page.evaluate(() => {
    window.__pixelTest.dropError = "未找到支持的整合包清单或完整客户端版本";
  });
  await emit("enter", ["C:/Downloads/普通压缩包.zip"]);
  await emit("drop", ["C:/Downloads/普通压缩包.zip"]);
  await expect(page.locator(".toast.error").first()).toContainText(
    "无法导入整合包：未找到支持的整合包清单",
  );
  await expect(dialog).toHaveCount(0);
  await expect(overlay).toHaveCount(0);
  expect(await requests("modpacks.install")).toEqual([]);
  await capture("unsupported-toast");
  checks.push(
    "Unsupported archive contents produce an error bubble and never open installation.",
  );

  const beforeMultiple = (await requests("modpacks.inspect")).length;
  await emit("enter", ["C:/Packs/a.zip", "C:/Packs/b.zip"]);
  await expect(overlay).toContainText("已拖入 2 个文件");
  await emit("drop", ["C:/Packs/a.zip", "C:/Packs/b.zip"]);
  await expect(page.locator(".toast.error").first()).toContainText(
    "请一次拖入一个整合包",
  );
  expect((await requests("modpacks.inspect")).length).toBe(beforeMultiple);
  checks.push("Multiple files are rejected together with a clear bubble.");

  await page.evaluate(() => {
    window.__pixelTest.dropError = "";
    window.__pixelTest.dropDelay = 800;
  });
  await emit("enter", ["C:/Packs/探索.mrpack"]);
  await emit("drop", ["C:/Packs/探索.mrpack"]);
  await expect(overlay.getByRole("heading")).toHaveText("正在校验整合包…");
  await expect(overlay.locator(".spin")).toHaveCSS("animation-name", "spin");
  await expect(overlay.locator(".spin")).toHaveCSS(
    "animation-play-state",
    "running",
  );
  await emit("leave");
  await expect(overlay).toHaveAttribute("data-phase", "checking");
  await emit("drop", ["C:/Packs/duplicate.zip"]);
  await capture("checking");
  await overlay.evaluate(async (element) => {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      const animation = element
        .getAnimations()
        .find((item) => item.id === "sfmcl-t-modpack-drop-exit");
      if (animation) {
        animation.pause();
        animation.currentTime = 90;
        return;
      }
      await new Promise(requestAnimationFrame);
    }
    throw new Error("Checking overlay did not start its exit animation");
  });
  await expect(dialog).toHaveCount(0);
  await expect(overlay).toHaveAttribute("data-phase", "checking");
  await expect(overlay).toHaveAttribute("data-exiting", "true");
  await expect(overlay.locator("h2")).toHaveText("正在校验整合包…");
  await emit("drop", ["C:/Packs/during-exit.zip"]);
  expect((await requests("modpacks.inspect")).length).toBe(beforeMultiple + 1);
  await finishMotion();
  await expect(dialog).toBeVisible();
  await expect(overlay).toHaveCount(0);
  expect((await requests("modpacks.inspect")).length).toBe(beforeMultiple + 1);
  await expect(dialog.getByLabel("整合包文件", { exact: true })).toHaveText(
    "C:/Packs/探索.mrpack",
  );
  await expect(
    dialog.getByRole("textbox", { name: "整合包游戏名称" }),
  ).toHaveValue("探索整合包 1.0");
  await expect(dialog.getByText("Modrinth", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "开始安装" })).toBeEnabled();
  expect(await requests("modpacks.discard")).toEqual([]);
  checks.push(
    "Drop inspects once, preserves the checking view through fade-out, then opens installation with its prepared token even in StrictMode.",
  );

  await emit("enter", ["C:/Packs/another.zip"]);
  expect(
    await overlay.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return element.matches(":popover-open") && rect.width === innerWidth;
    }),
  ).toBe(true);
  await capture("hover-over-dialog");
  await emit("drop", ["C:/Packs/another.zip"]);
  await expect(overlay).toHaveCount(0);
  expect((await requests("modpacks.inspect")).length).toBe(beforeMultiple + 1);
  await expect(dialog.getByLabel("整合包文件", { exact: true })).toHaveText(
    "C:/Packs/探索.mrpack",
  );
  checks.push(
    "Dragging covers an existing modal; another drop preserves its state and creates no second import.",
  );

  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => requests("modpacks.discard"))
    .toEqual([{ token: "drop-preview-1" }]);
  checks.push("Cancelling releases the prepared archive token exactly once.");

  await page.evaluate(() => {
    window.__pixelTest.dropDelay = 0;
    document.documentElement.dataset.theme = "dark";
  });
  await page.setViewportSize({ width: 850, height: 600 });
  await emit("enter", [
    "C:/Packs/" + "很长的整合包文件名".repeat(15) + ".mrpack",
  ]);
  await expect(overlay).toBeVisible();
  expect(
    await overlay.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .locator(".modpack-drop-filename")
      .evaluate(
        (element) =>
          element.scrollWidth > element.clientWidth &&
          getComputedStyle(element).textOverflow === "ellipsis",
      ),
  ).toBe(true);
  await capture("hover-dark-compact");
  await emit("drop", ["C:/Packs/client-directory"]);
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("checkbox", { name: "安装附加模组和材质包等等（1 个）" })
    .check();
  await dialog.getByRole("button", { name: "开始安装" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await requests("modpacks.install")).toEqual([
    {
      root: "C:/Pixel-Test/Minecraft",
      name: "探索整合包 1.0",
      includeOptional: true,
      token: "drop-preview-2",
    },
  ]);
  expect(await requests("modpacks.discard")).toEqual([
    { token: "drop-preview-1" },
  ]);
  checks.push(
    "Dark mode at minimum window size handles long names; install uses the prepared preview and optional selection.",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  await capture("failure");
  throw error;
} finally {
  await browser.close();
}
