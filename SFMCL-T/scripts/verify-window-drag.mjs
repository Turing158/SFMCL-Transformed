import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { playersFixture } from "./fixtures/players.mjs";
import { runtimePath } from "./lib/paths.mjs";
import { openPlayerLogin } from "./lib/player-login.mjs";

const evidence = runtimePath("evidence/window-drag");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const errors = [],
  checks = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(12000);
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(playersFixture);
await page.addInitScript(() => {
  window.__windowDrag = [];
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (
      command === "plugin:window|start_dragging" ||
      command === "plugin:window|toggle_maximize"
    ) {
      window.__windowDrag.push(command);
      return;
    }
    return invoke(command, args);
  };
});
const count = (operation = "start_dragging") =>
  page.evaluate(
    (operation) =>
      window.__windowDrag.filter((command) => command.endsWith("|" + operation))
        .length,
    operation,
  );
const drag = async (locator) => {
  const before = await count();
  await locator.hover();
  await expect(locator).toHaveCSS("cursor", "default");
  await page.waitForTimeout(450);
  await expect(page.locator("#sfmcl-t-tooltip")).toHaveCount(0);
  await locator.click();
  expect(await count()).toBe(before + 1);
};
const noDrag = async (action) => {
  const before = await count();
  const beforeMaximize = await count("toggle_maximize");
  await action();
  expect(await count()).toBe(before);
  expect(await count("toggle_maximize")).toBe(beforeMaximize);
};
const check = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await expect(page.locator("html")).not.toHaveAttribute("data-startup");
  await noDrag(() =>
    page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "资源中心", exact: true })
      .click(),
  );
  const brand = page.locator(".brand-label");
  await drag(brand.locator(".brand-wordmark"));
  await expect(
    page.locator("#sidebar-navigation [aria-current='page']"),
  ).toHaveAttribute("aria-label", "资源中心");
  expect(
    await brand.evaluate((node) => ({
      tag: node.tagName,
      tabIndex: node.tabIndex,
    })),
  ).toEqual({ tag: "SPAN", tabIndex: -1 });
  await noDrag(() => brand.click({ button: "right" }));
  check(
    "The SFMCL wordmark starts native window dragging without navigation or a button tab stop; right clicks do not drag.",
  );

  for (const name of ["开始游戏", "版本管理", "资源中心", "设置"]) {
    await noDrag(() =>
      page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name, exact: true })
        .click(),
    );
    await noDrag(() => page.locator(".page h1:visible").first().dblclick());
    await drag(page.locator(".topbar-breadcrumb strong[aria-current='page']"));
    const before = await count();
    const workspace = page.locator(".workspace");
    const bounds = await workspace.boundingBox();
    await workspace.dispatchEvent("mousedown", {
      button: 0,
      detail: 1,
      clientX: bounds.x + 4,
      clientY: bounds.y + 100,
    });
    expect(await count()).toBe(before);
  }
  await noDrag(() => page.locator(".workspace-footer-status").dblclick());
  check(
    "Page titles, workspace whitespace and footer text do not drag or maximize the window; current breadcrumb text still drags on every main page.",
  );

  await noDrag(() => page.locator(".sidebar .profile-button").click());
  const ui = page.locator(".players-page");
  const cards = ui.locator(".players-cards");
  const alex = cards.locator('[data-player-key="alex"]');
  const beforeCards = await count();
  const cardBounds = await alex.boundingBox();
  await page.mouse.click(
    cardBounds.x + 4,
    cardBounds.y + cardBounds.height / 2,
  );
  await expect(alex).toHaveClass(/selected/);
  expect(await count()).toBe(beforeCards);
  await noDrag(() => ui.locator(".players-login-actions button").click());
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await ui
    .locator(".players-model")
    .dispatchEvent("mousedown", { button: 0, detail: 1 });
  expect(await count()).toBe(beforeCards);
  await noDrag(() => ui.locator(".players-view-switch").click());
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-player-view-transition",
  );
  await noDrag(() => ui.locator(".players-view-switch").click());
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-player-view-transition",
  );
  await noDrag(async () => {
    const select = cards.locator('[data-player-key="steve"] .players-select');
    const from = await select.boundingBox();
    await page.mouse.move(from.x + 40, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, from.y + from.height / 2);
    await expect(page.locator(".players-drag-overlay")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(page.locator(".players-drag-overlay")).toHaveCount(0);
  });
  check(
    "Clickable card padding, nested buttons, disabled controls and player reordering retain their actions without starting a window drag.",
  );

  await noDrag(() =>
    cards.locator('[data-player-key="steve"] .players-select').click(),
  );
  await noDrag(() =>
    ui.getByRole("button", { name: "切换预览朝向，当前正面" }).click(),
  );
  await noDrag(() =>
    ui.getByRole("button", { name: "切换预览朝向，当前背面" }).click(),
  );
  const scene = ui.locator(".players-3d-input");
  await expect(scene).toBeVisible();
  await noDrag(async () => {
    const box = await scene.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + 50,
      box.y + box.height / 2 + 15,
      { steps: 4 },
    );
    await page.mouse.up();
  });
  check(
    "The 3D skin preview keeps its own pointer gestures and does not move the window.",
  );

  await noDrag(() =>
    ui.getByRole("button", { name: "更改名称", exact: true }).click(),
  );
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await noDrag(() => dialog.locator("h2").dblclick());
  await expect(dialog).toBeVisible();
  await noDrag(async () => {
    const input = dialog.getByRole("textbox").first();
    await input.click();
    await input.fill("WindowDrag");
    await expect(input).toHaveValue("WindowDrag");
  });
  await noDrag(() =>
    dialog.getByRole("button", { name: "关闭对话框", exact: true }).click(),
  );
  await expect(dialog).toHaveCount(0);
  await noDrag(() => openPlayerLogin(page, "offline"));
  await noDrag(async () => {
    const input = page.locator(".players-page").getByRole("textbox").first();
    await input.click();
    await input.fill("DragTest");
    await expect(input).toHaveValue("DragTest");
  });
  await noDrag(() =>
    page
      .getByRole("navigation", { name: "页面路径" })
      .getByRole("button", { name: "返回上一级", exact: true })
      .click(),
  );
  check(
    "Dialog headings do not drag or maximize the window; fields, close buttons, login choices and breadcrumb navigation retain normal operation.",
  );

  // Exercise a real native scrollbar target without activating its contents.
  const beforeScroll = await count();
  await cards.evaluate((list) => {
    list.style.height = "100px";
    list.style.flex = "none";
  });
  const track = await cards.evaluate((list) => {
    const box = list.getBoundingClientRect();
    return {
      x: box.left + list.clientLeft + list.clientWidth + 3,
      y: box.top + list.clientTop + 30,
      scrollable: list.scrollHeight > list.clientHeight,
    };
  });
  expect(track.scrollable).toBe(true);
  await cards.dispatchEvent("mousedown", {
    button: 0,
    detail: 1,
    clientX: track.x,
    clientY: track.y,
  });
  expect(await count()).toBe(beforeScroll);
  await cards.evaluate((list) => {
    list.style.removeProperty("height");
    list.style.removeProperty("flex");
  });
  check(
    "Native scrollbar tracks remain usable and do not start window dragging.",
  );

  const beforeMaximize = await count("toggle_maximize");
  const beforeTitleDrag = await count();
  await expect(page.locator(".topbar-drag-space")).toHaveCSS("cursor", "default");
  await expect(page.locator(".topbar-drag-space")).not.toHaveAttribute("data-tooltip");
  await page.locator(".topbar-drag-space").dblclick();
  expect(await count("toggle_maximize")).toBe(beforeMaximize + 1);
  expect(await count()).toBe(beforeTitleDrag + 1);
  await brand.dblclick();
  expect(await count("toggle_maximize")).toBe(beforeMaximize + 2);
  check(
    "The titlebar and brand region preserve single-drag and double-click maximize behavior without duplicate drag calls.",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
} finally {
  await browser.close();
}
