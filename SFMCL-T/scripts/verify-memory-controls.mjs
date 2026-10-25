import { chromium, expect } from "@playwright/test";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";

// Keep system memory and settings deterministic without touching real settings.
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
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
const limits = () => page.locator(".memory-range-limits > span");
const save = () =>
  page.getByRole("button", { name: "保存设置", exact: true }).first();
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
  await save().click();
  await expect(save()).toHaveCount(0);
};
try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await nav("设置");
  await page.getByRole("tab", { name: "全局设置", exact: true }).click();
  await expect(slider()).toHaveAttribute("max", "3051");
  await expect(slider()).toHaveValue("3051");
  await expect(number()).toHaveValue("3051");
  await expect(limits()).toHaveText(["512 MB", "3051 MB"]);
  await expect(
    page.getByText("扫描和添加后自动保存列表，可在下拉列表中删除记录。", {
      exact: true,
    }),
  ).toHaveCount(0);
  await commit();
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.memoryMb),
  ).toBe(3051);

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
  await expect(number()).toHaveValue("2049");
  await expect(slider()).toHaveValue("2049");
  await number().fill("9999");
  await expect(number()).toHaveValue("2049");
  await slider().press("ArrowLeft");
  await expect(number()).toHaveValue("1921");
  await slider().press("End");
  await expect(number()).toHaveValue("2049");
  await slider().press("ArrowRight");
  await expect(slider()).toHaveValue("2049");
  await updateMemory(5001);
  await expect(number()).toHaveValue("2049");
  await slider().press("End");
  await expect(number()).toHaveValue("5001");
  await commit();

  // A periodic refresh catches changes while the window remains focused.
  await page.evaluate(() => {
    window.__pixelTest.availableMemoryMb = 4099;
  });
  await expect(number()).toHaveValue("4099", { timeout: 12000 });
  await commit();
  await nav("版本管理");
  await page
    .getByRole("button", { name: "游戏设置 1.21.4", exact: true })
    .click();
  await updateMemory(3073);
  await expect(number()).toHaveValue("3073");
  await expect(limits()).toHaveText(["512 MB", "3073 MB"]);
  await expect(save()).toHaveCount(0);
  await page
    .getByRole("switch", { name: "内存与游戏目录：独立设置", exact: true })
    .click();
  await expect(number()).toBeEnabled();
  await expect(number()).toHaveValue("3073");
  await commit();
  expect(
    await page.evaluate(
      () => window.__pixelTest.versionSettings["1.21.4"].settings.memoryMb,
    ),
  ).toBe(3073);
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.memoryMb),
  ).toBe(4099);

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
  await expect(number()).toHaveValue("2051");
  await expect(slider()).toHaveValue("2051");
  await updateMemory(384);
  await expect(number()).toBeDisabled();
  await expect(number()).toHaveValue("384");
  await expect(slider()).toHaveValue("384");
  await expect(
    page.getByRole("alert").filter({ hasText: "不足 512 MB" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    "Memory controls passed: limit labels, manual refresh/loading/retry, clamping, keyboard bounds, periodic refresh, independent settings, and low-memory state.",
  );
} finally {
  await browser.close();
}
