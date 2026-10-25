import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { playersFixture } from "./fixtures/players.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";
import { answerConfirmation } from "./lib/confirmation.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("evidence/confirmations");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 640 } });
page.setDefaultTimeout(8000);
const errors = [];
const nativeDialogs = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", async (dialog) => {
  nativeDialogs.push(dialog.type());
  await dialog.dismiss();
});
await page.addInitScript({
  content: `(${pixelAppFixture.toString()})({ components: true });
    (${playersFixture.toString()})();
    (${resourceCenterFixture.toString()})();`,
});
await page.addInitScript(() => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__confirmationTest = {
    native: [],
    motions: [],
    animations: [],
    holdExit: false,
  };
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (...args) {
    const animation = animate.apply(this, args);
    if (this.classList.contains("confirmation-dialog")) {
      window.__confirmationTest.motions.push(args[1]?.id);
      window.__confirmationTest.animations.push(animation);
      if (window.__confirmationTest.holdExit && args[1]?.id?.includes("exit"))
        animation.pause();
    }
    return animation;
  };
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (
      command.startsWith("plugin:dialog|") &&
      command !== "plugin:dialog|open"
    ) {
      window.__confirmationTest.native.push(command);
      throw new Error(`Unexpected native confirmation: ${command}`);
    }
    if (command === "request" && args.operation === "versions.delete") {
      window.__pixelTest.requests.push({
        operation: args.operation,
        payload: args.payload,
      });
      return true;
    }
    return invoke(command, args);
  };
});
const dialog = page.getByRole("dialog", { name: "确认操作", exact: true });
const button = (name) => page.getByRole("button", { name, exact: true });
const count = (operation) =>
  page.evaluate(
    (op) =>
      window.__pixelTest.requests.filter((request) => request.operation === op)
        .length,
    operation,
  );
const check = (message) => {
  checks.push(message);
  console.log(`PASS ${message}`);
};
const go = async (name) => {
  expect(
    await page.evaluate(() => window.__confirmationTest?.native ?? []),
  ).toEqual([]);
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  if (name === "角色管理") {
    await page.locator(".sidebar .profile-button").click();
  } else {
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true })
      .click();
  }
};
const assertOpen = async (message, operation) => {
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(message);
  await expect(
    dialog.getByRole("button", { name: "取消", exact: true }),
  ).toBeFocused();
  expect(await count(operation)).toBe(0);
};

