import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("evidence/modpack-update/split-flow");
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
  const state = window.__pixelTest,
    base = window.__TAURI_INTERNALS__.invoke;
  state.data.settings.onboardingVersion = 1;
  state.updateCalls = [];
  state.match = "online";
  state.legacy = false;
  state.pending = false;
  state.autoFinish = true;
  state.discoveryFailure = false;
  const record = {
    instanceId: "instance",
    name: "测试整合包",
    version: "1",
    minecraft: "1.21.4",
    loader: { kind: "Fabric", version: "0.16.14" },
    origin: { source: "modrinth", projectId: "project", versionId: "current" },
    includeOptional: false,
  };
  const origin = (id) => ({
    source: state.platform || "modrinth",
    projectId: "project",
    versionId: id,
  });
  const job = (id, title) => {
    const status = state.autoFinish ? "completed" : "running";
    state.tasks.jobs.push({
      id,
      title,
      status,
      steps: [{ name: "检查", detail: "检查文件", status }],
      currentStep: 0,
      log: [],
    });
    return id;
  };
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (
      command !== "request" ||
      (!args.operation.startsWith("modpacks.") &&
        args.operation !== "jobs.cancel")
    )
      return base(command, args);
    const { operation, payload } = args;
    state.updateCalls.push({ operation, payload: structuredClone(payload) });
    if (operation === "jobs.cancel") return base(command, args);
    if (operation === "modpacks.update.info")
      return {
        record: state.legacy ? null : record,
        current: { name: "测试整合包", version: "1" },
        backups: state.pending
          ? [
              {
                id: "backup",
                state: "applying",
                path: "C:/Game/.tmcl/modpack-updates/backup",
                savesBackup: true,
              },
            ]
          : [],
      };
    if (operation === "modpacks.update.discover") {
      if (state.discoveryFailure) throw new Error("模拟网络失败");
      if (state.match === "local")
        return {
          status: "local",
          message: "未找到匹配的在线整合包，已进入本地更新。",
          currentOrigin: null,
          targetOrigin: null,
          current: null,
          target: null,
          includeOptional: false,
          inferOptional: false,
        };
      return {
        status: state.match,
        message:
          state.match === "upToDate"
            ? "当前已是最新正式版本。"
            : "已找到在线整合包，自动检查新版文件变化。",
        currentOrigin: origin("current"),
        targetOrigin: state.match === "upToDate" ? null : origin("new"),
        current: { id: "current", version: "1" },
        target: { id: "new", version: "2" },
        includeOptional: false,
        inferOptional: state.legacy,
      };
    }
    if (operation === "modpacks.inspect")
      return {
        token: "source-token",
        name: "测试整合包",
        version: "2",
        minecraft: "1.21.5",
        loader: null,
        format: "Modrinth",
        optionalFiles: [],
        fileCount: 3,
      };
    if (operation.endsWith(".discard")) return true;
    if (operation === "modpacks.update.prepare") {
      state.lastPrepare = structuredClone(payload);
      return job("check-" + state.updateCalls.length, "检查整合包更新");
    }
    if (operation === "modpacks.update.plan")
      return {
        token: payload.token,
        current: { version: "1", minecraft: "1.21.4", loader: "Fabric" },
        target: { ...record, version: "2", minecraft: "1.21.5" },
        baselineMissing:
          state.legacy &&
          !state.lastPrepare.currentOrigin &&
          !state.lastPrepare.currentToken,
        warnings: [
          "存档、个人选项和启动器设置保留；配置与脚本按文件处理冲突。",
        ],
        items: [
          {
            path: "config/中文.json",
            localPath: "config/中文.json",
            action: "conflict",
            conflict: true,
            reason: "双方均有修改",
          },
          {
            path: "mods/old.jar",
            localPath: "mods/old.jar",
            action: "remove",
            conflict: false,
            reason: "作者移除",
          },
          {
            path: "mods/new.jar",
            localPath: "mods/new.jar",
            action: "add",
            conflict: false,
            reason: "作者新增",
          },
        ],
      };
    if (operation === "modpacks.update.start")
      return job("apply-" + state.updateCalls.length, "更新整合包");
    if (operation === "modpacks.update.restore") {
      state.pending = false;
      return true;
    }
    throw new Error("Unexpected operation " + operation);
  };
});
async function open(options = {}) {
  await page.goto(process.env.SFMCL_T_TEST_URL || "http://127.0.0.1:1420");
  await page.evaluate(
    (options) => Object.assign(window.__pixelTest, options),
    options,
  );
  await page.getByRole("button", { name: "版本管理", exact: true }).click();
  await page.getByRole("button", { name: "管理 1.21.4", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "游戏设置", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "本地资源", exact: true }),
  ).toHaveCount(0);
  const packActions = dialog.getByRole("group", { name: "整合包操作" });
  await expect(packActions.getByRole("button")).toHaveCount(2);
  await packActions.getByRole("button", { name: "更新", exact: true }).click();
}
async function prepare() {
  await page.getByRole("button", { name: "检查文件变化", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "检查更新内容", exact: true }),
  ).toBeVisible();
}
async function resolveConflict() {
  await page
    .getByRole("combobox", { name: "处理 config/中文.json", exact: true })
    .click();
  await page.getByRole("option", { name: "保留本地", exact: true }).click();
}
async function theme(name) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "启动器设置", exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
  await page.getByRole("button", { name: "版本管理", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "检查更新内容", exact: true }),
  ).toBeVisible();
}
const calls = (operation) =>
  page.evaluate(
    (operation) =>
      window.__pixelTest.updateCalls.filter(
        (call) => call.operation === operation,
      ),
    operation,
  );
