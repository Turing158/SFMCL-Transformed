import { expect } from "@playwright/test";

export async function waitForAutoSave(page) {
  // Blurring completes a numeric edit, and the data attribute includes the
  // debounce interval as well as queued/in-flight writes.
  await page.evaluate(() => document.activeElement?.blur());
  await expect(page.locator('[data-saving="true"]')).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "保存设置", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "撤销修改", exact: true }),
  ).toHaveCount(0);
}
