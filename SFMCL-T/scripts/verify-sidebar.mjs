import { projectPath, runtimePath } from "./lib/paths.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";

const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/";
const evidence = runtimePath("evidence");
await mkdir(`${evidence}/sidebar-after`, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(8000);
const errors = [];
const checks = [];
const extraChecks = [];
const themes = [];
const layouts = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture, { components: true });
await page.addInitScript(() => {
  const scenario = new URLSearchParams(location.search).get("sidebar-test");
  const fixture = window.__pixelTest;
  if (["hidden", "empty", "job-only"].includes(scenario)) {
    fixture.tasks.downloads = [];
    if (scenario !== "job-only") fixture.tasks.jobs = [];
    fixture.data.settings.downloadTaskDisplay = scenario === "empty" ? "always" : "active";
  }
  if (scenario === "default") {
    delete fixture.data.settings.downloadTaskDisplay;
    fixture.data.settings.showDownloads = "always";
  }
  if (scenario === "long-name") fixture.data.players[0].name = "这是用于验证侧栏省略显示的二十个中文字符";
});
const sidebar = page.locator(".sidebar");
const nav = page.getByRole("navigation", { name: "主导航" });
const collapse = page.locator(".sidebar-collapse");
const toggleRail = async () => {
  await sidebar.locator('.brand-logo').hover();
  await expect(collapse).toHaveCSS('opacity', '1');
  await collapse.click();
};
const progress = sidebar.getByRole("progressbar");
const names = ["开始游戏", "版本管理", "资源中心", "设置"];
const ids = ["home", "versions", "resources", "settings"];
const settled = async () => page.evaluate(() => Promise.allSettled(
  document.getAnimations().filter((a) => a.effect.getTiming().iterations !== Infinity).map((a) => a.finished),
));
const ready = async (scenario = "") => {
  await page.goto(`${url}?sidebar-test=${scenario}`);
  await page.waitForFunction(() => !document.documentElement.hasAttribute("data-startup"));
  await expect(sidebar.locator(".profile-button")).toHaveAttribute("aria-label", /管理角色/);
  await settled();
};
const shot = (name) => page.screenshot({ path: `${evidence}/sidebar-${name}.png`, animations: "disabled" });
const record = (name, value, detail) => {
  checks.push({ name, passed: !!value, detail });
  expect(value, `${name}: ${JSON.stringify(detail)}`).toBeTruthy();
};
const inspectFrames = () => sidebar.evaluate((rail) => {
  const px = (value) => parseFloat(value) || 0;
  const frames = [...rail.querySelectorAll(".surface-frame")];
  const cutBroken = [], strokeBad = [], shadowed = [], untagged = [];
  const cuts = new Set();
  const insetProbe = document.createElement("div");
  document.body.append(insetProbe);
  for (const frame of frames) {
    const host = frame.parentElement, style = getComputedStyle(frame);
    const before = getComputedStyle(frame, "::before"), after = getComputedStyle(frame, "::after");
    cuts.add(style.clipPath);
    const stroke = host.matches(".nav-count,.task-count,.sidebar-progress,.sidebar-progress-fill") ? 1 : 2;
    insetProbe.style.clipPath = getComputedStyle(host).getPropertyValue(`--surface-shape-${stroke}`);
    const expectedInset = getComputedStyle(insetProbe).clipPath;
    if (style.clipPath === "none" || style.clipPath !== before.clipPath || expectedInset === "none" || after.clipPath !== expectedInset) cutBroken.push(host.className);
    const depth = px(getComputedStyle(host).getPropertyValue("--surface-depth"));
    if (px(after.top) !== stroke || px(after.left) !== stroke || px(after.right) !== stroke || px(after.bottom) !== stroke + depth) strokeBad.push(host.className);
    if (frame.getAttribute("aria-hidden") !== "true" || style.pointerEvents !== "none") untagged.push(host.className);
    let ancestor = host, foundStack = false;
    while (ancestor && ancestor !== rail.parentElement) {
      const cs = getComputedStyle(ancestor);
      if ((cs.position !== "static" && cs.zIndex !== "auto") || cs.isolation === "isolate" || cs.transform !== "none" || cs.filter !== "none" || Number(cs.opacity) < 1) { foundStack = true; break; }
      const rgba = cs.backgroundColor.match(/[\d.]+/g);
      if (cs.backgroundImage !== "none" || (rgba && (rgba.length < 4 || +rgba[3] === 1))) shadowed.push(host.className);
      ancestor = ancestor.parentElement;
    }
    if (!foundStack) shadowed.push(`${host.className}: no stacking context`);
  }
  insetProbe.remove();
  const rectBorders = [...rail.querySelectorAll("*"), rail].filter((node) => {
    // The overlay scrollbar uses a transparent native border for its gutter.
    if (node.matches(".sidebar-favorites-scrollbar-thumb")) return false;
    const cs = getComputedStyle(node);
    return px(cs.borderTopWidth) + px(cs.borderRightWidth) + px(cs.borderBottomWidth) + px(cs.borderLeftWidth) > 0;
  }).map((node) => node.className);
  const needed = [".sidebar-task", ".sidebar-progress", ".sidebar-progress-fill", ".avatar", ".profile-button", ".task-count"];
  const missing = needed.filter((selector) => !rail.querySelector(selector)?.querySelector(":scope > .surface-frame"));
  const active = rail.querySelector('nav [aria-current="page"]');
  const cs = getComputedStyle(active);
  return { count: frames.length, cuts: cuts.size, cutBroken, strokeBad, shadowed, untagged, rectBorders, missing,
    shadow: cs.boxShadow, marker: cs.getPropertyValue("--surface-marker").trim(),
    unclipped: [...rail.querySelectorAll(".has-surface")].every((host) => getComputedStyle(host).clipPath === "none"),
    childrenStacked: [...rail.children].every((child) => getComputedStyle(child).position === "relative" && getComputedStyle(child).zIndex === "1"),
  };
});

