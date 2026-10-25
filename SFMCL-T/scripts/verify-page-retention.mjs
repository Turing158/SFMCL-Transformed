import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";
import { playersFixture } from "./fixtures/players.mjs";
import { answerConfirmation } from "./lib/confirmation.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("evidence/page-retention");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 740 } });
page.setDefaultTimeout(8000);
const checks = [],
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture, { components: true });
await page.addInitScript(resourceCenterFixture);
await page.addInitScript(playersFixture);
await page.addInitScript(() => {
  window.__pixelTest.data.settings.showNotices = true;
  window.__pixelTest.tasks.jobs.push({
    id: "retained-job",
    title: "安装 Minecraft 1.21.4",
    status: "running",
    currentStep: 0,
    steps: [{ name: "下载文件", status: "running", detail: "" }],
    log: ["测试日志"],
  });
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "request" && args.operation === "notices.list") {
      window.__pixelTest.requests.push({ operation: args.operation });
      return Array.from({ length: 12 }, (_, i) => ({
        title: `测试公告 ${i + 1}`,
        source: `notice-${i}`,
        icon: "",
        content:
          "公告内容\n\n" + "保留公告的展开状态和页面滚动位置。\n\n".repeat(15),
      }));
    }
    const result = await invoke(command, args);
    if (
      command === "request" &&
      args.operation === "resources.files" &&
      args.payload.id === "AANobbMI"
    )
      return result.map((file) => ({
        ...file,
        dependencies: [
          { projectId: "project-1", name: "Fabric API", kind: "mod" },
        ],
      }));
    return result;
  };
});
const navigation = page.getByRole("navigation", { name: "主导航" });
const nav = (name) =>
  name === "角色管理"
    ? page.locator(".sidebar .profile-button").click()
    : navigation.getByRole("button", { name, exact: true }).click();
const path = page.getByRole("navigation", { name: "页面路径" });
const back = () =>
  path.getByRole("button", { name: "返回上一级", exact: true }).click();
const downloads = () => page.locator(".sidebar-task").click();
const count = (operation) =>
  page.evaluate(
    (operation) =>
      window.__pixelTest.requests.filter((r) => r.operation === operation)
        .length,
    operation,
  );
const check = (text) => {
  checks.push(text);
  console.log(`PASS ${text}`);
};
const select = async (label, option) => {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
};
const scrollPosition = () =>
  page.locator("main.page").evaluate((element) => element.scrollTop);
