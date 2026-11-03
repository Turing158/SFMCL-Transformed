import { chromium, expect } from "@playwright/test";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { waitForAutoSave } from "./lib/auto-save.mjs";

// Keep system memory and settings deterministic without touching real settings.
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(8000);
await page.addInitScript(pixelAppFixture);
await page.addInitScript(() => {
  window.__pixelTest.availableMemoryMb = 3051;
  window.__pixelTest.data.settings.memoryMb = 8192;
  window.__pixelTest.data.settings.autoMemory = false;
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const slider = () => page.getByRole("slider", { name: "游戏内存" });
const number = () => page.getByRole("spinbutton", { name: "内存 MB" });
const refresh = () => page.getByRole("button", { name: "刷新内存上限" });
const limits = () => page.locator(".memory-range-limits:visible > span");
const save = () =>
  page.getByRole("button", { name: "保存设置", exact: true }).first();
const title = () =>
  page.getByRole("textbox", { name: "窗口标题", exact: true });
const expectClean = async () => {
  await waitForAutoSave(page);
  await expect(save()).toHaveCount(0);
  await expect(page.locator(".save-bar")).toHaveCount(0);
};
const nav = (name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const updateMemory = async (value) => {
  await page.evaluate((available) => {
    window.__pixelTest.availableMemoryMb = available;
    window.dispatchEvent(new Event("focus"));
  }, value);
  await expect(slider()).toHaveAttribute(
    "max",
    String(Math.min(value, 131072)),
  );
};
const commit = async () => {
  await waitForAutoSave(page);
};
try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await nav("设置");
  await page.getByRole("tab", { name: "全局设置", exact: true }).click();
  await expect(slider()).toHaveAttribute("max", "3051");
  await expect(slider()).toHaveValue("3051");
  await expect(number()).toHaveValue("8192");
  await expect(limits()).toHaveText(["512 MB", "3051 MB"]);
  await expectClean();
  expect(
    await page.evaluate(() =>
      window.__pixelTest.requests.filter(
        (r) => r.operation === "settings.save",
      ),
    ),
  ).toHaveLength(0);
  await number().focus();
  await number().blur();
  await expectClean();
  await title().fill("Unsaved title");
  await updateMemory(2949);
  await expect(title()).toHaveValue("Unsaved title");
  await expect(number()).toHaveValue("8192");
  await waitForAutoSave(page);
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.windowTitle),
  ).toBe("Unsaved title");
  await title().fill("");
  await expect(number()).toHaveValue("8192");
  await expectClean();
  await page.getByRole("tab", { name: "启动器设置", exact: true }).click();
  await page.getByRole("tab", { name: "全局设置", exact: true }).click();
  await nav("开始游戏");
  await nav("设置");
  await expect(number()).toHaveValue("8192");
  await expectClean();
  await expect(
    page.getByText("扫描和添加后自动保存列表，可在下拉列表中删除记录。", {
      exact: true,
    }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.memoryMb),
  ).toBe(8192);

  await page.evaluate(() => {
    window.__pixelTest.availableMemoryMb = 2049;
    window.__pixelTest.delays["system.memory"] = 600;
  });
  await refresh().click();
  await expect(refresh()).toBeDisabled();
  await expect(refresh()).toHaveAttribute("aria-busy", "true");
  await expect(slider()).toHaveAttribute("max", "2049");
  await expect(limits()).toHaveText(["512 MB", "2049 MB"]);
  await expect(refresh()).toBeEnabled();
  await page.evaluate(() => {
    delete window.__pixelTest.delays["system.memory"];
  });
  await expect(number()).toHaveValue("8192");
  await expect(slider()).toHaveValue("2049");
  await expectClean();
  await number().fill("9999");
  await expect(number()).toHaveValue("2049");
  await slider().press("ArrowLeft");
  await expect(number()).toHaveValue("1921");
  await slider().press("End");
  await expect(number()).toHaveValue("2049");
  await slider().press("ArrowRight");
  await expect(slider()).toHaveValue("2049");
  await number().fill("");
  await number().blur();
  await expect(number()).toHaveValue("512");
  await number().fill("2049");
  await updateMemory(5001);
  await expect(number()).toHaveValue("2049");
  await slider().press("End");
  await expect(number()).toHaveValue("5001");
  await commit();

  // Periodic refresh updates the limit without rewriting the saved value.
  await page.evaluate(() => {
    window.__pixelTest.availableMemoryMb = 4099;
  });
  await expect(slider()).toHaveAttribute("max", "4099", { timeout: 12000 });
  await expect(number()).toHaveValue("5001");
  await expect(slider()).toHaveValue("4099");
  await expectClean();
  await title().fill("Memory unchanged");
  await commit();
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.memoryMb),
  ).toBe(5001);
  await nav("版本管理");
  await page
    .getByRole("button", { name: "游戏设置 1.21.4", exact: true })
    .click();
  await updateMemory(3073);
  await expect(number()).toHaveValue("5001");
  await expect(limits()).toHaveText(["512 MB", "3073 MB"]);
  await expect(save()).toHaveCount(0);
  await page
    .getByRole("switch", { name: "内存与游戏目录：独立设置", exact: true })
    .click();
  await expect(number()).toBeEnabled();
  await expect(number()).toHaveValue("5001");
  await commit();
  expect(
    await page.evaluate(
      () => window.__pixelTest.versionSettings["1.21.4"].settings.memoryMb,
    ),
  ).toBe(5001);
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.memoryMb),
  ).toBe(5001);
  await number().fill("2048");
  await waitForAutoSave(page);
  await expect(number()).toHaveValue("2048");
  await expectClean();
  await page.getByRole("button", { name: "返回上一级", exact: true }).click();
  await page
    .getByRole("button", { name: "游戏设置 1.21.4", exact: true })
    .click();
  await expect(number()).toHaveValue("2048");
  await expectClean();

  await page.reload();
  await page.evaluate(() => {
    window.__pixelTest.failures["system.memory"] = "Memory query failed";
  });
  await nav("设置");
  await page.getByRole("tab", { name: "全局设置", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "无法读取可用内存" }),
  ).toBeVisible();
  await expect(number()).toBeDisabled();
  await expect(number()).toHaveValue("8192");
  await expect(limits()).toHaveText(["512 MB", "— MB"]);
  await expect(save()).toHaveCount(0);
  await page.evaluate(() => {
    delete window.__pixelTest.failures["system.memory"];
    window.__pixelTest.availableMemoryMb = 2051;
  });
  await refresh().click();
  await expect(limits()).toHaveText(["512 MB", "2051 MB"]);
  await expect(number()).toBeEnabled();
  await expect(number()).toHaveValue("8192");
  await expect(slider()).toHaveValue("2051");
  await expectClean();
  await updateMemory(384);
  await expect(number()).toBeDisabled();
  await expect(number()).toHaveValue("8192");
  await expect(slider()).toHaveValue("384");
  await expect(
    page.getByRole("alert").filter({ hasText: "不足 512 MB" }),
  ).toBeVisible();
  await expectClean();
  await updateMemory(3051);
  await page.getByRole("switch", { name: "自动分配内存", exact: true }).click();
  await commit();
  await expect(number()).toBeDisabled();
  await updateMemory(2049);
  await expect(number()).toHaveValue("8192");
  await expectClean();
  await title().fill("Automatic memory draft");
  await waitForAutoSave(page);
  await expect(title()).toHaveValue("Automatic memory draft");
  await expectClean();
  await page.getByRole("tab", { name: "启动器设置", exact: true }).click();
  await page.getByRole("tab", { name: "全局设置", exact: true }).click();
  await expect(number()).toHaveValue("8192");
  await expectClean();
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.memoryMb),
  ).toBe(8192);
  expect(errors).toEqual([]);
  console.log(
    "Memory controls passed: no writes on entry, edits persist automatically, refresh preserves manual/automatic memory, edits respect limits, unrelated writes preserve memory, independent settings and low-memory/retry states work.",
  );
} finally {
  await browser.close();
}