try {
  await ready();
  await expect(progress).toHaveAttribute("aria-valuenow", "64");
  await expect(sidebar.locator(".sidebar-tip")).toHaveCount(0);
  await expect(sidebar).toHaveCSS("background-image", "none");
  expect(await sidebar.evaluate(el => getComputedStyle(el, "::before").backgroundImage)).toBe("none");
  const frames = await inspectFrames();
  record("外层使用生成轮廓，填充使用对应描边厚度的腐蚀内轮廓", frames.cutBroken.length === 0 && frames.cuts === 4, frames);
  record("控件描边为 2px，数字徽标和细进度条为 1px", frames.strokeBad.length === 0, frames.strokeBad);
  record("侧栏无矩形描边，内容宿主不裁切", frames.rectBorders.length === 0 && frames.unclipped, frames.rectBorders);
  record("选中项无底部内阴影或标记条", frames.shadow === "none" && frames.marker === "transparent", frames);
  record("下载分组与底部控件复用 PixelFrame", frames.missing.length === 0, frames.missing);
  record("所有装饰层 aria-hidden 且不拦截指针", frames.untagged.length === 0, frames.untagged);
  record("装饰层未被不透明背景盖住", frames.shadowed.length === 0 && frames.childrenStacked, frames.shadowed);
  await expect(collapse).toHaveCSS('opacity', '0');
  await expect(sidebar.locator('.brand-mark')).toHaveCSS('opacity', '1');
  await expect(collapse.locator('.surface-frame, .collapse-text')).toHaveCount(0);
  await expect(sidebar.locator('.sidebar-footer, .sidebar-landscape')).toHaveCount(0);
  await sidebar.locator('.brand-logo').hover();
  await expect(collapse).toHaveCSS('opacity', '1');
  await expect(sidebar.locator('.brand-mark')).toHaveCSS('opacity', '0');
  await page.mouse.move(1200, 600);
  await expect(collapse).toHaveCSS('opacity', '0');
  await expect(sidebar.locator('.brand-mark')).toHaveCSS('opacity', '1');
  await collapse.focus();
  await expect(collapse).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  await expect(collapse).toHaveAttribute('aria-expanded', 'false');
  await settled();
  await page.keyboard.press('Enter');
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await settled();
  await collapse.evaluate(el => el.blur());
  const rail = await sidebar.boundingBox();
  const profile = await sidebar.locator('.profile-button').boundingBox();
  const downloads = await sidebar.locator('.sidebar-downloads').boundingBox();
  expect(rail.y + rail.height - profile.y - profile.height).toBe(14);
  expect(profile.y - downloads.y - downloads.height).toBe(12);
  extraChecks.push('Logo hover and keyboard toggle work; download and profile entries sit at the bottom with a 12px gap and 14px bottom padding, without a decorative footer or version');
  await shot("light");

  await toggleRail();
  await settled();
  record("折叠后仍保留全部装饰层", await sidebar.locator(".surface-frame").count() === frames.count);
  record("折叠后只剩图标，头像及任务入口保留", await collapse.locator(".collapse-text").isHidden() && await collapse.locator("svg").isVisible() && await sidebar.locator(".avatar").isVisible() && await sidebar.locator(".sidebar-task").isVisible());
  record("折叠后有可访问名和正确的展开状态", await collapse.getAttribute("aria-label") === "展开侧栏" && await collapse.getAttribute("aria-expanded") === "false");
  await shot("collapsed");
  for (let i = 0; i < 5; i++) {
    await toggleRail();
    await expect(collapse).toHaveAttribute("aria-expanded", "true");
    await expect(collapse.locator(".collapse-chev")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    await toggleRail();
    await expect(collapse).toHaveAttribute("aria-expanded", "false");
    await expect(collapse.locator(".collapse-chev")).toHaveCSS("transform", "matrix(-1, 0, 0, -1, 0, 0)");
    expect(await sidebar.locator(".surface-frame").count()).toBe(frames.count);
  }
  await toggleRail();
  await settled();
  extraChecks.push("折叠/展开五次，装饰层和箭头方向不丢失");

  // Inspect an in-between animation frame in both directions, then reverse
  // an unfinished collapse to catch jumps and stale visibility after toggling.
  const sampleMotion = async (resume = true) => {
    await toggleRail();
    await page.waitForFunction(() => {
      const animation = document.querySelector('.app').getAnimations().find(a => a.transitionProperty === '--rail-open');
      if (!animation) return false;
      animation.pause();
      return true;
    });
    return page.locator('.app').evaluate((el, resume) => {
      const animation = el.getAnimations().find(a => a.transitionProperty === '--rail-open');
      animation.pause();
      animation.currentTime = animation.effect.getTiming().duration / 3;
      const rail = el.querySelector('.sidebar'), button = rail.querySelector('nav button');
      const sample = { rail: rail.getBoundingClientRect().width, button: button.getBoundingClientRect().width, copy: Number(getComputedStyle(button.querySelector('.nav-copy')).opacity), workspace: el.querySelector('.workspace').getBoundingClientRect().left };
      if (resume) animation.play();
      return sample;
    }, resume);
  };
  for (const direction of ['collapse', 'expand']) {
    const sample = await sampleMotion();
    expect(sample.rail, direction).toBeGreaterThan(66);
    expect(sample.rail, direction).toBeLessThan(216);
    expect(sample.button, direction).toBeGreaterThan(38);
    expect(sample.button, direction).toBeLessThan(192);
    expect(sample.copy, direction).toBeGreaterThan(0);
    expect(sample.copy, direction).toBeLessThan(1);
    expect(sample.workspace).toBeCloseTo(sample.rail, 1);
    await settled();
  }
  await sampleMotion(false);
  await collapse.evaluate(el => el.click());
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await settled();
  expect((await sidebar.boundingBox()).width).toBe(216);
  await expect(nav.locator('.nav-copy').first()).toBeVisible();
  await expect(sidebar.getByText('你的工作台', { exact: true })).toHaveCount(0);
  extraChecks.push('双向收放有中间帧，正文同步移动，动画中途反向后尺寸与文字可见性正确；移除工作台标签');

  await nav.getByRole("button", { name: "资源中心", exact: true }).click();
  const brand = sidebar.locator(".brand-home");
  await brand.hover();
  await settled();
  const beforePress = await brand.boundingBox();
  await page.mouse.down();
  await settled();
  const duringPress = await brand.boundingBox();
  record("品牌区无选中态、无按下位移", !(await brand.getAttribute("aria-current")) && JSON.stringify(beforePress) === JSON.stringify(duringPress));
  await page.mouse.up();
  await expect(nav.locator('[aria-current="page"]')).toHaveAttribute("aria-label", "开始游戏");
  await brand.focus();
  record("品牌区保留键盘焦点", await brand.evaluate((el) => el === document.activeElement && el.tabIndex === 0));
  record("点击品牌区回首页且菜单始终有一个选中项", await nav.locator('[aria-current="page"]').count() === 1 && await nav.locator('[aria-current="page"]').getAttribute("aria-label") === "开始游戏");
  record("品牌区有 2px 像素虚线并显示软件图标", await brand.evaluate((el) => {
    const heading = el.closest('.brand');
    const icon = heading.querySelector('img.brand-mark');
    return getComputedStyle(heading, "::after").height === "2px" && getComputedStyle(heading, "::after").backgroundImage.includes("repeating-linear-gradient") && icon?.complete && icon.naturalWidth > 0 && !heading.querySelector('.surface-frame');
  }));

  const source = await readFile(projectPath("src/App.tsx"), "utf8");
  const navigation = source.slice(source.indexOf("const navigation"), source.indexOf("] as const;"));
  const sourceIds = [...navigation.matchAll(/id: "([a-z]+)"/g)].map((match) => match[1]);
  const renderedNames = await nav.getByRole("button").evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label")));
  record("主导航保留四项，角色管理通过底部角色入口进入", JSON.stringify(sourceIds) === JSON.stringify(ids) && JSON.stringify(renderedNames) === JSON.stringify(names), { sourceIds, renderedNames });
  await expect(nav.getByRole("button", { name: "角色管理", exact: true })).toHaveCount(0);
  await expect(sidebar.locator(".sidebar-downloads .nav-label")).toHaveCount(0);
  await sidebar.locator(".profile-button").click();
  await expect(page.locator(".players-page")).toBeVisible();
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(0);

  await ready("hidden");
  await expect(nav.getByRole("button", { name: "下载中心", exact: true })).toHaveCount(0);
  await expect(sidebar.locator(".sidebar-downloads")).toHaveCount(0);
  await ready("empty");
  await expect(sidebar.locator(".sidebar-tip")).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "下载中心", exact: true })).toHaveCount(0);
  await expect(sidebar.locator(".sidebar-task")).toContainText("暂无下载任务");
  await expect(progress).toHaveCount(0);
  await ready("job-only");
  await expect(nav.getByRole("button", { name: "下载中心", exact: true })).toHaveCount(0);
  await expect(sidebar.locator(".sidebar-downloads")).toBeVisible();
  await expect(progress).toHaveAttribute("aria-valuenow", "33");
  await ready();
  record("下载摘要独立控制，始终显示有空态，仅步骤任务时也显示进度", await sidebar.locator(".sidebar-task").isVisible());
  record("侧栏像素控件无矩形描边", (await inspectFrames()).rectBorders.length === 0);

  // Exercise real polling updates, including task priority and unknown totals.
  await page.evaluate(() => {
    const fixture = window.__pixelTest;
    fixture.tasks.jobs = [];
    fixture.tasks.downloads[0].downloaded = fixture.tasks.downloads[0].total * 0.25;
  });
  await expect(progress).toHaveAttribute("aria-valuenow", "25");
  const widths = [];
  for (let i = 0; i < 4; i++) {
    widths.push(await sidebar.locator(".sidebar-progress-fill").evaluate((el) => el.getBoundingClientRect().width));
    await page.waitForTimeout(150);
  }
  expect(new Set(widths).size).toBe(1);
  await page.evaluate(() => {
    window.__pixelTest.tasks.downloads[0].unknownSize = true;
    window.__pixelTest.tasks.downloads[0].fileCount = 0;
  });
  await expect(progress).not.toHaveAttribute("aria-valuenow");
  await expect(sidebar.locator(".task-count")).toHaveCount(0);
  await page.evaluate(() => {
    const download = window.__pixelTest.tasks.downloads[0];
    download.fileCount = 10;
    download.completed = 3;
  });
  await expect(progress).toHaveAttribute("aria-valuenow", "30");
  for (const status of ["queued", "pausing", "paused", "failed", "cancelled", "completed"]) {
    await page.evaluate((status) => {
      window.__pixelTest.tasks.downloads.splice(1);
      window.__pixelTest.tasks.downloads[0].status = status;
    }, status);
    await expect(sidebar.locator(".sidebar-downloads")).toHaveAttribute("data-status", status);
    if (status === "completed") await expect(progress).toHaveAttribute("aria-valuenow", "100");
  }
  await sidebar.locator(".sidebar-task").click();
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(0);
  await expect(sidebar.locator(".sidebar-task")).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "下载中心", exact: true })).toBeVisible();
  extraChecks.push("真实轮询更新、字节/文件进度、未知总量、七种任务状态、摘要跳转；微动不改变进度长度");

  await ready("default");
  await expect(sidebar.locator(".sidebar-downloads")).toHaveCount(0);
  const tip = sidebar.locator(".sidebar-tip");
  await expect(tip).toBeVisible();
  const tipBefore = await tip.boundingBox();
  await tip.hover();
  await expect(tip).toHaveCSS("translate", "0px -2px");
  await settled();
  expect((await tip.boundingBox()).y).toBeCloseTo(tipBefore.y - 2, 1);
  expect(await tip.locator("svg").evaluate(el => getComputedStyle(el).transform)).not.toBe("none");
  await page.mouse.move(1000, 600);
  await settled();
  extraChecks.push("侧栏采用纯色背景；下载摘要与提示卡互斥，始终显示空下载摘要时也隐藏提示卡；提示卡悬停上浮并转动图标");
  await expect(nav.getByRole("button", { name: "下载中心", exact: true })).toHaveCount(0);
  await shot("default-hidden");
  const display = page.getByRole("combobox", { name: "侧栏下载任务", exact: true });
  const setDisplay = async (mode, label) => {
    await nav.getByRole("button", { name: "设置", exact: true }).click();
    await display.click();
    await expect(page.getByRole("option")).toHaveText(["下载时", "始终", "关闭"]);
    await page.getByRole("option", { name: label, exact: true }).click();
    await page.getByRole("button", { name: "保存设置", exact: true }).first().click();
    await expect.poll(() => page.evaluate(() => window.__pixelTest.data.settings.downloadTaskDisplay)).toBe(mode);
  };
  await nav.getByRole("button", { name: "设置", exact: true }).click();
  await expect(display).toContainText("关闭");
  await setDisplay("always", "始终");
  await expect(sidebar.locator(".sidebar-downloads")).toBeVisible();
  await expect(tip).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "下载中心", exact: true })).toHaveCount(0);
  await setDisplay("active", "下载时");
  await expect(sidebar.locator(".sidebar-downloads")).toBeVisible();
  await expect(tip).toHaveCount(0);
  await page.evaluate(() => {
    window.__pixelTest.tasks.downloads.forEach((download) => { download.status = "completed"; });
    window.__pixelTest.tasks.jobs.forEach((job) => { job.status = "completed"; });
  });
  await expect(sidebar.locator(".sidebar-downloads")).toHaveCount(0);
  await expect(tip).toBeVisible();
  for (const status of ["queued", "running", "pausing", "paused"]) {
    await page.evaluate((status) => { window.__pixelTest.tasks.downloads[0].status = status; }, status);
    await expect(sidebar.locator(".sidebar-downloads")).toHaveAttribute("data-status", status);
  }
  for (const status of ["failed", "cancelled", "completed"]) {
    await page.evaluate((status) => { window.__pixelTest.tasks.downloads[0].status = status; }, status);
    await expect(sidebar.locator(".sidebar-downloads")).toHaveCount(0);
  }
  await setDisplay("off", "关闭");
  await page.evaluate(() => { window.__pixelTest.tasks.downloads[0].status = "running"; });
  await expect(sidebar.locator(".sidebar-downloads")).toHaveCount(0);
  await nav.getByRole("button", { name: "开始游戏", exact: true }).click();
  await nav.getByRole("button", { name: "设置", exact: true }).click();
  await expect(display).toContainText("关闭");
  await display.scrollIntoViewIfNeeded();
  await settled();
  await shot("download-settings");
  extraChecks.push("新旧配置默认隐藏；设置三选项可保存；下载时覆盖未结束的下载与步骤任务，全部结束后延迟收起，关闭时下载也不显示");

  await ready();
  // Active class is retained for compatibility but does not determine visuals.
  const selected = nav.getByRole("button", { name: "开始游戏", exact: true });
  const appearance = (el) => { const s = getComputedStyle(el); return [s.color, s.translate, s.getPropertyValue("--surface-fill"), s.getPropertyValue("--surface-marker")]; };
  const beforeClassChange = await selected.evaluate(appearance);
  await selected.evaluate((el) => el.classList.remove("active"));
  expect(await selected.evaluate(appearance)).toEqual(beforeClassChange);
  const unselected = nav.getByRole("button", { name: "版本管理", exact: true });
  const unselectedBefore = await unselected.evaluate(appearance);
  await unselected.evaluate((el) => el.classList.add("active"));
  expect(await unselected.evaluate(appearance)).toEqual(unselectedBefore);
  await ready();
  await unselected.hover();
  await page.mouse.down();
  await expect(unselected).toHaveCSS("translate", "0px 2px");
  expect(await unselected.evaluate((el) => getComputedStyle(el).getPropertyValue("--surface-depth").trim())).toBe("0px");
  await page.mouse.up();
  extraChecks.push("选中外观只认 aria-current；按下位移 2px 并收起底座");

  // Six theme/accent combinations, including the brightest point of the sheen.
  await ready();
  for (const theme of ["light", "dark"]) {
    for (const accent of ["forest", "puce", "ebony"]) {
      await page.evaluate(({ theme, accent }) => Object.assign(document.documentElement.dataset, { theme, accent }), { theme, accent });
      await page.mouse.move(1200, 800);
      await settled();
      const contrast = await selected.evaluate((el) => {
        const rgb = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number);
        const lum = (c) => c.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
        const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
        const fg = rgb(getComputedStyle(el).color);
        const bg = rgb(getComputedStyle(el.querySelector(".surface-frame"), "::after").backgroundColor);
        const shine = bg.map((v) => v * 0.93 + 255 * 0.07);
        return { base: ratio(fg, bg), sheen: ratio(fg, shine) };
      });
      themes.push({ theme, accent, ...contrast });
      expect(contrast.base).toBeGreaterThanOrEqual(4.5);
      expect(contrast.sheen).toBeGreaterThanOrEqual(4.5);
      await shot(`${theme}-${accent}`);
    }
  }
  extraChecks.push("六种主题与配色，选中文本及光带峰值对比度均 >= 4.5:1");

  await ready();
  for (const [width, expectedWidth] of [[1440, 216], [1120, 216], [1100, 185], [851, 185], [850, 66], [650, 62], [375, 62]]) {
    await page.setViewportSize({ width, height: width === 1120 ? 640 : 600 });
    await expect(sidebar).toHaveClass(width <= 850 ? /rail-collapsed/ : /^sidebar\s*$/);
    await settled();
    const layout = await sidebar.evaluate((rail) => {
      const box = rail.getBoundingClientRect();
      const outside = [...rail.querySelectorAll("button")].filter(el => getComputedStyle(el).visibility !== 'hidden').filter((el) => {
        const b = el.getBoundingClientRect();
        const minSize = el.closest('.brand') ? 38 * parseFloat(getComputedStyle(el).getPropertyValue('--brand-scale')) : 38;
        return b.left < box.left || b.right > box.right || b.width < minSize || b.height < minSize;
      }).map((el) => el.className);
      return { width: box.width, outside, overflow: rail.scrollWidth > rail.clientWidth, bodyOverflow: document.documentElement.scrollWidth > innerWidth };
    });
    layouts.push({ viewport: width, ...layout });
    expect(layout.width).toBe(expectedWidth);
    expect(layout.outside).toEqual([]);
    expect(layout.overflow).toBe(false);
    expect(layout.bodyOverflow).toBe(false);
    await expect(collapse).toHaveAttribute("aria-expanded", width <= 850 ? "false" : "true");
    if (width <= 850) await expect(collapse).toBeDisabled();
    await shot(`width-${width}`);
  }
  await shot("narrow");
  await page.setViewportSize({ width: 1100, height: 600 });
  await settled();
  await toggleRail();
  await settled();
  expect((await sidebar.boundingBox()).width).toBe(66);
  await page.setViewportSize({ width: 650, height: 600 });
  await settled();
  expect((await sidebar.boundingBox()).width).toBe(62);
  await page.setViewportSize({ width: 1440, height: 600 });
  await expect(collapse).toHaveAttribute("aria-expanded", "false");
  await toggleRail();
  extraChecks.push("216/185/66/62px 四档，375px 至 1440px 无溢出；手动偏好在跨断点后保留");

  await ready("long-name");
  const longName = sidebar.locator(".profile-copy strong");
  expect(await longName.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === "ellipsis" && getComputedStyle(el).whiteSpace === "nowrap")).toBe(true);
  await shot("long-name");
  await ready();
  await page.keyboard.press('Tab');
  const sequence = [collapse, brand, ...names.map((name) => nav.getByRole("button", { name, exact: true })), sidebar.locator(".sidebar-task"), sidebar.locator(".profile-button")];
  for (const [index, button] of sequence.entries()) {
    if (index) await page.keyboard.press("Tab");
    await expect(button).toBeFocused();
    expect(await button.evaluate((el) => {
      const cs = getComputedStyle(el), b = el.getBoundingClientRect(), rail = el.closest(".sidebar").getBoundingClientRect();
      const space = parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset);
      return cs.outlineStyle !== "none" && cs.clipPath === "none" && b.left - space >= rail.left && b.right + space <= rail.right && b.top - space >= rail.top && b.bottom + space <= rail.bottom;
    })).toBe(true);
    if (index >= 1 && index <= names.length + 1) await page.keyboard.press("Enter");
  }
  // Compact buttons can keep the profile visible at 600px without scrolling.
  // Use a shorter viewport to exercise keyboard scrolling when it is needed.
  await page.setViewportSize({ width: 1440, height: 320 });
  await collapse.focus();
  await sidebar.locator('.profile-button').focus();
  expect(await sidebar.evaluate((el) => el.scrollTop > 0)).toBe(true);
  await shot("keyboard-scroll");
  extraChecks.push("20 字符以上用户名省略；600px 高窗口 Tab/Enter 走查；320px 高窗口聚焦角色入口时侧栏自动滚动");

  await page.setViewportSize({ width: 1440, height: 900 });
  await ready();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await brand.hover();
  await expect(sidebar.locator('.brand-mark')).toHaveCSS('rotate', '8deg');
  await expect(sidebar.locator('.brand-mark')).toHaveCSS('scale', '1.1');
  expect(await selected.locator(".surface-frame").evaluate((el) => getComputedStyle(el, "::after").animationName)).toBe("rail-sheen");
  for (const file of ["src/styles.css", "src/sidebar.css", "src/controls.css", "src/launch-dock.css"]) expect(await readFile(projectPath(file), "utf8")).not.toContain("prefers-reduced-motion");
  extraChecks.push("D2：系统减少动态效果开启时仍保留动画，全部现有停用规则已移除");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => Object.assign(document.documentElement.dataset, { theme, accent: "forest" }), theme);
    for (const [index, name] of names.entries()) {
      await nav.getByRole("button", { name, exact: true }).click();
      await page.screenshot({ path: `${evidence}/sidebar-after/${ids[index]}-${theme}.png`, animations: "disabled" });
    }
  }
  expect(errors).toEqual([]);
  expect(checks).toHaveLength(17);
  console.log(`PASS ${checks.length}/17 sidebar assertions; ${extraChecks.length} behavior groups; no page errors.`);
} catch (error) {
  await shot("failure");
  errors.push(String(error));
  process.exitCode = 1;
  console.error(error);
} finally {
  await writeFile(`${evidence}/sidebar-checks.json`, JSON.stringify({ checks, extraChecks, themes, layouts, errors }, null, 2));
  await browser.close();
}
