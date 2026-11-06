import { expect } from "@playwright/test";

export const loginMethods = {
  offline: "离线登录",
  microsoft: "Microsoft 登录",
  yggdrasil: "第三方账号登录",
  "yggdrasil-oauth": "第三方授权登录",
};

export async function openPlayerLogin(page, kind) {
  const ui = page.locator(".players-page");
  if (await ui.getAttribute("data-login")) {
    await page
      .getByRole("navigation", { name: "页面路径" })
      .getByRole("button", { name: "返回上一级", exact: true })
      .click();
    await expect(ui).not.toHaveAttribute("data-login");
  }
  await ui.getByRole("button", { name: "登录", exact: true }).click();
  await page
    .getByRole("menu", { name: "登录方式", exact: true })
    .getByRole("menuitem", { name: loginMethods[kind], exact: true })
    .click();
}
