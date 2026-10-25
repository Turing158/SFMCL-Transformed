import { runtimePath } from "./lib/paths.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Run only against the isolated migration verification desktop.
const browser = await chromium.connectOverCDP(
  process.env.SFMCL_T_CDP || "http://127.0.0.1:9422",
);
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15_000);
const invoke = (operation, payload = {}) =>
  page.evaluate(
    ({ operation, payload }) =>
      window.__TAURI_INTERNALS__.invoke("request", { operation, payload }),
    { operation, payload },
  );
const original = await invoke("bootstrap");
if (
  !path
    .resolve(original.dataDir)
    .startsWith(runtimePath() + path.sep)
) {
  throw new Error(
    "Use SFMCL_T_DATA_DIR inside this workspace's .runtime directory for verification",
  );
}
await mkdir(runtimePath("evidence"), { recursive: true });
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(String(error)));
const nav = (name) =>
  name === "下载中心"
    ? page.locator(".sidebar-task").click()
    : name === "角色管理"
      ? page.locator(".sidebar .profile-button").click()
      : page
          .getByRole("navigation", { name: "主导航" })
          .getByRole("button", { name, exact: true })
          .click();
const save = async (settings) => {
  await invoke("settings.save", settings);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
};
const stamp = Date.now().toString().slice(-7);
let player;
try {
  await save({ ...original.settings, downloadTaskDisplay: "always" });
  await nav("角色管理");
  await page.getByRole("button", { name: "离线登录", exact: true }).click();
  await page.getByRole("textbox", { name: "角色名称" }).fill(`QA_${stamp}`);
  await page.getByRole("button", { name: "创建角色", exact: true }).click();
  await expect(page.locator(".players-page")).not.toHaveAttribute("data-login");
  player = (await invoke("players.list")).find((p) => p.name === `QA_${stamp}`);
  expect(player).toBeTruthy();
  await page.getByRole("button", { name: "更改名称", exact: true }).click();
  await page.getByRole("textbox", { name: "新的名称" }).fill(`QA_R${stamp}`);
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  player = (await invoke("players.list")).find(
    (p) => p.name === `QA_R${stamp}`,
  );
  expect(player).toBeTruthy();
  const skin = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const c = canvas.getContext("2d");
    c.fillStyle = "#e5484d";
    c.fillRect(8, 8, 8, 8);
    c.fillStyle = "#3e63dd";
    c.fillRect(20, 20, 8, 12);
    c.fillStyle = "#30a46c";
    c.fillRect(44, 20, 4, 12);
    c.fillRect(36, 52, 4, 12);
    c.fillStyle = "#ffe629";
    c.fillRect(4, 20, 4, 12);
    c.fillRect(20, 52, 4, 12);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const skinPath = path.join(original.dataDir, "qa-skin.png");
  await writeFile(skinPath, Buffer.from(skin, "base64"));
  await invoke("players.skin", {
    id: player.uuid,
    path: skinPath,
    slim: false,
  });
  await page.reload();
  await nav("角色管理");
  await expect
    .poll(() =>
      page
        .locator(".skin-body")
        .evaluate((c) =>
          Array.from(c.getContext("2d").getImageData(5, 2, 1, 1).data),
        ),
    )
    .toEqual([229, 72, 77, 255]);
  await expect
    .poll(() =>
      page
        .locator(".skin-body")
        .evaluate((c) =>
          Array.from(c.getContext("2d").getImageData(5, 10, 1, 1).data),
        ),
    )
    .toEqual([62, 99, 221, 255]);
  await page.getByRole("button", { name: "切换模型，当前经典模型" }).click();
  await expect
    .poll(
      async () =>
        (await invoke("players.list")).find((p) => p.uuid === player.uuid)
          ?.slim,
    )
    .toBe(true);
  await page.getByRole("button", { name: "重置皮肤" }).click();
  await expect
    .poll(
      async () =>
        (await invoke("players.list")).find((p) => p.uuid === player.uuid)
          ?.skin,
    )
    .toBe("");
  checks.push(
    "UI offline account create/rename, PNG atlas head/body pixels, slim toggle and skin reset",
  );
  await nav("版本管理");
  await page.getByPlaceholder("搜索版本名称").fill("1.20.1");
  await expect(page.locator(".version-card").first()).toBeVisible();
  await page.getByRole("button", { name: "管理 1.20.1", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("版本名称");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  checks.push("Version filter, management dialog and Escape/focus dismissal");
  await nav("设置");
  await page.getByRole("tab", { name: "全局设置", exact: true }).click();
  await page
    .getByLabel("窗口标题", { exact: true })
    .fill("SFMCL-T UI Verification");
  await page
    .getByRole("button", { name: "保存设置", exact: true })
    .first()
    .click();
  await expect
    .poll(async () => (await invoke("bootstrap")).settings.windowTitle)
    .toBe("SFMCL-T UI Verification");
  await page.reload();
  await nav("设置");
  await page.getByRole("tab", { name: "全局设置", exact: true }).click();
  await expect(page.getByLabel("窗口标题", { exact: true })).toHaveValue(
    "SFMCL-T UI Verification",
  );
  checks.push("Settings edit/save survives frontend reload");
  await nav("资源中心");
  await page.getByRole("tab", { name: "模组", exact: true }).click();
  if (!(await page.getByLabel("游戏版本", { exact: true }).isVisible()))
    await page.getByRole("button", { name: /^筛选/ }).click();
  await page.getByLabel("搜索资源", { exact: true }).fill("sodium");
  await page.getByLabel("游戏版本", { exact: true }).fill("1.20.1");
  await page.getByRole("combobox", { name: /^加载器/ }).click();
  await page.getByRole("option", { name: "Fabric", exact: true }).click();
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.locator(".catalog-project").first()).toBeVisible({
    timeout: 45_000,
  });
  await page
    .locator(".catalog-project-info")
    .filter({ has: page.getByRole("heading", { name: /^Sodium\b/ }) })
    .first()
    .click();
  await page.getByRole("tab", { name: /^可下载版本/ }).click();
  await expect(page.locator(".project-file").first()).toBeVisible({
    timeout: 45_000,
  });
  await page.screenshot({
    path: runtimePath("evidence/resource-files.png"),
    animations: "disabled",
  });
  await page
    .getByRole("navigation", { name: "页面路径" })
    .getByRole("button", { name: "返回上一级", exact: true })
    .click();
  checks.push(
    "Live Modrinth search, Minecraft/Fabric filters, project details and compatible file list",
  );
  await nav("下载中心");
  if (await page.locator(".job-card").count()) {
    await page
      .locator(".job-card")
      .first()
      .getByRole("button", { name: /查看 .* 日志/ })
      .click();
    await expect(page.locator(".log-view")).toBeVisible();
    await page.keyboard.press("Escape");
    checks.push("Task steps and process log dialog");
  }
  const routes = [
    ["开始游戏", "home"],
    ["角色管理", "players"],
    ["版本管理", "versions"],
    ["资源中心", "resources"],
    ["下载中心", "downloads"],
    ["设置", "settings"],
  ];
  for (const theme of ["light", "dark"]) {
    await save({ ...(await invoke("bootstrap")).settings, theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const [label, slug] of routes) {
      await nav(label);
      await page.screenshot({
        path: runtimePath(`evidence/${slug}-${theme}.png`),
        animations: "disabled",
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await nav("角色管理");
  expect(
    await page
      .locator("main")
      .evaluate((e) => getComputedStyle(e).animationName),
  ).toBe("page-enter");
  for (const width of [375, 768, 850, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    for (const [label] of routes) {
      await nav(label);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${label} at ${width}`,
      ).toBe(true);
    }
    await page.screenshot({
      path: runtimePath(`evidence/layout-${width}.png`),
      animations: "disabled",
    });
  }
  checks.push(
    "All six pages in light/dark; no document overflow at 375/768/850/1024/1440; animations remain enabled with reduced-motion preference (D2)",
  );
  expect(errors).toEqual([]);
} finally {
  if (player) await invoke("players.remove", { id: player.uuid });
  await save(original.settings);
  await page.setViewportSize({ width: 1220, height: 800 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await writeFile(
    runtimePath("evidence/desktop-checks.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  await browser.close();
  console.log(JSON.stringify({ checks, errors }, null, 2));
}
