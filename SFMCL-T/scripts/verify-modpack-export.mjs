import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("evidence/modpack-export");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 800 } });
const errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(() => {
  const base = window.__TAURI_INTERNALS__.invoke;
  const state = window.__pixelTest;
  state.exportCalls = [];
  state.exportDraft = null;
  state.saveDestination = "C:/Exports/整合包.mrpack";
  state.exportScanPaused = true;
  state.exportDelay = 0;
  state.exportChanged = false;
  state.exportMotion = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (frames, options) {
    if (
      options?.id?.startsWith("sfmcl-t-export-back") ||
      (options?.id === "sfmcl-t-resource-tab" &&
        this.classList.contains("export-stage-content"))
    ) {
      state.exportMotion.push({
        id: options.id,
        duration: options.duration,
        frames: structuredClone(frames),
      });
    }
    return animate.call(this, frames, options);
  };
  state.data.settings.onboardingVersion = 1;
  const files = [
    { path: "mods/platform.jar", size: 1024, modified: "1", selected: true },
    { path: "mods/custom.jar", size: 2048, modified: "1", selected: true },
    { path: "config/中文.json", size: 64, modified: "1", selected: true },
    {
      path: "kubejs/server_scripts/main.js",
      size: 128,
      modified: "1",
      selected: true,
    },
    {
      path: "mods/off.jar.disabled",
      size: 2048,
      modified: "1",
      selected: false,
    },
    { path: "saves/世界/level.dat", size: 512, modified: "1", selected: false },
  ];
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "plugin:dialog|save") {
      state.exportCalls.push({ operation: "save", options: args.options });
      return state.saveDestination;
    }
    if (command !== "request" || !args.operation.startsWith("modpacks.export."))
      return base(command, args);
    const { operation, payload } = args;
    state.exportCalls.push({ operation, payload: structuredClone(payload) });
    if (operation === "modpacks.export.inspect") {
      if (state.exportScanPaused) {
        await new Promise((resolve) => (state.resumeExportScan = resolve));
        state.resumeExportScan = null;
      }
      return {
        token: `scan-${state.exportCalls.length}`,
        gameDirectory: "C:/Pixel-Test/Minecraft/.minecraft/versions/1.21.4",
        minecraft: "1.21.4",
        loader: { kind: "Fabric", version: "0.16.14" },
        shared: false,
        files,
        warnings: ["已排除运行资源、个人配置和临时文件。"],
        draft: state.exportDraft,
      };
    }
    if (operation === "modpacks.export.saveDraft") {
      state.exportDraft = payload.draft;
      return true;
    }
    if (operation === "modpacks.export.discard") return true;
    if (operation === "modpacks.export.plan") {
      if (state.exportDelay)
        await new Promise((resolve) => setTimeout(resolve, state.exportDelay));
      if (state.exportChanged)
        throw new Error("文件已变化，请重新扫描：config/中文.json");
      const items = payload.paths.map((path) => ({
        path,
        size: files.find((file) => file.path === path).size,
        method:
          path === "mods/platform.jar" ||
          payload.downloads.some((value) => value.path === path)
            ? "reference"
            : path === "mods/custom.jar" && !payload.directPaths.includes(path)
              ? "unresolved"
              : "embedded",
        project: path === "mods/platform.jar" ? "42" : null,
        version: path === "mods/platform.jar" ? "99" : null,
        reason: path === "mods/custom.jar" ? "未找到准确的平台版本" : "已检查",
      }));
      const issues = items
        .filter((item) => item.method === "unresolved")
        .map((item) => `需要处理：${item.path}`);
      return {
        token: issues.length ? null : `plan-${state.exportCalls.length}`,
        items,
        issues,
        warnings: [],
        totalSize: items.reduce((sum, item) => sum + item.size, 0),
        embeddedSize: items
          .filter((item) => item.method === "embedded")
          .reduce((sum, item) => sum + item.size, 0),
        manifest:
          payload.format === "modrinth"
            ? {
                formatVersion: 1,
                name: payload.options.name,
                dependencies: {
                  minecraft: "1.21.4",
                  "fabric-loader": "0.16.14",
                },
              }
            : {
                manifestType: "minecraftModpack",
                name: payload.options.name,
                minecraft: {
                  version: "1.21.4",
                  modLoaders: [{ id: "fabric-0.16.14", primary: true }],
                },
              },
      };
    }
    if (operation === "modpacks.export.start") {
      const id = `export-${state.exportCalls.length}`;
      state.tasks.jobs.push({
        id,
        title: "导出整合包",
        status: "running",
        currentStep: 1,
        steps: ["校验源文件", "生成整合包", "校验导出文件", "保存整合包"].map(
          (name, index) => ({
            name,
            status: index === 1 ? "running" : "queued",
            detail: "",
          }),
        ),
        log: [],
      });
      return id;
    }
    if (operation === "modpacks.export.reveal") return true;
    throw new Error(`Unexpected export operation: ${operation}`);
  };
});