try {
  await open();
  await expect(
    page.getByRole("heading", { name: "检查更新内容", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tablist", { name: "在线整合包更新步骤" }).getByRole("tab"),
  ).toHaveCount(2);
  await expect(
    page.getByRole("textbox", { name: "项目 ID", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "选择新版整合包", exact: true }),
  ).toHaveCount(0);
  expect(await calls("modpacks.update.discover")).toHaveLength(1);
  expect(await calls("modpacks.update.prepare")).toHaveLength(1);
  expect((await calls("modpacks.update.prepare"))[0].payload.origin).toEqual({
    source: "modrinth",
    projectId: "project",
    versionId: "new",
  });
  expect(await calls("modpacks.inspect")).toHaveLength(0);
  checks.push(
    "进入页面自动在线匹配并直接检查变化，在线仅两步，没有手动来源字段或重复任务",
  );
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "开始更新", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "返回检查", exact: true }).click();
  await resolveConflict();
  await theme("深色");
  await page.locator(".update-file-list").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: evidence + "/online-dark.png",
    fullPage: true,
  });
  await theme("明亮");
  await page.locator(".update-file-list").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: evidence + "/online-light.png",
    fullPage: true,
  });
  await page.getByRole("tab", { name: "1 检查变化", exact: true }).focus();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("tab", { name: "2 确认更新", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "开始更新", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "开始更新", exact: true }).click();
  await expect(page.getByText("整合包更新完成", { exact: true })).toBeVisible();
  expect((await calls("modpacks.update.start"))[0].payload.decisions).toEqual({
    "config/中文.json": "keep",
  });
  checks.push(
    "在线直接检查仍要求处理冲突，实际主题切换、键盘导航、确认更新正常",
  );
  await open({ match: "upToDate" });
  await expect(
    page.getByRole("heading", { name: "当前已是最新正式版本" }),
  ).toBeVisible();
  expect(await calls("modpacks.update.prepare")).toHaveLength(0);
  await page.getByRole("button", { name: "从本地包更新", exact: true }).click();
  await expect(
    page.getByRole("tablist", { name: "本地整合包更新步骤" }).getByRole("tab"),
  ).toHaveCount(3);
  checks.push("已是最新版时不下载或创建检查任务，可主动切换三步本地更新");
  await open({ match: "local" });
  await expect(
    page.getByRole("heading", { name: "选择目标整合包版本" }),
  ).toBeVisible();
  await expect(
    page.getByRole("tablist", { name: "本地整合包更新步骤" }).getByRole("tab"),
  ).toHaveCount(3);
  await expect(
    page.getByRole("combobox", { name: "更新来源", exact: true }),
  ).toHaveCount(0);
  expect(await calls("modpacks.update.prepare")).toHaveLength(0);
  await page.evaluate(() => {
    window.__pixelTest.pickedDirectory = "C:/Downloads/new.mrpack";
  });
  await page
    .getByRole("button", { name: "选择新版整合包", exact: true })
    .click();
  await prepare();
  const local = (await calls("modpacks.update.prepare"))[0].payload;
  expect(local.token).toBe("source-token");
  expect(local.origin).toBeUndefined();
  await page.setViewportSize({ width: 850, height: 600 });
  await page.locator(".update-file-list").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: evidence + "/local-small.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  checks.push("未找到在线时自动进入本地三步，手动选包、检查和窄窗口布局正常");
  await open({ discoveryFailure: true });
  await expect(
    page.getByRole("heading", { name: "选择目标整合包版本" }),
  ).toBeVisible();
  await expect(
    page.getByText("在线查询暂时不可用，已进入本地更新；可重新检查在线版本。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.__pixelTest.discoveryFailure = false;
    window.__pixelTest.platform = "curseforge";
  });
  await page
    .getByRole("button", { name: "重新检查在线版本", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "检查更新内容", exact: true }),
  ).toBeVisible();
  expect(
    (await calls("modpacks.update.prepare"))[0].payload.origin.source,
  ).toBe("curseforge");
  checks.push("在线查询失败可继续本地，并可重试后自动进入 CurseForge 检查变化");
  await open({ legacy: true });
  await expect(
    page.getByRole("heading", { name: "检查更新内容", exact: true }),
  ).toBeVisible();
  const recovered = (await calls("modpacks.update.prepare"))[0].payload;
  expect(recovered.currentOrigin.versionId).toBe("current");
  expect(recovered.inferOptional).toBe(true);
  await expect(
    page.getByRole("button", { name: "选择当前版本原始包", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "另存新实例", exact: true }),
  ).not.toBeChecked();
  checks.push(
    "旧实例找到在线时自动下载当前版本恢复清单，无需手选旧包或强制另存",
  );
  await open({ autoFinish: false });
  await expect(
    page.getByRole("button", { name: "取消任务", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "取消任务", exact: true }).click();
  await expect(page.getByText("更新检查已取消", { exact: true })).toBeVisible();
  expect(await calls("modpacks.update.start")).toHaveLength(0);
  await page.getByRole("button", { name: "从本地包更新", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "选择目标整合包版本" }),
  ).toBeVisible();
  checks.push("自动在线检查可取消，取消后可切换本地且不会自动提交更新");
  await open({ legacy: true, pending: true, match: "local" });
  await expect(
    page.getByRole("button", { name: "恢复", exact: true }),
  ).toBeVisible();
  expect(await calls("modpacks.update.discover")).toHaveLength(0);
  await page.getByRole("button", { name: "恢复", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await expect(
    page.getByText("已恢复更新前的整合包文件", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.__pixelTest.pickedDirectory = "C:/Downloads/new.mrpack";
  });
  await page
    .getByRole("button", { name: "选择新版整合包", exact: true })
    .click();
  await prepare();
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "另存新实例", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "另存新实例", exact: true }),
  ).toBeDisabled();
  checks.push(
    "存在恢复记录时不自动查找或下载，未匹配的旧实例仍保留本地迁移保护",
  );
  expect(errors).toEqual([]);
  await writeFile(
    evidence + "/verified.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: evidence + "/failure.png", fullPage: true });
  await writeFile(evidence + "/failure.txt", String(error));
  throw error;
} finally {
  await browser.close();
}