try {
  await go("角色管理");
  const removePlayer = button("移除 Steve");
  for (const method of ["cancel", "escape", "close", "backdrop", "enter"]) {
    await removePlayer.click();
    await assertOpen(
      "移除角色 Steve？此操作不会删除游戏存档。",
      "players.remove",
    );
    if (method === "cancel") await answerConfirmation(page, false);
    else if (method === "escape") await page.keyboard.press("Escape");
    else if (method === "close")
      await dialog.getByRole("button", { name: "关闭对话框" }).click();
    else if (method === "backdrop") await page.mouse.click(4, 4);
    else await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(removePlayer).toBeEnabled();
    await expect(removePlayer).toBeFocused();
    expect(await count("players.remove")).toBe(0);
  }
  check(
    "Cancel, Escape, close, backdrop and default Enter preserve the player and restore focus",
  );
  await removePlayer.click();
  await page.evaluate(() => {
    window.__confirmationTest.holdExit = true;
  });
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(dialog).toHaveAttribute("data-closing", "true");
  expect(await count("players.remove")).toBe(0);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    window.__confirmationTest.animations
      .filter((animation) => animation.playState === "paused")
      .forEach((animation) => animation.finish()),
  );
  await expect(removePlayer).toHaveCount(0);
  expect(await count("players.remove")).toBe(1);
  expect(await page.evaluate(() => window.__confirmationTest.motions)).toEqual(
    expect.arrayContaining([
      "sfmcl-t-modal-enter",
      "sfmcl-t-modal-exit",
      "sfmcl-t-modal-backdrop-exit",
    ]),
  );
  check(
    "Acceptance waits for the existing exit animation and executes once under repeated keyboard input",
  );

  await go("版本管理");
  await button("移除目录记录").click();
  await assertOpen(
    "从列表中移除此目录？磁盘上的游戏文件会保留。",
    "settings.save",
  );
  await answerConfirmation(page, false);
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.gameDirs.length),
  ).toBe(1);
  await button("移除目录记录").click();
  await answerConfirmation(page, true);
  await expect.poll(() => count("settings.save")).toBe(1);
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.gameDirs),
  ).toEqual([]);
  check("Removing a game directory requires confirmation");

  await go("版本管理");
  await button("管理 1.21.4").click();
  const management = page.getByRole("dialog", {
    name: "管理 1.21.4",
    exact: true,
  });
  const deleteVersion = management.getByRole("button", {
    name: "删除版本",
    exact: true,
  });
  await deleteVersion.click();
  await assertOpen(
    "删除版本 1.21.4 及其版本目录？开启隔离时，此目录可能包含存档与模组，请先备份。",
    "versions.delete",
  );
  await expect(page.locator("dialog[open]")).toHaveCount(2);
  for (const [theme, accent, width, height] of [
    ["light", "forest", 1120, 640],
    ["dark", "puce", 850, 600],
    ["dark", "ebony", 375, 667],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(
      ({ theme, accent }) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.accent = accent;
      },
      { theme, accent },
    );
    await expect(dialog).toBeInViewport();
    expect(
      await dialog.evaluate((node) => node.scrollWidth > node.clientWidth),
    ).toBe(false);
    await dialog.screenshot({
      path: `${evidence}/nested-${theme}-${accent}-${width}.png`,
      animations: "disabled",
    });
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(management).toBeVisible();
  await expect(deleteVersion).toBeFocused();
  expect(await count("versions.delete")).toBe(0);
  await page.setViewportSize({ width: 1120, height: 640 });
  await deleteVersion.click();
  await answerConfirmation(page, true);
  await expect(management).toHaveCount(0);
  expect(await count("versions.delete")).toBe(1);
  check(
    "Nested version confirmation keeps the management dialog usable; themes and narrow screens fit",
  );

  await go("版本管理");
  await button("游戏设置 1.21.4").click();
  const independent = page.getByRole("switch", {
    name: "内存与游戏目录：独立设置",
    exact: true,
  });
  await independent.click();
  const back = page
    .getByRole("navigation", { name: "页面路径" })
    .getByRole("button", { name: "返回上一级", exact: true });
  await back.click();
  await assertOpen(
    "此版本有尚未保存的游戏设置，放弃修改并返回？",
    "versions.settings.save",
  );
  await answerConfirmation(page, false);
  await expect(independent).toBeChecked();
  await back.click();
  await answerConfirmation(page, true);
  await expect(page.locator(".version-settings-page")).toHaveCount(0);
  expect(await count("versions.settings.save")).toBe(0);
  check(
    "Unsaved settings stay on cancel and are discarded only after acceptance",
  );

  await go("版本管理");
  await button("查看 1.21.4 本地资源").click();
  await page.getByRole("tab", { name: /^材质包/ }).click();
  const deletePack = button("删除 1.21.4 Faithful");
  await deletePack.click();
  await assertOpen("删除材质包 1.21.4 Faithful？", "resources.deletePack");
  await answerConfirmation(page, false);
  await expect(deletePack).toBeEnabled();
  await deletePack.click();
  await answerConfirmation(page, true);
  await expect(deletePack).toHaveCount(0);
  expect(await count("resources.deletePack")).toBe(1);
  check("Resource packs are deleted only after acceptance");

  await go("开始游戏");
  await page.locator(".sidebar-task").click();
  const cancelDownload = button("取消 Minecraft 1.21.4");
  await cancelDownload.click();
  await assertOpen("取消此下载任务？已完成的文件会保留。", "downloads.control");
  await answerConfirmation(page, false);
  expect(await count("downloads.control")).toBe(0);
  await cancelDownload.click();
  await answerConfirmation(page, true);
  await expect.poll(() => count("downloads.control")).toBe(1);
  expect(
    await page.evaluate(
      () =>
        window.__pixelTest.requests.find(
          (r) => r.operation === "downloads.control",
        ).payload,
    ),
  ).toEqual({ id: "minecraft", action: "cancel" });
  check(
    "Download cancellation uses the custom confirmation and preserves its original command",
  );

  expect(await page.evaluate(() => window.__confirmationTest.native)).toEqual(
    [],
  );
  expect(nativeDialogs).toEqual([]);
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/result.json`,
    JSON.stringify({ checks, errors, nativeDialogs }, null, 2),
  );
  console.log(
    "PASS All six confirmation flows use the existing Modal without native confirmations.",
  );
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` });
  throw error;
} finally {
  await browser.close();
}
