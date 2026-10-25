import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { runtimePath } from "./lib/paths.mjs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";

const evidence = runtimePath("evidence/tooltips");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
page.setDefaultTimeout(8000);
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture, { components: true });
const tooltip = page.locator("#sfmcl-t-tooltip");
const snapshot = (exiting = false) => {
  const el = document.getElementById("sfmcl-t-tooltip");
  if (!el || (exiting && el.dataset.open !== "false")) return false;
  const style = getComputedStyle(el);
  const durations = style.transitionDuration
    .split(",")
    .map((value) => value.trim());
  return {
    open: el.dataset.open,
    opacity: getComputedStyle(el).opacity,
    duration: style.transitionProperty
      .split(",")
      .map((_, index) => durations[index % durations.length]),
    radius: getComputedStyle(el).borderRadius,
    fill: getComputedStyle(el).backgroundColor,
    ink: getComputedStyle(el).color,
    border: getComputedStyle(el).borderTopWidth,
    animations: el.getAnimations().map((a) => ({
      duration: a.effect.getTiming().duration,
      state: a.playState,
    })),
  };
};
const info = () => page.evaluate(snapshot);
const rightPlacement = async (anchor) => {
  await expect(tooltip).toHaveAttribute("data-placement", "right");
  await expect(tooltip).toHaveCSS("opacity", "1");
  const geometry = await anchor.evaluate((el) => {
    const panel = document.getElementById("sfmcl-t-tooltip");
    const trigger = el.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    const arrow = getComputedStyle(panel, "::after");
    const matrix = new DOMMatrix(arrow.transform);
    return {
      gap: box.left - trigger.right,
      arrowCenter:
        box.top +
        panel.clientTop +
        parseFloat(arrow.top) +
        parseFloat(arrow.height) / 2,
      triggerCenter: trigger.top + trigger.height / 2,
      arrowLeft: parseFloat(arrow.left),
      arrowRotation: (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI,
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      fitsContent: panel.scrollWidth <= panel.clientWidth,
    };
  });
  expect(geometry.gap).toBeCloseTo(10, 0);
  expect(
    Math.abs(geometry.arrowCenter - geometry.triggerCenter),
  ).toBeLessThanOrEqual(1);
  expect(geometry.arrowLeft).toBeLessThan(0);
  expect(geometry.arrowRotation).toBeCloseTo(135, 0);
  expect(geometry.left).toBeGreaterThanOrEqual(11);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth - 11);
  expect(geometry.top).toBeGreaterThanOrEqual(11);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight - 11);
  expect(geometry.fitsContent).toBe(true);
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page.waitForFunction(
    () => !document.documentElement.hasAttribute("data-startup"),
  );
  const nav = page.getByRole("navigation", { name: "主导航" });
  const versions = nav.getByRole("button", { name: "版本管理", exact: true });
  const resources = nav.getByRole("button", { name: "资源中心", exact: true });
  const sidebar = page.locator(".sidebar");
  const collapse = sidebar.locator(".sidebar-collapse");
  await versions.hover();
  await page.waitForTimeout(400);
  await expect(tooltip).toHaveCount(0);
  await page.keyboard.press("Tab");
  await versions.focus();
  await expect(sidebar.locator("[data-tooltip]")).toHaveCount(0);
  await expect(tooltip).toHaveCount(0);
  checks.push("expanded sidebar has no hover or keyboard tooltips");
  await sidebar.locator(".brand-logo").hover();
  await collapse.click();
  await expect(sidebar).toHaveClass(/rail-collapsed/);
  await expect(sidebar).toHaveCSS("width", "66px");
  await versions.hover();
  await expect(tooltip).toHaveAttribute("data-open", "true");
  await expect(tooltip).toHaveText("版本管理");
  await expect(versions).not.toHaveAttribute("title");
  await expect(versions).toHaveAttribute("aria-describedby", "sfmcl-t-tooltip");
  expect((await info()).duration).toEqual(["0.18s", "0.18s"]);
  expect((await info()).radius).toBe("4px");
  expect((await info()).border).toBe("1px");
  checks.push("native title replaced by themed paper tooltip; 180ms entrance");

  await expect(tooltip).toHaveCSS("opacity", "1");
  await page.mouse.move(750, 360);
  const exit = await (await page.waitForFunction(snapshot, true)).jsonValue();
  expect(exit.duration).toEqual(["0.14s", "0.14s"]);
  expect(exit.animations.some((a) => a.duration === 140)).toBe(true);
  await versions.hover();
  await expect(tooltip).toHaveAttribute("data-open", "true");
  await expect(tooltip).toHaveCSS("opacity", "1");
  checks.push("140ms exit remains mounted and reverses on re-entry");

  await resources.hover();
  await expect(tooltip).toHaveText("资源中心");
  await expect(versions).not.toHaveAttribute("aria-describedby");
  await expect(page.getByRole("tooltip")).toHaveCount(1);
  await expect(page.locator('.sfmcl-t-tooltip[aria-hidden="true"]')).toHaveCount(
    0,
  );
  await tooltip.hover();
  await expect(tooltip).toHaveAttribute("data-open", "true");
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await resources.dispatchEvent("pointerover", { pointerType: "mouse" });
  await page.waitForTimeout(400);
  await expect(tooltip).toHaveCount(0);
  checks.push("rapid switching, hoverable surface and Escape suppression");

  await page.mouse.move(750, 360);
  await page.keyboard.press("Tab");
  await versions.focus();
  await expect(tooltip).toHaveText("版本管理");
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await expect(versions).toBeFocused();
  await resources.focus();
  await expect(tooltip).toHaveText("资源中心");
  checks.push(
    "keyboard focus opens tooltip without moving focus; Escape retains focus",
  );

  for (const anchor of [
    collapse,
    ...(await nav.getByRole("button").all()),
    sidebar.locator(".sidebar-task"),
    sidebar.locator(".profile-button"),
  ]) {
    if (anchor === collapse) {
      await sidebar.locator(".brand-logo").hover();
      await expect(collapse).toHaveCSS("opacity", "1");
    }
    await anchor.hover();
    await rightPlacement(anchor);
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
  }
  checks.push(
    "collapsed navigation, expand, download and player hints sit to the right with left-facing arrows aligned to their buttons",
  );

  const profile = sidebar.locator(".profile-button");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 768 });
    await page.mouse.move(width - 30, 360);
    await expect(sidebar).toHaveCSS("width", width <= 650 ? "62px" : "66px");
    await profile.evaluate((el) => {
      el.dataset.tooltip = "管理角色：" + "很长的角色名称".repeat(60);
    });
    await profile.hover();
    await rightPlacement(profile);
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
    await page.mouse.move(width - 30, 360);
  }
  await sidebar.locator(".brand-logo").hover();
  await collapse.click();
  await expect(sidebar).not.toHaveClass(/rail-collapsed/);
  await expect(sidebar.locator("[data-tooltip]")).toHaveCount(0);
  await expect(tooltip).toHaveCount(0);
  await page.setViewportSize({ width: 768, height: 768 });
  await expect(sidebar).toHaveClass(/rail-collapsed/);
  await resources.hover();
  await rightPlacement(resources);
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(sidebar).not.toHaveClass(/rail-collapsed/);
  await expect(tooltip).toHaveCount(0);
  await expect(sidebar.locator("[data-tooltip]")).toHaveCount(0);
  checks.push(
    "long bottom-edge hints fit 375–1440px; manual expansion and automatic responsive expansion dismiss them",
  );
  await sidebar.locator(".brand-logo").hover();
  await collapse.click();
  await expect(sidebar).toHaveCSS("width", "66px");

  // Long live labels remain plain text, preserve other descriptions and clamp to the viewport.
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "tooltip-probe";
    button.textContent = "提示验证";
    button.dataset.tooltip = "刷新数据 · Esc";
    button.setAttribute("aria-describedby", "tooltip-probe-description");
    Object.assign(button.style, {
      position: "fixed",
      left: "2px",
      top: "2px",
      zIndex: "2000",
    });
    const desc = document.createElement("span");
    desc.id = "tooltip-probe-description";
    desc.textContent = "原有说明";
    document.getElementById("root").append(button, desc);
  });
  const probe = page.locator("#tooltip-probe");
  await page.keyboard.press("Tab");
  await probe.focus();
  await expect(tooltip.locator("kbd")).toHaveText("Esc");
  await expect(probe).toHaveAttribute(
    "aria-describedby",
    "tooltip-probe-description sfmcl-t-tooltip",
  );
  await expect(tooltip).toHaveAttribute("data-placement", "bottom");
  await page.keyboard.press("Escape");
  await expect(probe).toHaveAttribute(
    "aria-describedby",
    "tooltip-probe-description",
  );
  await page.evaluate(() => {
    const probe = document.getElementById("tooltip-probe");
    probe.blur();
    probe.dataset.tooltip =
      "<img src=x onerror=alert(1)>\n" + "完整的游戏目录名称".repeat(60);
    probe.focus();
  });
  await expect(tooltip).toContainText("<img src=x onerror=alert(1)>");
  await expect(tooltip.locator("img")).toHaveCount(0);
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 768 });
    await expect(tooltip).toHaveCSS("opacity", "1");
    const box = await tooltip.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(11);
    expect(box.x + box.width).toBeLessThanOrEqual(width - 11);
    expect(box.y).toBeGreaterThanOrEqual(11);
    expect(box.y + box.height).toBeLessThanOrEqual(757);
    expect(
      await tooltip.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
  }
  checks.push(
    "shortcut badge, existing aria-describedby, escaped live text and 375–1440px bounds",
  );
  await page.evaluate(
    () => (document.getElementById("tooltip-probe").hidden = true),
  );
  await expect(tooltip).toHaveCount(0);
  await page.evaluate(() => {
    const probe = document.getElementById("tooltip-probe");
    probe.hidden = false;
    probe.dataset.tooltip = "明亮与深色主题";
  });
  await probe.focus();
  await expect(tooltip).toHaveText("明亮与深色主题");
  await page.evaluate(() => document.getElementById("tooltip-probe").remove());
  await expect(tooltip).toHaveCount(0);
  checks.push("hidden and removed anchors dismiss the tooltip");

  // Native modal dialogs occupy the top layer; their hints must remain above it.
  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    dialog.id = "tooltip-probe-dialog";
    const button = document.createElement("button");
    button.textContent = "对话框提示验证";
    button.dataset.tooltip = "对话框中的完整路径";
    Object.assign(dialog.style, {
      width: "500px",
      height: "300px",
      padding: "100px",
    });
    dialog.append(button);
    document.getElementById("root").append(dialog);
    dialog.showModal();
    button.focus();
  });
  await expect(tooltip).toHaveText("对话框中的完整路径");
  await expect(tooltip).toHaveCSS("opacity", "1");
  expect(
    await tooltip.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return el.contains(
        document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        ),
      );
    }),
  ).toBe(true);
  await page.screenshot({ path: `${evidence}/modal.png` });
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await expect(page.locator("#tooltip-probe-dialog")).toBeVisible();
  await page.evaluate(() =>
    document.getElementById("tooltip-probe-dialog").remove(),
  );
  checks.push("modal dialog hints remain visible above the native top layer");

  await page.setViewportSize({ width: 1024, height: 768 });
  await versions.focus();
  for (const theme of ["light", "dark"]) {
    for (const accent of ["forest", "puce", "ebony"]) {
      await page.evaluate(
        ({ theme, accent }) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.accent = accent;
        },
        { theme, accent },
      );
      const colors = await tooltip.evaluate((el) => {
        const root = getComputedStyle(document.documentElement);
        const test = document.createElement("span");
        test.style.color = root.getPropertyValue("--ink");
        test.style.backgroundColor = root.getPropertyValue("--panel");
        document.body.append(test);
        const expected = getComputedStyle(test),
          actual = getComputedStyle(el);
        const result =
          actual.color === expected.color &&
          actual.backgroundColor === expected.backgroundColor;
        test.remove();
        return result;
      });
      expect(colors).toBe(true);
      if (accent === "forest") {
        await expect(tooltip).toHaveCSS("opacity", "1");
        await page.screenshot({ path: `${evidence}/${theme}.png` });
      }
    }
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await resources.focus();
  expect((await info()).duration).toEqual(["0.18s", "0.18s"]);
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  checks.push(
    "all six theme palettes; requested animations remain enabled under reduced motion",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/report.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(
    `Passed ${checks.length} tooltip interaction groups and all six theme palettes.`,
  );
} finally {
  await browser.close();
}