async function finishPausedScan() {
  const indicator = page.getByText("正在扫描游戏目录…", { exact: true });
  const tabs = page.getByRole("tablist", { name: "整合包制作步骤" });
  const saveDraft = page.getByRole("button", {
    name: /^(配置已保存|保存制作配置)$/,
  });
  await page.waitForFunction(() => !!window.__pixelTest.resumeExportScan);
  await expect(indicator).toBeVisible();
  await expect(tabs).toHaveCount(0);
  await expect(saveDraft).toHaveCount(0);
  await page.evaluate(() => window.__pixelTest.resumeExportScan());
  await expect(indicator).toHaveCount(0);
  await expect(tabs).toBeVisible();
  await expect(saveDraft).toBeVisible();
}

try {
  await page.goto(process.env.SFMCL_T_TEST_URL || "http://127.0.0.1:1420");
  await page.getByRole("button", { name: "版本管理", exact: true }).click();
  await page.getByRole("button", { name: "管理 1.21.4", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("group", { name: "整合包操作" })
    .getByRole("button", { name: "导出", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "制作整合包", exact: true }),
  ).toBeVisible();
  await finishPausedScan();
  await page.evaluate(() => {
    window.__pixelTest.exportScanPaused = false;
  });
  await expect(
    page.getByRole("textbox", { name: "整合包名称", exact: true }),
  ).toHaveValue("1.21.4");
  await expect(page.getByRole("radio")).toHaveCount(2);
  const stage = (name) => page.getByRole("tab", { name, exact: true });
  const back = () => page.getByRole("button", { name: "上一步", exact: true });
  await expect(back()).toHaveCount(0);
  await expect(
    page.getByRole("tablist", { name: "整合包制作步骤" }).getByRole("tab"),
  ).toHaveCount(4);
  await stage("选择内容").click();
  await expect(stage("选择内容")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toHaveAccessibleName("选择内容");
  await expect(back()).toBeVisible();
  await stage("保存整合包").click();
  await expect(
    page.getByRole("heading", { name: "保存整合包", exact: true, level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "选择位置并导出", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        window.__pixelTest.exportCalls.filter(
          (call) =>
            call.operation === "modpacks.export.start" ||
            call.operation === "save",
        ).length,
    ),
  ).toBe(0);
  await stage("基本信息").click();
  await expect(back()).toHaveCount(0);
  await expect(page.locator(".export-back button")).toHaveCount(0);
  await stage("基本信息").focus();
  await page.keyboard.press("ArrowRight");
  await expect(stage("选择内容")).toBeFocused();
  await expect(stage("选择内容")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(stage("保存整合包")).toBeFocused();
  await expect(stage("保存整合包")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(stage("基本信息")).toBeFocused();
  await expect(stage("基本信息")).toHaveAttribute("aria-selected", "true");
  await stage("导出检查").click();
  await expect(
    page.getByRole("checkbox", {
      name: "确认直接打包 mods/custom.jar",
      exact: true,
    }),
  ).toBeVisible();
  await stage("基本信息").click();
  await expect(page.getByRole("radio")).toHaveCount(2);
  await page.evaluate(() => {
    const tab = (name) =>
      [...document.querySelectorAll('.export-stages [role="tab"]')].find(
        (button) => button.textContent.includes(name),
      );
    tab("选择内容").click();
  });
  await stage("保存整合包").click();
  await stage("基本信息").click();
  await expect(page.locator(".export-back button")).toHaveCount(0);
  await expect(page.locator(".export-stage-content .export-panel")).toHaveCount(
    1,
  );
  const layoutGap = await page.evaluate(() => {
    const tabs = document
      .querySelector(".export-stages")
      .getBoundingClientRect();
    const panel = document
      .querySelector(".export-stage-content .export-panel")
      .getBoundingClientRect();
    return panel.top - tabs.bottom;
  });
  expect(layoutGap).toBeGreaterThanOrEqual(14);
  expect(layoutGap).toBeLessThanOrEqual(24);
  const motion = await page.evaluate(() => window.__pixelTest.exportMotion);
  expect(
    motion.some(
      (value) => value.id === "sfmcl-t-resource-tab" && value.duration >= 240,
    ),
  ).toBe(true);
  expect(
    motion.some(
      (value) => value.id === "sfmcl-t-export-back-in" && value.duration >= 240,
    ),
  ).toBe(true);
  expect(
    motion.some(
      (value) =>
        value.id === "sfmcl-t-export-back-out" && value.duration >= 240,
    ),
  ).toBe(true);
  expect(
    motion.some(
      (value) =>
        value.id === "sfmcl-t-export-back-space" &&
        value.frames.at(-1).width === "0px",
    ),
  ).toBe(true);
  checks.push(
    "All four stage tabs navigate directly, including a save preview before export; keyboard arrows/Home/End select and focus tabs; stage slides and back-button entrance/exit retain full motion; cards have a consistent vertical gap.",
  );
  await page
    .getByRole("textbox", { name: "整合包名称", exact: true })
    .fill("中文整合包");
  await page
    .getByRole("textbox", { name: "整合包版本", exact: true })
    .fill("2.0.0");
  await page
    .getByRole("textbox", { name: "作者", exact: true })
    .fill("测试作者");
  await page.getByRole("button", { name: "保存制作配置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "配置已保存", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${evidence}/metadata-light.png` });
  checks.push(
    "The version management entry opens a dedicated page with only Modrinth and CurseForge; metadata can be saved.",
  );
  await page.getByRole("button", { name: "选择内容", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "mods/platform.jar", exact: false }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "mods/off.jar.disabled", exact: false }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "saves/世界/level.dat", exact: false }),
  ).not.toBeChecked();
  await page
    .getByRole("textbox", { name: "搜索导出文件", exact: true })
    .fill("中文");
  await expect(
    page.getByRole("checkbox", { name: "config/中文.json", exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "mods/platform.jar", exact: false }),
  ).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "搜索导出文件", exact: true })
    .fill("");
  await page.getByRole("button", { name: "检查导出内容", exact: true }).click();
  await expect(
    page.getByRole("checkbox", {
      name: "确认直接打包 mods/custom.jar",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "保存整合包", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "确认直接打包 mods/custom.jar",
      exact: true,
    })
    .check();
  await expect(
    page.getByText("内容或处理方式已修改，请重新检查后导出。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "重新检查", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存整合包", exact: true }),
  ).toBeEnabled();
  checks.push(
    "Disabled mods and worlds are optional; search works; unmatched resources require a choice and a fresh plan before export.",
  );
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expect(page.locator(".export-summary")).toBeVisible();
  await page.screenshot({ path: `${evidence}/review-dark.png` });
  await page.setViewportSize({ width: 850, height: 600 });
  expect(
    await page
      .locator(".modpack-export-page")
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  await page.screenshot({ path: `${evidence}/review-minimum.png` });
  await page.setViewportSize({ width: 1120, height: 800 });
  await page.evaluate(() => {
    window.__pixelTest.saveDestination = null;
  });
  await page.getByRole("button", { name: "保存整合包", exact: true }).click();
  await page
    .getByRole("button", { name: "选择位置并导出", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "选择位置并导出", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    window.__pixelTest.saveDestination = "C:/Exports/整合包.mrpack";
  });
  await page
    .getByRole("button", { name: "选择位置并导出", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "取消导出", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "取消导出", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "导出已取消", exact: true }),
  ).toBeVisible();
  checks.push(
    "Cancelling the native save dialog preserves the plan; background exports show tasks and support cancellation.",
  );
  await page.getByRole("button", { name: "再次导出", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存整合包", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "上一步", exact: true }).click();
  await page.getByRole("button", { name: "上一步", exact: true }).click();
  await page.getByRole("radio", { name: "CurseForge", exact: false }).check();
  await page.getByRole("button", { name: "选择内容", exact: true }).click();
  await page.getByRole("button", { name: "检查导出内容", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存整合包", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    window.__pixelTest.saveDestination = "C:/Exports/整合包.zip";
  });
  await page.getByRole("button", { name: "保存整合包", exact: true }).click();
  await page
    .getByRole("button", { name: "选择位置并导出", exact: true })
    .click();
  await page.evaluate(() => {
    const job = window.__pixelTest.tasks.jobs.at(-1);
    job.status = "completed";
    job.steps.forEach((step) => {
      step.status = "completed";
    });
  });
  await expect(
    page.getByRole("button", { name: "打开所在文件夹", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "打开所在文件夹", exact: true })
    .click();
  expect(
    await page.evaluate(
      () =>
        window.__pixelTest.exportCalls
          .filter((call) => call.operation === "save")
          .at(-1).options.filters[0].extensions,
    ),
  ).toEqual(["zip"]);
  checks.push(
    "Switching formats rebuilds the plan and saves with .zip; completion reveals the exported file by job ID.",
  );
  await page.getByRole("button", { name: "再次导出", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存整合包", exact: true }),
  ).toBeEnabled();
  await stage("保存整合包").click();
  await expect(
    page.getByRole("heading", { name: "保存整合包", exact: true, level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "整合包已导出", exact: true }),
  ).toHaveCount(0);
  await back().click();
  await page.evaluate(() => {
    window.__pixelTest.exportChanged = true;
  });
  await page.getByRole("button", { name: "重新检查", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "文件已变化" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "保存整合包", exact: true }),
  ).toBeDisabled();
  checks.push(
    "Source changes invalidate export and require a rescan; light, dark and minimum desktop layouts have no horizontal overflow.",
  );
  await page.evaluate(() => {
    window.__pixelTest.exportChanged = false;
    window.__pixelTest.exportScanPaused = true;
  });
  await page
    .getByRole("button", { name: "重新扫描", exact: true })
    .first()
    .click();
  await finishPausedScan();
  checks.push(
    "The stage tabs and draft action are hidden during the initial scan and a rescan, then return after the indicator exits.",
  );
  await expect(
    page.getByRole("button", { name: "重新检查", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    window.__pixelTest.exportDelay = 1200;
  });
  await page.getByRole("button", { name: "重新检查", exact: true }).click();
  await expect(back()).toHaveCount(0);
  await expect(page.locator(".export-back button")).toHaveCount(0);
  await page.getByRole("button", { name: "取消检查", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存整合包", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("请重新扫描后继续。", { exact: false }),
  ).toBeVisible();
  checks.push(
    "Cancelling source recognition invalidates the pending preview and requires a fresh scan.",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
