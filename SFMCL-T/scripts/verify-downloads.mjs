import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { downloadsFixture } from "./fixtures/downloads.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("evidence/downloads-motion");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 740 } });
page.setDefaultTimeout(8000);
const errors = [];
const checks = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript(pixelAppFixture, { components: true });
await page.addInitScript(downloadsFixture);
await page.addInitScript(() => {
  window.__modalMotions = [];
  window.__presses = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (frames, options) {
    const animation = animate.call(this, frames, options);
    if (options?.id?.startsWith("sfmcl-t-modal-")) {
      window.__modalMotions.push(animation);
      animation.pause();
      animation.currentTime = 0;
    }
    if (options?.id === "sfmcl-t-download-press") window.__presses.push(animation);
    return animation;
  };
});
const dialog = page.getByRole("dialog");
const finishModal = () =>
  page.evaluate(async () => {
    const host = document.querySelector("dialog");
    const animations = window.__modalMotions.filter(
      (a) => a.playState === "paused",
    );
    const finished = Promise.all(animations.map((a) => a.finished));
    animations.forEach((a) => a.finish());
    await finished;
    // Sample after the exit callback, before React can commit the removal.
    // Waiting for the dialog to detach alone misses a flash in this interval.
    await Promise.resolve();
    return {
      connected: host.isConnected,
      open: host.open,
      opacity: Number(getComputedStyle(host).opacity),
      backdrop: Number(getComputedStyle(host, "::backdrop").opacity),
    };
  });
const modalSample = (time) =>
  page.evaluate((time) => {
    const dialog = document.querySelector("dialog");
    window.__modalMotions
      .filter((a) => a.playState === "paused")
      .forEach((a) => {
        a.currentTime = time;
      });
    const style = getComputedStyle(dialog);
    return {
      opacity: Number(style.opacity),
      transform: style.transform,
      backdrop: Number(getComputedStyle(dialog, "::backdrop").opacity),
      open: dialog.open,
    };
  }, time);
async function closeModal(method) {
  if (method === "button")
    await dialog
      .getByRole("button", { name: "关闭对话框", exact: true })
      .click();
  else if (method === "escape") await page.keyboard.press("Escape");
  else await page.mouse.click(5, 5);
  await expect(dialog).toHaveAttribute("data-closing", "true");
  const start = await modalSample(0);
  const middle = await modalSample(75);
  expect(start.open).toBe(true);
  expect(middle.open).toBe(true);
  expect(middle.opacity).toBeLessThan(start.opacity);
  expect(middle.opacity).toBeGreaterThan(0);
  expect(middle.backdrop).toBeLessThan(start.backdrop);
  const afterExit = await finishModal();
  expect(
    afterExit.connected &&
      afterExit.open &&
      (afterExit.opacity > 0 || afterExit.backdrop > 0),
    "The dialog and backdrop must stay hidden between exit completion and unmount",
  ).toBe(false);
  await expect(dialog).toHaveCount(0);
  checks.push({ name: `dialog-close-${method}`, start, middle, afterExit });
}
const filesTrigger = () =>
  page
    .locator(".download-card")
    .first()
    .getByRole("button", { name: "查看文件" });