const setScroll = async (top) => {
  await page
    .locator("main.page")
    .evaluate((element, top) => element.scrollTo(0, top), top);
  await expect.poll(scrollPosition).toBeGreaterThan(0);
  // Let the browser deliver the scroll event before leaving the page.
  await page.waitForTimeout(100);
  return scrollPosition();
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  const notice = page.getByRole("button", { name: "测试公告 1", exact: true });
  await notice.click();
  await expect(notice).toHaveAttribute("aria-expanded", "true");
  await page.waitForTimeout(350);
  const homePosition = await setScroll(320);
  const noticeRequests = await count("notices.list");
  for (let i = 0; i < 3; i++) {
    await nav("版本管理");
    await nav("开始游戏");
    await expect(notice).toHaveAttribute("aria-expanded", "true");
    expect(await scrollPosition()).toBeCloseTo(homePosition, 0);
  }
  expect(await count("notices.list")).toBe(noticeRequests);
  check("开始游戏保留公告展开与滚动位置，反复切回不重新读取公告");

  await nav("版本管理");
  const versionQuery = page.getByRole("searchbox", {
    name: "搜索版本名称",
    exact: true,
  });
  await versionQuery.fill("Fabric");
  await nav("开始游戏");
  await nav("版本管理");
  await expect(versionQuery).toHaveValue("Fabric");
  await expect(
    page.getByRole("button", { name: "游戏设置 1.21.4", exact: true }),
  ).toHaveCount(0);
  await versionQuery.fill("");
  await page
    .getByRole("button", { name: "游戏设置 1.21.4", exact: true })
    .click();
  const independent = page.getByRole("switch", {
    name: "内存与游戏目录：独立设置",
    exact: true,
  });
  await independent.click();
  await page.getByRole("switch", { name: "自动分配内存", exact: true }).click();
  const memory = page.getByRole("spinbutton", {
    name: "内存 MB",
    exact: true,
  });
  await memory.fill("7168");
  const settingsReads = await count("versions.settings.get");
  await nav("资源中心");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await nav("版本管理");
  await expect(path.locator("strong")).toHaveText("1.21.4 · 游戏设置");
  await expect(memory).toHaveValue("7168");
  await downloads();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await back();
  await expect(memory).toHaveValue("7168");
  expect(await count("versions.settings.get")).toBe(settingsReads);
  await back();
  await answerConfirmation(page, false);
  await expect(memory).toHaveValue("7168");
  await back();
  await answerConfirmation(page, true);
  check("版本筛选与未保存设置在切页和下载往返中保留，明确返回才确认放弃修改");

  await page
    .getByRole("button", { name: "查看 1.21.4 本地资源", exact: true })
    .click();
  await select("查看资源的游戏版本", "1.20.1-Fabric");
  await page.getByRole("tab", { name: /^材质包/ }).click();
  const localSearch = page.getByRole("searchbox", {
    name: "搜索本地资源",
    exact: true,
  });
  await localSearch.fill("Faithful");
  const localRequests = await count("resources.local");
  await nav("设置");
  await nav("版本管理");
  await expect(path.locator("strong")).toHaveText("1.20.1-Fabric · 本地资源");
  await expect(page.getByRole("tab", { name: /^材质包/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(localSearch).toHaveValue("Faithful");
  expect(await count("resources.local")).toBe(localRequests);
  check("本地资源保留目标版本、资源分类与搜索内容");

  await nav("资源中心");
  await page.getByRole("tab", { name: "模组", exact: true }).click();
  await select("资源排序", "下载最多");
  const resourceSearch = page.getByRole("searchbox", {
    name: "搜索资源",
    exact: true,
  });
  await resourceSearch.fill("Sodium");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page
    .getByRole("button", { name: "查看 Sodium 详情", exact: true })
    .click();
  await page.getByRole("tab", { name: /可下载版本/ }).click();
  const gameVersion = page.getByRole("textbox", {
    name: "筛选游戏版本",
    exact: true,
  });
  await gameVersion.fill("1.20.1");
  await expect(page.locator("button.project-file").first()).toBeVisible();
  await page.waitForTimeout(450);
  const searches = await count("resources.search");
  const files = await count("resources.files");
  await nav("开始游戏");
  await nav("资源中心");
  await expect(path.locator("strong")).toHaveText("Sodium");
  await expect(gameVersion).toHaveValue("1.20.1");
  expect(await count("resources.files")).toBe(files);
  await back();
  await expect(resourceSearch).toHaveValue("Sodium");
  await expect(
    page.getByRole("combobox", { name: "资源排序", exact: true }),
  ).toContainText("下载最多");
  expect(await count("resources.search")).toBe(searches);
  await page.getByRole("combobox", { name: "资源排序", exact: true }).click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await nav("开始游戏");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.locator(".brand-home").focus();
  await page.keyboard.press("Control+k");
  await expect(page.locator(".brand-home")).toBeFocused();
  await nav("资源中心");
  await page.keyboard.press("Control+k");
  await expect(resourceSearch).toBeFocused();
  check("资源详情、文件筛选和列表筛选保留；隐藏页下拉菜单与快捷键停用");

  // Resource Center and Versions can each retain their own project detail.
  await page
    .getByRole("button", { name: "查看 Sodium 详情", exact: true })
    .click();
  await page.getByRole("tab", { name: /可下载版本/ }).click();
  await gameVersion.fill("1.21.4");
  await expect(
    page.locator("main.page button.project-file").first(),
  ).toBeVisible();
  await page.waitForTimeout(450);
  await nav("版本管理");
  await page.getByRole("tab", { name: /^模组/ }).click();
  await localSearch.fill("Sodium");
  await page
    .getByRole("button", { name: "1.20.1-Fabric Sodium 详情", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "1.20.1-Fabric Sodium 的 Modrinth 详情",
      exact: true,
    })
    .click();
  const ownedProject = page.locator(
    '[data-page="versions"][data-view="resources"]',
  );
  const centerProject = page.locator(
    '[data-page="resources"][data-view="resources"]',
  );
  await expect(ownedProject).toBeVisible();
  await expect(path.locator("strong")).toHaveText("1.20.1-Fabric Sodium");
  await expect(
    navigation.getByRole("button", { name: "版本管理", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("tab", { name: /可下载版本/ }).click();
  const ownedVersion = ownedProject.getByRole("textbox", {
    name: "筛选游戏版本",
    exact: true,
  });
  await ownedVersion.fill("1.19.4");
  await expect(
    ownedProject.locator("button.project-file").first(),
  ).toBeVisible();
  await page.waitForTimeout(450);
  const independentFiles = await count("resources.files");
  for (let visit = 0; visit < 3; visit++) {
    await nav("资源中心");
    await expect(centerProject).toBeVisible();
    await expect(ownedProject).toBeHidden();
    await expect(path.locator("strong")).toHaveText("Sodium");
    await expect(
      centerProject.getByRole("textbox", { name: "筛选游戏版本", exact: true }),
    ).toHaveValue("1.21.4");
    await expect(
      path.getByRole("button", { name: "返回上一级", exact: true }),
    ).toHaveAttribute("data-tooltip", "返回模组资源");
    await nav("版本管理");
    await expect(ownedProject).toBeVisible();
    await expect(centerProject).toBeHidden();
    await expect(path.locator("strong")).toHaveText("1.20.1-Fabric Sodium");
    await expect(ownedVersion).toHaveValue("1.19.4");
  }
  expect(await count("resources.files")).toBe(independentFiles);
  await ownedProject.locator("button.project-file").first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "查看 Fabric API 资源页面", exact: true })
    .click();
  await expect(ownedProject.locator(".resource-subpage-header h1")).toHaveText(
    "Fabric API",
  );
  await expect(path.locator("strong")).toHaveText("Fabric API");
  await downloads();
  await back();
  await expect(path.locator("strong")).toHaveText("Fabric API");
  await nav("资源中心");
  await expect(path.locator("strong")).toHaveText("Sodium");
  await nav("版本管理");
  await expect(path.locator("strong")).toHaveText("Fabric API");
  await back();
  await expect(ownedVersion).toHaveValue("1.19.4");
  await back();
  await expect(page.locator(".local-resource-page")).toBeVisible();
  await expect(path.locator("strong")).toHaveText("1.20.1-Fabric Sodium");
  await back();
  await expect(localSearch).toHaveValue("Sodium");
  await nav("资源中心");
  await expect(path.locator("strong")).toHaveText("Sodium");
  await expect(gameVersion).toHaveValue("1.21.4");
  await back();
  await expect(resourceSearch).toHaveValue("Sodium");
  check(
    "版本管理与资源中心各自保留模组详情、导航和筛选，反复切换互不覆盖；前置模组及下载往返继续归属版本管理，返回恢复本地列表状态",
  );

  await nav("设置");
  await page.getByRole("tab", { name: "全局设置", exact: true }).click();
  const title = page.getByRole("textbox", { name: "窗口标题", exact: true });
  await title.fill("保留全局草稿");
  const settingsPosition = await setScroll(400);
  await nav("开始游戏");
  await nav("设置");
  await expect(
    page.getByRole("tab", { name: "全局设置", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(title).toHaveValue("保留全局草稿");
  expect(await scrollPosition()).toBeCloseTo(settingsPosition, 0);
  check("设置保留当前分类、未保存输入及滚动位置");

  await nav("角色管理");
  await page.locator('[data-player-login="offline"]').click();
  const playerName = page.getByRole("textbox", {
    name: "角色名称",
    exact: true,
  });
  await playerName.fill("Remember_Name");
  await nav("开始游戏");
  await nav("角色管理");
  await expect(path.locator("strong")).toHaveText("离线登录");
  await expect(playerName).toHaveValue("Remember_Name");
  await back();
  check("角色管理保留登录子页面与角色名称输入");

  await downloads();
  const downloadFilter = page.getByRole("tab", { name: /^已完成/ });
  await downloadFilter.click();
  await nav("开始游戏");
  await downloads();
  await expect(downloadFilter).toHaveAttribute("aria-selected", "true");
  await expect(
    path.getByRole("button", { name: "返回上一级", exact: true }),
  ).toHaveAttribute("data-tooltip", "返回开始游戏");
  // Switch programmatically to verify a modal leaves the browser's top layer.
  await page
    .getByRole("button", {
      name: "查看 安装 Minecraft 1.21.4 日志",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await navigation
    .getByRole("button", { name: "开始游戏", exact: true })
    .evaluate((button) => button.click());
  await expect(dialog).toBeHidden();
  await downloads();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await back();
  await expect(path.locator("strong")).toHaveText("开始游戏");
  check(
    "下载中心保留筛选与日志，隐藏页面移除模态遮罩，返回指向本次进入前的页面",
  );

  expect(errors).toEqual([]);
  await page.screenshot({ path: `${evidence}/retained-home.png` });
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` });
  throw error;
} finally {
  await browser.close();
}
