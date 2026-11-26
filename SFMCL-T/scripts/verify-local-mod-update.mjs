import { chromium, expect } from "@playwright/test";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";

const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 850, height: 600 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(pixelAppFixture);
  await page.addInitScript(resourceCenterFixture);
  await page.addInitScript(() => {
    const state = window.__pixelTest;
    const invoke = window.__TAURI_INTERNALS__.invoke;
    state.updateResponse = "available";
    let plans = 0;
    let jobs = 0;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const op = args?.operation;
      if (
        command !== "request" ||
        ![
          "resources.checkModUpdate",
          "resources.modUpdatePlan",
          "resources.install",
        ].includes(op)
      )
        return invoke(command, args);
      state.requests.push(structuredClone(args));
      if (op === "resources.checkModUpdate") {
        await state.checkGate;
        await new Promise((r) => setTimeout(r, 150));
        if (state.updateResponse === "error") throw new Error("网络超时");
        return {
          status: state.updateResponse,
          token: "check",
          current: "1.0",
          version: "2.0",
          source: "curseforge",
          changelog: "<p>修复启动问题</p>",
        };
      }
      if (op === "resources.modUpdatePlan") {
        const token = `plan-${++plans}`;
        await state.previewGate;
        return {
          token,
          warnings: ["以下实例共用 mods 目录，更新将影响：A、B"],
          issues: [],
          items: [
            {
              name: "Fabric API",
              main: false,
              version: "0.92",
              status: "install",
              projectId: "lib",
            },
            {
              name: "Library",
              main: false,
              version: "1.0",
              status: "disabled",
              path: "mods/.disabled/lib.jar",
              projectId: "disabled",
            },
          ],
        };
      }
      await state.installGate;
      const id = `update-job-${++jobs}`;
      const item = state.resources.localItems["1.20.1-Fabric"].mod[0];
      state.tasks.jobs.unshift({
        id,
        modUpdatePath: item.path,
        title: "更新模组",
        status: "running",
        currentStep: 0,
        steps: [
          { name: "下载模组与前置", detail: "正在下载模组", status: "running" },
        ],
        log: [],
      });
      return id;
    };
  });
  const calls = (op) =>
    page.evaluate(
      (op) => window.__pixelTest.requests.filter((r) => r.operation === op),
      op,
    );
  const button = (name) => page.getByRole("button", { name, exact: true });
  const detail = button("1.20.1-Fabric Sodium 详情");
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "版本管理", exact: true })
    .click();
  await button("查看 1.20.1-Fabric 本地资源").click();
  await expect(detail).toBeVisible();
  await button("刷新").click();
  await detail.click();
  const header = page.locator(".local-resource-page .resource-subpage-header");
  const checkUpdate = header.getByRole("button", { name: "更新", exact: true });
  await expect(checkUpdate).toBeVisible();
  const detailsCard = page.locator(
    ".local-resource-page .resource-subpage-body",
  );
  const updateCard = page.locator(".local-resource-page .local-mod-update");
  const installButton = updateCard.locator(".local-mod-install-button");
  await expect(updateCard).toHaveCount(0);
  for (const op of [
    "resources.localProject",
    "resources.checkModUpdate",
    "resources.modUpdatePlan",
    "resources.install",
  ])
    expect(await calls(op)).toHaveLength(0);
  await checkUpdate.evaluate((element) => {
    element.click();
    element.click();
  });
  await expect(button("正在检查…")).toBeDisabled();
  const panel = page.getByRole("region", { name: "可用模组更新" });
  await expect(panel).toContainText("1.0 → 2.0");
  await expect(panel).toContainText("修复启动问题");
  await expect(panel).toContainText("CurseForge");
  await expect(
    detailsCard.getByRole("button", { name: "打开所在目录", exact: true }),
  ).toBeVisible();
  await expect(detailsCard.locator(".world-details")).toContainText("文件大小");
  await expect(
    page.locator(".resource-subpage-body + .local-mod-update > .surface-frame"),
  ).toHaveCount(1);
  for (const width of [375, 850]) {
    await page.setViewportSize({ width, height: 600 });
    const [titleBox, buttonBox, detailsBox, updateBox] = await Promise.all([
      header.locator(".page-title").boundingBox(),
      checkUpdate.boundingBox(),
      detailsCard.boundingBox(),
      updateCard.boundingBox(),
    ]);
    expect(buttonBox.x).toBeGreaterThan(titleBox.x + titleBox.width);
    expect(buttonBox.y + buttonBox.height / 2).toBeCloseTo(
      titleBox.y + titleBox.height / 2,
      0,
    );
    expect(buttonBox.x + buttonBox.width).toBeCloseTo(
      detailsBox.x + detailsBox.width,
    );
    expect(buttonBox.y + buttonBox.height).toBeLessThan(detailsBox.y);
    expect(updateBox.y).toBeGreaterThan(detailsBox.y + detailsBox.height);
    expect(updateBox.x).toBeCloseTo(detailsBox.x);
    expect(updateBox.width).toBeCloseTo(detailsBox.width);
    const installBox = await installButton.boundingBox();
    const padding = await updateCard.evaluate((card) => ({
      top: parseFloat(getComputedStyle(card).paddingTop),
      right: parseFloat(getComputedStyle(card).paddingRight),
    }));
    expect(installBox.y).toBeCloseTo(updateBox.y + padding.top, 0);
    expect(installBox.x + installBox.width).toBeCloseTo(
      updateBox.x + updateBox.width - padding.right,
      0,
    );
  }
  const checks = await calls("resources.checkModUpdate");
  expect(checks).toHaveLength(1);
  expect(checks[0].payload.versionId).toBe("1.20.1-Fabric");
  expect(checks[0].payload.path).toMatch(/mods\/test\.jar$/);
  expect(await calls("resources.modUpdatePlan")).toHaveLength(0);
  // Cancel a slow preview at the one-second boundary, then start another
  // before the discarded preview returns.
  await page.evaluate(() => {
    const state = window.__pixelTest;
    state.previewGate = new Promise((resolve) => {
      state.releasePreview = resolve;
    });
  });
  await installButton.hover();
  const time = new Date();
  await page.clock.install({ time });
  await page.clock.pauseAt(new Date(time.getTime() + 1000));
  await installButton.click({ force: true });
  await expect(installButton).toHaveAccessibleName("正在检查前置…");
  await page.clock.runFor(999);
  await expect(installButton).toBeDisabled();
  await installButton.evaluate((element) => element.click());
  await page.clock.runFor(1);
  await expect(installButton).toHaveAccessibleName("取消");
  await page.clock.resume();
  const cancelLabel = installButton.locator(".local-mod-install-cancel");
  for (const reducedMotion of ["no-preference", "reduce"]) {
    await page.emulateMedia({ reducedMotion });
    for (const hover of [false, true]) {
      await expect(cancelLabel).toHaveCSS("opacity", hover ? "0" : "1");
      if (hover) await installButton.hover();
      else await page.mouse.move(0, 0);
      const transitions = await cancelLabel.evaluate((element) =>
        element
          .getAnimations()
          .map((animation) => [
            animation.transitionProperty,
            animation.effect.getTiming().duration,
          ])
          .sort(),
      );
      expect(transitions).toEqual([
        ["opacity", 220],
        ["transform", 220],
      ]);
      await expect(installButton).toHaveAccessibleName(
        hover ? "取消" : "正在检查前置…",
      );
    }
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await button("取消").click();
  await expect(installButton).toHaveAccessibleName("下载安装");
  await page.evaluate(() => {
    window.__pixelTest.previewGate = undefined;
  });
  await installButton.click();
  await expect(installButton).toHaveAccessibleName("等待确认");
  await page.evaluate(() => window.__pixelTest.releasePreview());
  await expect
    .poll(() => calls("resources.discardInstallPlan"))
    .toMatchObject([{ payload: { token: "plan-1" } }]);
  await expect(panel).toContainText("新增必需前置 · Fabric API");
  await expect(panel).toContainText("启用已有前置 · Library");
  await expect(panel).toContainText("更新将影响：A、B");
  const confirmInstall = panel.getByRole("button", {
    name: "确认安装",
    exact: true,
  });
  for (const width of [375, 850]) {
    await page.setViewportSize({ width, height: 600 });
    const [confirmBox, installBox, sourceBox] = await Promise.all([
      confirmInstall.boundingBox(),
      installButton.boundingBox(),
      panel.locator(".resource-source-badge").boundingBox(),
    ]);
    expect(confirmBox.y).toBeCloseTo(installBox.y, 0);
    expect(confirmBox.x + confirmBox.width).toBeLessThan(installBox.x);
    expect(
      sourceBox.x + sourceBox.width <= confirmBox.x ||
        sourceBox.y >= confirmBox.y + confirmBox.height,
    ).toBe(true);
  }
  await confirmInstall.focus();
  await page.keyboard.press("Tab");
  await expect(installButton).toBeFocused();
  await expect(installButton).toHaveAccessibleName("取消");
  await page.keyboard.press("Enter");
  await expect(installButton).toHaveAccessibleName("下载安装");
  expect(await calls("resources.install")).toHaveLength(0);
  expect(await calls("resources.discardInstallPlan")).toHaveLength(2);
  const notifications = page.getByRole("region", { name: "通知" });
  for (const [mode, message] of [
    ["error", "检查失败，可重试"],
    ["unidentified", "未识别到发布来源"],
    ["noCompatibleRelease", "没有更新的兼容正式版"],
    ["latest", "已是最新兼容版本"],
  ]) {
    await page.evaluate((mode) => {
      window.__pixelTest.updateResponse = mode;
    }, mode);
    await button("更新").click();
    const toast = notifications
      .getByRole("button")
      .filter({ hasText: message });
    await expect(
      toast.getByRole(mode === "error" ? "alert" : "status"),
    ).toBeVisible();
    if (mode === "error") await expect(toast).toContainText("网络超时");
    await expect(page.locator(".local-resource-page")).not.toContainText(
      message,
    );
    await toast.click();
    await expect(toast).toHaveCount(0);
    await expect(updateCard).toHaveCount(0);
  }
  // A late result from a hidden detail page must not surface over another page.
  await page.evaluate(() => {
    const state = window.__pixelTest;
    state.checkGate = new Promise((resolve) => {
      state.releaseCheck = resolve;
    });
  });
  await button("更新").click();
  await expect(button("正在检查…")).toBeDisabled();
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "开始游戏", exact: true }).click();
  await page.evaluate(() => window.__pixelTest.releaseCheck());
  await expect(
    page.locator('.local-resource-page button[aria-busy="true"]'),
  ).toHaveCount(0);
  await expect(notifications.getByText("已是最新兼容版本")).toHaveCount(0);
  await nav.getByRole("button", { name: "版本管理", exact: true }).click();
  await page.evaluate(() => {
    window.__pixelTest.updateResponse = "available";
  });
  async function startInstall() {
    await button("更新").click();
    await expect(panel).toContainText("1.0 → 2.0");
    await button("下载安装").click();
    await button("确认安装").click();
  }
  await startInstall();
  await expect(installButton).toHaveAccessibleName("下载模组与前置");
  await installButton.hover();
  await expect(installButton).toHaveAccessibleName("取消");
  await installButton.click();
  await expect(updateCard).toContainText("模组更新已取消");
  expect(await calls("jobs.cancel")).toMatchObject([
    { payload: { id: "update-job-1" } },
  ]);
  // A cancellation during startup must reach this job once its ID exists.
  await page.evaluate(() => {
    const state = window.__pixelTest;
    state.installGate = new Promise((resolve) => {
      state.releaseInstall = resolve;
    });
  });
  await startInstall();
  await expect(installButton).toHaveAccessibleName("正在准备安装…");
  await installButton.hover();
  await expect(installButton).toHaveAccessibleName("取消");
  await installButton.click();
  await expect(installButton).toHaveAccessibleName("正在取消…");
  expect(await calls("jobs.cancel")).toHaveLength(1);
  await page.evaluate(() => window.__pixelTest.releaseInstall());
  await expect(updateCard).toContainText("模组更新已取消");
  expect(await calls("jobs.cancel")).toMatchObject([
    { payload: { id: "update-job-1" } },
    { payload: { id: "update-job-2" } },
  ]);
  await startInstall();
  await expect(installButton).toHaveAccessibleName("下载模组与前置");
  expect((await calls("resources.install"))[0].payload.enablePaths).toEqual([
    "mods/.disabled/lib.jar",
  ]);
  await page.evaluate(() => {
    const state = window.__pixelTest;
    state.resources.localItems["1.20.1-Fabric"].mod[0].version = "2.0";
    state.tasks.jobs[0].status = "completed";
  });
  await expect(page.locator(".world-details")).toContainText("2.0");
  await expect(page.locator(".local-resource-page")).toContainText(
    "模组更新完成",
  );
  await button("返回上一级").click();
  await expect(detail).toContainText("2.0");
  expect(await calls("resources.checkModUpdate")).toHaveLength(9);
  expect(errors).toEqual([]);
  console.log(
    "Passed local mod update browsing, manual checks, confirmation, cancellation and refresh.",
  );
} finally {
  await browser.close();
}
