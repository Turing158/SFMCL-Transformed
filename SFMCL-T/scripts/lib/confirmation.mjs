import { expect } from "@playwright/test";

export async function answerConfirmation(page, confirmed) {
  const dialog = page.getByRole("dialog", { name: "确认操作", exact: true });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: confirmed ? "确认" : "取消", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
}