async function openFiles() {
  await filesTrigger().click();
  await expect(dialog).toHaveAttribute("open", "");
  const start = await modalSample(0);
  const middle = await modalSample(90);
  expect(start.opacity).toBe(0);
  expect(middle.opacity).toBeGreaterThan(0);
  expect(middle.opacity).toBeLessThan(1);
  expect(middle.backdrop).toBeGreaterThan(start.backdrop);
  await finishModal();
  await expect(dialog.locator(".file-table")).toHaveAttribute(
    "aria-busy",
    "false",
  );
}
async function pagerBounds() {
  return dialog.evaluate((host) => {
    const body = host.querySelector(".modal-body").getBoundingClientRect();
    const bar = host.querySelector(".pagination").getBoundingClientRect();
    return {
      bodyBottom: body.bottom,
      barBottom: bar.bottom,
      barTop: bar.top,
      bodyTop: body.top,
    };
  });
}

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page.waitForFunction(
    () => !document.documentElement.hasAttribute("data-startup"),
  );
  await page.locator(".sidebar-task").click();
  await expect(
    page.getByRole("heading", { name: "下载中心", exact: true }),
  ).toBeVisible();
  const toggle = page.locator(".job-toggle").first();
  const body = page.locator(".job-body").first();
  const buttons = page.locator(
    '.downloads-page button:not([role="tab"]):enabled',
  );
  for (let i = 0; i < (await buttons.count()); i++) {
    const button = buttons.nth(i);
    await button.hover();
    await expect(button).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, -2)");
    await page.mouse.down();
    await expect(button).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 2)");
    await page.mouse.move(0, 0);
    await page.mouse.up();
  }
  const badge = page.locator(".job-header > .badge").first();
  await badge.hover();
  await expect(badge).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, -1)");
  const fullHeight = await body.evaluate(
    (node) => node.getBoundingClientRect().height,
  );
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(body).toHaveAttribute("inert", "");
  const collapse = await body.evaluate((node) => {
    const animations = node.getAnimations();
    animations.forEach((a) => {
      a.pause();
      a.currentTime = 100;
    });
    return node.getBoundingClientRect().height;
  });
  expect(collapse).toBeGreaterThan(0);
  expect(collapse).toBeLessThan(fullHeight);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(body).not.toHaveAttribute("inert");
  await body.evaluate((node) =>
    node.getAnimations().forEach((a) => a.finish()),
  );
  await expect
    .poll(() => body.evaluate((node) => node.getBoundingClientRect().height))
    .toBeCloseTo(fullHeight, 1);
  expect(await page.evaluate(() => window.__presses.length)).toBeGreaterThan(1);
  checks.push({
    name: "buttons-badges-and-reversible-collapse",
    fullHeight,
    collapse,
  });

  for (const status of [
    "completed",
    "failed",
    "paused",
    "running",
    "queued",
    "cancelled",
  ]) {
    await page.evaluate((status) => {
      window.__pixelTest.tasks.jobs[0].steps[1].status = status;
    }, status);
    const step = page.locator(".job-card .steps li").nth(1);
    await expect(step).toHaveClass(status);
    const incoming = step.locator(".step-glyph > .animated-swap-in");
    await expect(incoming).toHaveCount(1);
    const frames = await incoming.evaluate((node) => {
      const animation = node.getAnimations()[0];
      animation.pause();
      animation.currentTime = 80;
      const opacity = Number(getComputedStyle(node).opacity);
      animation.finish();
      return { opacity };
    });
    expect(frames.opacity).toBeGreaterThan(0);
    expect(frames.opacity).toBeLessThan(1);
    await expect(step.locator(".step-glyph > .animated-swap-out")).toHaveCount(
      0,
    );
    checks.push({ name: `step-state-${status}`, ...frames });
  }
  await openFiles();
  await expect(dialog.locator("tbody tr")).toHaveCount(100);
  const startBounds = await pagerBounds();
  expect(startBounds.barBottom).toBeCloseTo(startBounds.bodyBottom, 1);
  await dialog.locator(".modal-body").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const endBounds = await pagerBounds();
  expect(endBounds.barBottom).toBeCloseTo(startBounds.barBottom, 1);
  const lastRow = await dialog.locator("tbody tr").last().boundingBox();
  expect(lastRow.y + lastRow.height).toBeLessThanOrEqual(endBounds.barTop + 1);
  await dialog.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(dialog.locator("tbody tr").first()).toContainText(
    "download-file-101.jar",
  );
  expect(
    await dialog.locator(".modal-body").evaluate((node) => node.scrollTop),
  ).toBe(0);
  await dialog.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(dialog.locator("tbody tr")).toHaveCount(5);
  const shortBounds = await pagerBounds();
  expect(shortBounds.barBottom).toBeCloseTo(startBounds.barBottom, 1);
  await expect(
    dialog.getByRole("button", { name: "下一页", exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: `${evidence}/files-last-page.png` });
  checks.push({
    name: "sticky-pagination-long-short-and-last-row",
    startBounds,
    endBounds,
    shortBounds,
  });
  await page.evaluate(() => {
    window.__pixelTest.fileDelay = 250;
  });
  await dialog.getByRole("button", { name: "上一页", exact: true }).click();
  await expect(dialog.locator(".file-table")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(dialog.locator(".page-indicator")).toHaveText("正在加载…");
  await expect(
    dialog.getByRole("button", { name: "下一页", exact: true }),
  ).toBeDisabled();
  await expect(dialog.locator("tbody tr").first()).toContainText(
    "download-file-101.jar",
  );
  await page.evaluate(() => {
    window.__pixelTest.fileDelay = 0;
    window.__pixelTest.fileFailure = true;
  });
  await dialog.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(dialog.locator(".inline-error")).toContainText(
    "文件清单暂时不可用",
  );
  await expect(dialog.locator(".file-placeholder")).toContainText("自动重试");
  await page.evaluate(() => {
    window.__pixelTest.fileFailure = false;
  });
  await expect(dialog.locator("tbody tr")).toHaveCount(5);
  await expect(dialog.locator(".inline-error")).toHaveCount(0);
  checks.push({ name: "pagination-loading-and-error-recovery" });
  await closeModal("button");
  await expect(filesTrigger()).toBeFocused();
  await openFiles();
  await closeModal("escape");
  await expect(filesTrigger()).toBeFocused();
  await openFiles();
  await closeModal("backdrop");
  await expect(filesTrigger()).toBeFocused();

  // Closing during entry starts at the visible frame, without flashing fully open.
  await filesTrigger().click();
  const interrupted = await modalSample(60);
  await page.keyboard.press("Escape");
  const reversed = await modalSample(0);
  expect(reversed.opacity).toBeCloseTo(interrupted.opacity, 4);
  expect(reversed.transform).toBe(interrupted.transform);
  await finishModal();
  await expect(dialog).toHaveCount(0);
  checks.push({ name: "close-during-entry", interrupted, reversed });

  await page
    .getByRole("button", {
      name: "查看 安装 Minecraft 1.21.4 日志",
      exact: true,
    })
    .click();
  await finishModal();
  await expect(dialog.locator(".log-view")).toContainText("资源下载任务已创建");
  await dialog.getByRole("button", { name: "复制日志", exact: true }).hover();
  await expect(
    dialog.getByRole("button", { name: "复制日志", exact: true }),
  ).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, -2)");
  await closeModal("escape");

  for (const width of [375, 768, 1120]) {
    await page.setViewportSize({ width, height: 640 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => {
      window.__pixelTest.tasks.downloads[0].fileCount = 0;
    });
    await openFiles();
    await expect(dialog.getByText("暂无文件", { exact: true })).toBeVisible();
    const bounds = await pagerBounds();
    expect(bounds.barBottom).toBeCloseTo(bounds.bodyBottom, 1);
    expect(
      await dialog.evaluate((node) => node.scrollWidth > node.clientWidth),
    ).toBe(false);
    await page.screenshot({ path: `${evidence}/files-empty-${width}.png` });
    await closeModal("button");
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    window.__pixelTest.data.settings.theme = "dark";
    window.__pixelTest.tasks.downloads[0].fileCount = 205;
  });
  for (const width of [1120, 375]) {
    await page.setViewportSize({ width, height: 640 });
    await page.locator("main.page").evaluate((node) => {
      node.scrollTop = 0;
    });
    expect(
      await page
        .locator("main.page")
        .evaluate((node) => node.scrollWidth > node.clientWidth),
    ).toBe(false);
    await page.screenshot({ path: `${evidence}/downloads-dark-${width}.png` });
    await openFiles();
    await expect(dialog.locator("tbody tr")).toHaveCount(100);
    const bounds = await pagerBounds();
    expect(bounds.barBottom).toBeCloseTo(bounds.bodyBottom, 1);
    await page.screenshot({ path: `${evidence}/files-dark-${width}.png` });
    await closeModal("escape");
  }
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        window.__modalMotions.filter(
          (a) => a.playState === "paused" && !a.effect.target.isConnected,
        ).length,
    ),
  ).toBe(0);
  await writeFile(
    `${evidence}/report.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(
    "PASS Downloads buttons, badges, reversible steps, state transitions, sticky pagination, dialog entry/exit, interruption and focus restoration.",
  );
} finally {
  await browser.close();
}
