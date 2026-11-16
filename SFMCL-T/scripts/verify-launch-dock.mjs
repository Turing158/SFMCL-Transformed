import { runtimePath } from "./lib/paths.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { launchDockFixture } from "./fixtures/launch-dock.mjs";

const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/";
const evidence =
  process.env.SFMCL_T_LAUNCH_DOCK_EVIDENCE ||
  runtimePath("evidence/launch-dock-project");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(8000);
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript({
  content: `(${pixelAppFixture.toString()})({ components: true }); (${launchDockFixture.toString()})();`,
});
const dock = page.locator(".launch-dock");
const primary = dock.locator(".launch-primary");
const versionLayout = () =>
  dock
    .locator(".launch-version")
    .evaluate((node) =>
      Array.from(
        node.querySelectorAll(".resource-icon, h3, .launch-version-tags"),
        (element) => [
          element.offsetLeft,
          element.offsetTop,
          element.offsetWidth,
          element.offsetHeight,
        ],
      ),
    );
const change = dock.locator(".launch-switch");
const picker = page.getByRole("dialog", { name: "选择游戏版本", exact: true });
const viewport = picker.locator(".launch-version-viewport");
const edgeOpacity = (pseudo) =>
  viewport.evaluate(
    (node, pseudo) => Number(getComputedStyle(node, pseudo).opacity),
    pseudo,
  );
const scrollFrames = (position) =>
  viewport.evaluate(async (node, position) => {
    const list = node.querySelector(".launch-version-list");
    const frames = [];
    list.scrollTop = (list.scrollHeight - list.clientHeight) * position;
    const start = performance.now();
    await new Promise((resolve) => {
      const sample = (time) => {
        frames.push({
          top: Number(getComputedStyle(node, "::before").opacity),
          bottom: Number(getComputedStyle(node, "::after").opacity),
        });
        if (time - start < 360) requestAnimationFrame(sample);
        else resolve();
      };
      requestAnimationFrame(sample);
    });
    return frames;
  }, position);
const nav = (name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const count = (operation) =>
  page.evaluate(
    (op) =>
      window.__pixelTest.requests.filter((request) => request.operation === op)
        .length,
    operation,
  );
const ready = async (scenario = "") => {
  await page.goto(`${url}?dock-test=${scenario}`);
  await expect(dock).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: scenario === "no-player" ? "准备好，开启新的冒险" : "你好，Alex",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .locator("main")
    .evaluate((main) =>
      Promise.allSettled(
        main.getAnimations().map((animation) => animation.finished),
      ),
    );
};
const state = (value) => expect(dock).toHaveAttribute("data-state", value);
const shot = (name) =>
  page.screenshot({ path: `${evidence}/${name}.png`, animations: "disabled" });
const dragCard = async (distance, release = true) => {
  const card = dock.locator(".launch-dock-main");
  let bounds = await card.boundingBox();
  await page.mouse.move(
    bounds.x + bounds.width * 0.42,
    bounds.y + bounds.height * 0.65,
  );
  await expect(dock.locator(".launch-dock-card")).toHaveCSS("scale", "1");
  bounds = await card.boundingBox();
  const x = bounds.x + bounds.width * 0.42;
  const y = bounds.y + bounds.height * 0.65;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - distance, { steps: 6 });
  if (release) await page.mouse.up();
};

try {
  await ready();
  await state("ready");
  await expect(
    dock.locator(".overline, .launch-progress, .launch-status-detail"),
  ).toHaveCount(0);
  await expect(primary).toHaveAccessibleName("开始游戏");
  await expect(primary).toHaveAttribute("data-tooltip", "准备就绪");
  await expect(page.locator("main .launch-card")).toHaveCount(0);
  await expect(page.locator(".workspace-footer")).toHaveCount(0);
  await shot("desktop-light");
  await change.click();
  const search = picker.getByRole("searchbox", {
    name: "搜索本地版本",
    exact: true,
  });
  await expect(search).toBeFocused();
  await expect(picker.locator(".launch-picker-footer")).toHaveCount(0);
  expect(await edgeOpacity("::before")).toBe(0);
  expect(await edgeOpacity("::after")).toBe(0);
  await expect(
    picker.getByRole("button", { name: "安装新版本", exact: true }),
  ).toHaveCount(0);
  await shot("desktop-picker");
  await search.fill("fabric");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await expect(picker.getByRole("option")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    dock.getByRole("heading", { name: "1.20.1-Fabric", exact: true }),
  ).toBeVisible();
  await expect(change).toBeFocused();
  expect(await count("versions.select")).toBe(1);
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.activeVersion),
  ).toBe("1.20.1-Fabric");
  checks.push(
    "Version search and keyboard selection persist through versions.select without leaving home; focus returns to the trigger",
  );

  await change.click();
  await search.fill("not-installed");
  await expect(
    picker.getByText("没有找到这个版本", { exact: true }),
  ).toBeVisible();
  await expect(
    picker
      .locator(".launch-picker-empty")
      .getByRole("button", { name: "安装新版本", exact: true }),
  ).toBeVisible();
  await expect(picker.locator(".launch-picker-footer")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(picker).toBeVisible();
  await expect(
    picker.getByRole("button", { name: "安装新版本", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await change.click();
  await page.getByRole("heading", { name: "你好，Alex", exact: true }).click();
  await expect(picker).toBeHidden();
  checks.push(
    "Search empty state, two-stage Escape and outside-click dismissal",
  );

  await page.evaluate(() => {
    window.__pixelTest.failures["versions.select"] = "磁盘暂时不可写";
    window.__pixelTest.delays["versions.select"] = 250;
  });
  await change.click();
  await picker.getByRole("option", { name: /^1\.21\.4/ }).click();
  await expect(picker.getByRole("alert")).toContainText("磁盘暂时不可写");
  await expect(picker).toBeVisible();
  await expect(
    dock.getByRole("heading", { name: "1.20.1-Fabric", exact: true }),
  ).toBeVisible();
  await page.evaluate(
    () => delete window.__pixelTest.failures["versions.select"],
  );
  await picker.getByRole("option", { name: /^1\.21\.4/ }).click();
  await expect(picker).toBeHidden();
  await expect(change).toBeFocused();
  checks.push(
    "Failed version saves keep the old selection and can be retried in the open picker",
  );

  await page.evaluate(() => {
    window.__pixelTest.holdLaunch = true;
    window.__pixelTest.delays.launch = 300;
  });
  const beforeLaunchVersionLayout = await versionLayout();
  await primary.click();
  await expect(primary).toBeDisabled();
  await primary.evaluate((button) => button.click());
  await expect.poll(() => count("launch")).toBe(1);
  await expect(dock.getByRole("status")).toContainText("正在读取启动进度");
  await expect(primary).toHaveAttribute("data-indeterminate", "true");
  await expect(primary.getByRole("progressbar")).not.toHaveAttribute(
    "aria-valuenow",
  );
  const waitingFrames = await primary.evaluate(async (button) => {
    const frames = [];
    const start = performance.now();
    await new Promise((resolve) => {
      const sample = (time) => {
        frames.push(
          parseFloat(
            getComputedStyle(button).getPropertyValue(
              "--launch-button-progress",
            ),
          ),
        );
        if (time - start < 1800) requestAnimationFrame(sample);
        else resolve();
      };
      requestAnimationFrame(sample);
    });
    return frames;
  });
  await writeFile(
    `${evidence}/waiting-frames.json`,
    JSON.stringify(waitingFrames),
  );
  expect(waitingFrames.every((value) => value === 0)).toBe(true);
  await primary.evaluate((button) => button.click());
  expect(await count("launch")).toBe(1);
  await page.evaluate(() => window.__pixelTest.publishLaunch());
  await state("preparing");
  expect(await versionLayout()).toEqual(beforeLaunchVersionLayout);
  await expect(change).toHaveText("取消启动");
  await expect(change).toBeEnabled();
  await expect(primary.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "0",
  );
  await expect(primary).toHaveAccessibleName("正在启动 0%");
  await expect(primary).not.toHaveAttribute("data-indeterminate");
  await change.click();
  await state("ready");
  expect(
    await primary.evaluate((button) =>
      parseFloat(
        getComputedStyle(button).getPropertyValue("--launch-button-progress"),
      ),
    ),
  ).toBe(0);
  expect(await count("jobs.cancel")).toBe(1);
  checks.push(
    "Start is guarded before the request and between job creation and polling; cancellation targets the returned job",
  );

  await primary.click();
  await expect(change).toBeEnabled();
  await expect(primary).toHaveAccessibleName("正在启动 0%");
  await page.evaluate(() => window.__pixelTest.advanceLaunch(2));
  await expect(primary).toHaveAccessibleName("正在启动 50%");
  await expect(primary.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "50",
  );
  await expect
    .poll(() =>
      primary.evaluate((button) =>
        getComputedStyle(button)
          .getPropertyValue("--launch-button-progress")
          .trim(),
      ),
    )
    .toBe("50%");
  const split = await primary.evaluate((button) => {
    const surface = button
      .querySelector(".launch-button-surface")
      .getBoundingClientRect();
    const base = button.querySelector(".launch-button-base > span");
    const fill = button.querySelector(".launch-button-fill-label");
    const boundary = surface.left + surface.width / 2;
    const text = base.firstChild;
    let splitCharacter = "";
    for (let index = 0; index < text.length; index++) {
      const range = document.createRange();
      range.setStart(text, index);
      range.setEnd(text, index + 1);
      const bounds = range.getBoundingClientRect();
      if (bounds.left < boundary && bounds.right > boundary)
        splitCharacter = text.textContent[index];
    }
    return {
      splitCharacter,
      textOffset: Math.abs(
        base.getBoundingClientRect().left - fill.getBoundingClientRect().left,
      ),
      baseColor: getComputedStyle(base).color,
      fillColor: getComputedStyle(fill).color,
      width: button.offsetWidth,
      height: button.offsetHeight,
    };
  });
  expect(split.splitCharacter.trim()).not.toBe("");
  expect(split.textOffset).toBeLessThan(0.1);
  expect(split.baseColor).not.toBe(split.fillColor);
  expect(split.width).toBe(156);
  expect(split.height).toBe(46);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    await primary.screenshot({
      path: `${evidence}/button-half-${theme}.png`,
      animations: "disabled",
    });
    await shot(`launch-half-${theme}`);
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  const progressFrames = await primary.evaluate(async (button) => {
    window.__pixelTest.advanceLaunch(3);
    const frames = [];
    const start = performance.now();
    let arrivedAt = 0;
    await new Promise((resolve) => {
      const sample = (time) => {
        frames.push(
          parseFloat(
            getComputedStyle(button).getPropertyValue(
              "--launch-button-progress",
            ),
          ),
        );
        if (!arrivedAt && frames.at(-1) === 75) arrivedAt = time;
        if (time - start < 3000 && (!arrivedAt || time - arrivedAt < 100))
          requestAnimationFrame(sample);
        else resolve();
      };
      requestAnimationFrame(sample);
    });
    return frames;
  });
  await expect(primary).toHaveAccessibleName("正在启动 75%");
  await writeFile(
    `${evidence}/progress-frames.json`,
    JSON.stringify(progressFrames),
  );
  expect(progressFrames.some((value) => value > 50 && value < 75)).toBe(true);
  expect(progressFrames.at(-1)).toBe(75);
  expect(
    progressFrames.every(
      (value, index) =>
        index === 0 || value >= progressFrames[index - 1] - 0.01,
    ),
  ).toBe(true);
  checks.push(
    "Button fill follows real progress smoothly, splits individual glyphs at the same boundary in both themes, retains its size and exposes one accessible label",
  );
  const pausedProgressFrames = await primary.evaluate(async (button) => {
    window.__pixelTest.downloadState("paused");
    const frames = [];
    const start = performance.now();
    let pausedAt = 0;
    await new Promise((resolve) => {
      const sample = (time) => {
        frames.push(
          parseFloat(
            getComputedStyle(button).getPropertyValue(
              "--launch-button-progress",
            ),
          ),
        );
        if (!pausedAt && button.getAttribute("aria-label") === "继续启动")
          pausedAt = time;
        if (time - start < 3000 && (!pausedAt || time - pausedAt < 300))
          requestAnimationFrame(sample);
        else resolve();
      };
      requestAnimationFrame(sample);
    });
    return frames;
  });
  await writeFile(
    `${evidence}/paused-progress-frames.json`,
    JSON.stringify(pausedProgressFrames),
  );
  expect(pausedProgressFrames.every((value) => value === 75)).toBe(true);
  await state("paused");
  await expect(primary).toHaveText("继续启动");
  await expect(primary.locator(".launch-button-base > svg")).toHaveClass(
    /lucide-pause/,
  );
  await expect(primary.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "75",
  );
  await expect(primary).toHaveAttribute("data-tooltip", /下载已暂停/);
  await primary.screenshot({
    path: `${evidence}/button-paused.png`,
    animations: "disabled",
  });
  await primary.click();
  await state("preparing");
  expect(await count("launch")).toBe(2);
  await page.evaluate(() => window.__pixelTest.downloadState("failed"));
  await state("download-error");
  await expect(primary).toHaveText("重试下载");
  await expect(primary).toHaveAttribute("data-tooltip", /资源服务器连接中断/);
  await primary.screenshot({
    path: `${evidence}/button-download-error.png`,
    animations: "disabled",
  });
  await expect(dock.getByRole("status")).toContainText("资源服务器连接中断");
  await primary.click();
  await state("preparing");
  expect(await count("launch")).toBe(2);
  expect(await count("downloads.control")).toBe(2);
  checks.push(
    "Paused and failed downloads resume the original workflow without launching a second game",
  );

  await page.evaluate(() => window.__pixelTest.advanceLaunch(4));
  await state("running");
  expect(await versionLayout()).toEqual(beforeLaunchVersionLayout);
  await expect(primary).toHaveText("结束游戏");
  await expect(primary.getByRole("progressbar")).toHaveCount(0);
  await expect(primary).toHaveAttribute("data-tooltip", /游戏已启动/);
  await primary.screenshot({
    path: `${evidence}/button-running.png`,
    animations: "disabled",
  });
  await expect
    .poll(() =>
      primary.evaluate((button) =>
        getComputedStyle(button)
          .getPropertyValue("--launch-button-progress")
          .trim(),
      ),
    )
    .toBe("100%");
  await expect(change).toHaveText("继续启动");
  const firstGame = await page.evaluate(
    () => window.__pixelTest.latestLaunch.id,
  );
  await change.click();
  await state("ready");
  await expect(primary).toBeEnabled();
  await expect(dock.getByRole("status")).not.toContainText("请切换版本");
  const toggle = dock.locator(".launch-process-toggle");
  const processes = dock.getByRole("region", {
    name: "收起的游戏进程",
    exact: true,
  });
  await expect(toggle).toHaveText("展开");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle.locator("svg")).toHaveCount(1);
  await expect(processes).toBeHidden();
  expect(await count("jobs.cancel")).toBe(1);

  // The launch row follows the pointer; a short pull returns to its old state.
  const clip = dock.locator(".launch-processes-clip");
  await dragCard(20, false);
  await expect(dock).toHaveAttribute("data-dragging", "true");
  await expect
    .poll(async () => (await clip.boundingBox()).height)
    .toBeCloseTo(20, 0);
  await page.mouse.up();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(processes).toBeHidden();
  await dragCard(60, false);
  await expect(dock).toHaveAttribute("data-dragging", "true");
  await expect
    .poll(async () => (await clip.boundingBox()).height)
    .toBeCloseTo(60, 0);
  await page.mouse.up();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(processes).toBeVisible();
  await expect(dock).not.toHaveAttribute("data-dragging");
  await page.locator(".page-heading").hover();
  await expect(dock.locator(".launch-dock-card")).toHaveCSS("scale", "1");
  const joinedBounds = await dock.evaluate((node) => {
    const row = node.querySelector(".launch-dock-main").getBoundingClientRect();
    const panel = node
      .querySelector(".launch-processes")
      .getBoundingClientRect();
    return {
      left: panel.left - row.left,
      width: panel.width - row.width,
      gap: panel.top - row.bottom,
    };
  });
  expect(joinedBounds.left).toBeCloseTo(0, 1);
  expect(joinedBounds.width).toBeCloseTo(0, 1);
  expect(joinedBounds.gap).toBeCloseTo(0, 1);
  // Dragging the process list does not operate the launch-row disclosure.
  const listBounds = await processes.boundingBox();
  await page.mouse.move(listBounds.x + 20, listBounds.y + 40);
  await page.mouse.down();
  await page.mouse.move(listBounds.x + 20, listBounds.y + 5, { steps: 4 });
  await page.mouse.up();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(dock).not.toHaveAttribute("data-dragging");
  await dragCard(-60);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(processes).toBeHidden();
  await page.locator(".page-heading").hover();
  await expect(dock.locator(".launch-dock-card")).toHaveCSS("scale", "0.98");
  // Controls retain their own pointer handling and normal click behavior.
  const switchBounds = await change.boundingBox();
  await page.mouse.move(
    switchBounds.x + switchBounds.width / 2,
    switchBounds.y + switchBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    switchBounds.x + switchBounds.width / 2,
    switchBounds.y - 60,
    { steps: 4 },
  );
  await page.mouse.up();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(dock).not.toHaveAttribute("data-dragging");
  await change.click();
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  checks.push(
    "Only the launch row supports dragging; upward and downward pulls reveal or hide the content, partial pulls follow the pointer and snap back, and buttons and process-list scrolling retain their behavior",
  );

  const collapsedBounds = await dock.locator(".launch-dock-main").boundingBox();
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveText("收起");
  await expect(processes).toBeVisible();
  await expect(processes.getByRole("listitem")).toHaveCount(1);
  const firstCard = processes.locator(`[data-job-id="${firstGame}"]`);
  const launchedAt = await page.evaluate(
    () => window.__pixelTest.latestLaunch.createdAt,
  );
  await expect(firstCard.locator("time")).toHaveAttribute(
    "datetime",
    new Date(launchedAt * 1000).toISOString(),
  );
  await expect(firstCard.locator(".resource-icon")).toBeVisible();
  await expect(firstCard.locator("strong")).toHaveText("1.21.4");
  const expansionHeight = (await processes.boundingBox()).height;
  await expect
    .poll(async () => (await dock.locator(".launch-dock-main").boundingBox()).y)
    .toBeLessThan(collapsedBounds.y - expansionHeight + 5);
  await shot("running-process-expanded");

  const mainRow = dock.locator(".launch-dock-main");
  const launchesBeforeRestore = await count("launch");
  const stopsBeforeRestore = await count("jobs.cancel");
  await firstCard.click();
  await state("running");
  await expect(mainRow).toHaveAttribute("data-job-id", firstGame);
  await expect(primary).toHaveText("结束游戏");
  await expect(change).toHaveText("继续启动");
  await expect(primary).toBeFocused();
  await expect(toggle).toBeHidden();
  await shot("running-process-restored");
  await change.click();
  await state("ready");
  await toggle.click();
  await firstCard.locator(".launch-process-restore").focus();
  await page.keyboard.press("Enter");
  await expect(mainRow).toHaveAttribute("data-job-id", firstGame);
  await expect(primary).toBeFocused();
  expect(await count("launch")).toBe(launchesBeforeRestore);
  expect(await count("jobs.cancel")).toBe(stopsBeforeRestore);
  await change.click();
  await state("ready");
  await toggle.click();
  checks.push(
    "Clicking a collapsed card or pressing Enter restores its existing process to the main controls without launching or stopping a game, and focus follows the restored controls",
  );

  // The collection retains its processes and open state across page navigation.
  await page.locator(".sidebar-downloads").click();
  await expect(
    page.getByRole("heading", { name: "下载中心", exact: true }),
  ).toBeVisible();
  await expect(dock).toHaveAttribute("aria-hidden", "true");
  await expect(dock).toHaveAttribute("inert", "");
  await expect(dock.locator(".launch-dock-card")).toHaveCSS("opacity", "0");
  await expect(page.locator(".workspace-footer")).toBeVisible();
  await nav("开始游戏");
  await state("ready");
  await expect(processes).toBeVisible();
  await toggle.click();
  await expect(processes).toBeHidden();
  // A second launch of the selected version keeps the first process alive.
  await primary.click();
  await state("preparing");
  await expect
    .poll(() => page.evaluate(() => window.__pixelTest.latestLaunch.id))
    .not.toBe(firstGame);
  await expect(change).toBeEnabled();
  const repeatedGame = await page.evaluate(
    () => window.__pixelTest.latestLaunch.id,
  );
  expect(repeatedGame).not.toBe(firstGame);
  await page.evaluate(() => window.__pixelTest.advanceLaunch(4));
  await state("running");
  await toggle.click();
  await firstCard.locator(".launch-process-restore").click();
  await expect(mainRow).toHaveAttribute("data-job-id", firstGame);
  await toggle.click();
  const repeatedCard = processes.locator(`[data-job-id="${repeatedGame}"]`);
  await repeatedCard.locator(".launch-process-restore").focus();
  await page.keyboard.press("Space");
  await expect(mainRow).toHaveAttribute("data-job-id", repeatedGame);
  expect(await count("launch")).toBe(launchesBeforeRestore + 1);
  expect(await count("jobs.cancel")).toBe(stopsBeforeRestore);
  await change.click();
  await state("ready");
  await expect(primary).toBeEnabled();
  await toggle.click();
  await expect(processes.getByRole("listitem")).toHaveCount(2);
  await expect(processes.locator("strong")).toHaveText(["1.21.4", "1.21.4"]);
  await repeatedCard.locator(".launch-process-stop").click();
  await expect(processes.getByRole("listitem")).toHaveCount(1);
  await state("ready");
  expect(
    await page.evaluate(
      (id) => window.__pixelTest.tasks.jobs.find((job) => job.id === id).status,
      firstGame,
    ),
  ).toBe("running");
  await toggle.click();
  checks.push(
    "The same version can launch again after collapse; duplicate processes can switch between the main controls by ID, and the stop icon only stops its own process without restoring it",
  );
  await change.click();
  await picker.getByRole("option", { name: /^1\.20\.1-Fabric/ }).click();
  await expect(primary).toBeEnabled();
  await primary.click();
  await expect(change).toBeEnabled();
  await page.evaluate(() => window.__pixelTest.advanceLaunch(4));
  await state("running");
  await change.click();
  await state("ready");
  await toggle.click();
  await expect(processes.getByRole("listitem")).toHaveCount(2);
  await page.evaluate(() => {
    const test = window.__pixelTest;
    for (let index = 1; index <= 4; index++) {
      const copy = structuredClone(test.latestLaunch);
      copy.id = `extra-game-${index}`;
      copy.title = `启动 我的长期生存世界与大型模组整合包-${index}`;
      copy.launch.versionId = copy.title.slice(3);
      test.tasks.jobs.unshift(copy);
    }
  });
  for (let index = 1; index <= 4; index++) {
    await state("running");
    await change.click();
  }
  await state("ready");
  await toggle.click();
  await expect(processes.getByRole("listitem")).toHaveCount(6);
  for (const width of [1440, 768, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 568 : 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (value) => (document.documentElement.dataset.theme = value),
        theme,
      );
      await expect(dock).not.toHaveAttribute("data-disclosure-animating");
      await page.locator(".workspace-footer-region").evaluate(async (node) => {
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        await Promise.allSettled(
          node.getAnimations().map((animation) => animation.finished),
        );
      });
      const grid = processes.locator(".launch-process-grid");
      const geometry = await grid.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const cards = Array.from(node.children, (card) =>
          card.getBoundingClientRect(),
        );
        return {
          rows: new Set(cards.map((card) => Math.round(card.top))).size,
          columns: new Set(cards.map((card) => Math.round(card.left))).size,
          width: bounds.width,
          scrollWidth: node.scrollWidth,
          bottom: node.closest(".launch-processes").getBoundingClientRect()
            .bottom,
          scrollHeight: node.closest(".launch-processes").scrollHeight,
          clientHeight: node.closest(".launch-processes").clientHeight,
          viewport: window.innerHeight,
          bodyWidth: document.body.scrollWidth,
        };
      });
      expect(geometry.rows).toBe(3);
      expect(geometry.columns).toBe(2);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
      if (width > 650) {
        expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
      }
      expect(geometry.bottom).toBeLessThan(geometry.viewport);
      expect(geometry.bodyWidth).toBe(width);
      await processes.evaluate((node) => (node.scrollTop = node.scrollHeight));
      await expect(
        processes.getByRole("listitem").last().locator(".launch-process-stop"),
      ).toBeInViewport();
      await shot(`processes-${width}-${theme}`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await processes.evaluate((node) => (node.scrollTop = 0));
  // A failed stop preserves the live card and allows retry.
  await page.evaluate(
    () => (window.__pixelTest.failures["jobs.cancel"] = "测试：结束失败"),
  );
  await firstCard.locator(".launch-process-stop").click();
  await expect(firstCard.locator(".launch-process-stop")).toBeEnabled();
  await expect(firstCard).toBeVisible();
  await page
    .locator(".toast.error")
    .filter({ hasText: "测试：结束失败" })
    .click();
  await page.evaluate(() => {
    delete window.__pixelTest.failures["jobs.cancel"];
    window.__pixelTest.delays["jobs.cancel"] = 300;
  });
  const stopsBefore = await count("jobs.cancel");
  await firstCard.locator(".launch-process-stop").click();
  await expect(firstCard.locator(".launch-process-stop")).toBeDisabled();
  await expect(firstCard).toHaveCount(0);
  expect(await count("jobs.cancel")).toBe(stopsBefore + 1);
  await expect(processes.getByRole("listitem")).toHaveCount(5);
  expect(
    await page.evaluate(() => window.__pixelTest.latestLaunch.status),
  ).toBe("running");
  // Natural exits also disappear; the handle vanishes after the last exit.
  await page.evaluate(() => {
    for (const job of window.__pixelTest.tasks.jobs) {
      if (job.launch?.running) {
        job.status = "completed";
        job.launch.running = false;
      }
    }
  });
  await expect(toggle).toBeHidden();
  await expect(processes).toHaveCount(0);
  await expect(primary).toBeEnabled();
  await state("ready");
  checks.push(
    "Continue launch collapses without stopping; the centered keyboard-accessible handle reveals two columns with icons, names and launch times; independent stop, retry, natural exit, page retention and vertical scrolling work in narrow layouts",
  );

  await page.evaluate(
    () =>
      (window.__pixelTest.failures.launch = "Microsoft 登录已失效，请刷新登录"),
  );
  await primary.click();
  await state("failed");
  await expect(primary).toHaveText("重试启动");
  // The notification enters from below; measure once it clears the dock.
  await expect
    .poll(async () => {
      const toast = await page.locator(".toast.error").boundingBox();
      const footer = await dock.boundingBox();
      return toast.y + toast.height - footer.y;
    })
    .toBeLessThan(0);
  await page.evaluate(() => delete window.__pixelTest.failures.launch);
  await primary.click();
  await expect(change).toBeEnabled();
  await page.evaluate(() => {
    window.__pixelTest.latestLaunch.status = "failed";
    window.__pixelTest.latestLaunch.error = "未找到兼容的 Java 21";
  });
  await state("failed");
  await expect(dock.getByRole("status")).toContainText("未找到兼容的 Java 21");
  await primary.click();
  await expect(change).toBeEnabled();
  await change.click();
  await state("ready");
  checks.push(
    "Both preflight and background failures expose retry; error notifications remain above the launch actions",
  );

  await ready("jobs-only");
  await expect(
    page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "下载中心", exact: true }),
  ).toHaveCount(0);
  await primary.click();
  await expect(change).toBeEnabled();
  await expect(page.locator(".sidebar-downloads")).toBeVisible();
  await page.evaluate(() => window.__pixelTest.advanceLaunch(4));
  await state("running");
  await change.click();
  await state("ready");
  await expect(dock.locator(".launch-process-toggle")).toHaveText("展开");
  checks.push(
    "Launch jobs without downloads retain sidebar task progress and can be collapsed from the dock",
  );

  await ready("empty");
  await state("empty");
  await expect(primary).toBeDisabled();
  await expect(
    dock.getByRole("heading", { name: "选择你的第一个版本", exact: true }),
  ).toBeVisible();
  await change.click();
  await expect(picker.getByRole("option")).toHaveCount(2);
  await expect(
    picker.getByRole("button", { name: "安装新版本", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await nav("版本管理");
  await page
    .locator(".version-management")
    .getByRole("button", { name: "安装新版本", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "安装 Minecraft", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Minecraft", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  checks.push(
    "No selection blocks launch; populated pickers omit installation and version management still opens the Minecraft installation tab",
  );

  await ready("no-dir");
  await change.click();
  await expect(
    picker.getByText("还没有本地游戏", { exact: true }),
  ).toBeVisible();
  await expect(picker.locator(".launch-picker-footer")).toHaveCount(0);
  await picker
    .locator(".launch-picker-empty")
    .getByRole("button", { name: "安装新版本", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "查看 Minecraft 1.21.4 安装配置",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "添加游戏目录", exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "开始安装", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "添加游戏目录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "版本管理", exact: true }),
  ).toBeVisible();
  checks.push(
    "The footer is removed; installation remains centered in the empty placeholder and guides first-time users to add a game directory",
  );

  await ready("no-player");
  await expect(primary).toHaveText("选择角色");
  await primary.click();
  await expect(
    page.getByRole("heading", { name: "角色管理", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("main")
    .getByRole("button", { name: "选择角色 Steve", exact: true })
    .click();
  await nav("开始游戏");
  await state("ready");
  await expect(primary).toBeEnabled();
  checks.push(
    "Missing-player action uses the real role-management flow and unlocks launch after selection",
  );

  await ready("invalid");
  await state("invalid");
  await expect(primary).toHaveText("管理版本");
  await change.click();
  await expect(
    picker.getByRole("option", { name: /^1\.21\.4/ }),
  ).toBeDisabled();
  await search.press("ArrowDown");
  await expect(
    picker.getByRole("option", { name: /^1\.20\.1-Fabric/ }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await state("ready");
  checks.push(
    "Broken versions expose management and cannot be selected or launched; keyboard navigation skips them",
  );

  await ready();
  const layouts = [];
  for (const width of [1440, 1024, 768, 375]) {
    const height = width === 375 ? 812 : 720;
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
        document.querySelector("main").scrollTop = 0;
      }, theme);
      const before = await dock.boundingBox();
      await page
        .locator("main")
        .evaluate((main) => (main.scrollTop = main.scrollHeight));
      const geometry = await page.evaluate(() => {
        const main = document.querySelector("main");
        const footer = document
          .querySelector(".launch-dock")
          .getBoundingClientRect();
        return {
          bottom: footer.bottom,
          top: footer.top,
          mainBottom: main.getBoundingClientRect().bottom,
          statusTop: document
            .querySelector(".launch-status")
            .getBoundingClientRect().top,
          last: Math.max(
            ...Array.from(
              main.querySelectorAll(
                ".page-heading, .notice-card, .notices .helper, .notices .inline-error",
              ),
              (item) => item.getBoundingClientRect().bottom,
            ),
          ),
          overflow: document.body.scrollWidth > innerWidth,
        };
      });
      expect(geometry.bottom).toBe(height);
      expect(geometry.top).toBe(before.y);
      expect(geometry.mainBottom).toBe(geometry.statusTop);
      expect(geometry.last).toBeLessThanOrEqual(geometry.top);
      expect(geometry.overflow).toBe(false);
      await page.locator("main").evaluate((main) => (main.scrollTop = 0));
      if (width === 1440 || width === 375)
        await shot(`${width === 1440 ? "desktop" : "mobile"}-${theme}`);
      await change.click();
      await picker.evaluate((node) =>
        Promise.allSettled(
          node.getAnimations().map((animation) => animation.finished),
        ),
      );
      const bounds = await picker.boundingBox();
      const trigger = await change.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y).toBeGreaterThanOrEqual(40);
      expect(Math.abs(trigger.y - bounds.y - bounds.height - 6)).toBeLessThan(
        0.5,
      );
      await page.keyboard.press("Escape");
      layouts.push({ width, theme, dockHeight: before.height });
    }
  }
  checks.push(
    "At 375/768/1024/1440px in both themes, the dock stays at the bottom, page endings remain reachable and the popup fits",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".brand-logo").hover();
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await expect.poll(async () => (await dock.boundingBox()).x).toBe(60);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await change.click();
  expect(
    await picker.evaluate((element) =>
      element
        .getAnimations()
        .some((animation) => animation.id === "sfmcl-t-version-picker"),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  checks.push(
    "Collapsed sidebar alignment, animations remain enabled with reduced-motion preference (D2), and error-free rendering",
  );
  await ready("many");
  await page.setViewportSize({ width: 375, height: 568 });
  await change.click();
  await expect(viewport).not.toHaveAttribute("data-scroll-top");
  await expect(viewport).toHaveAttribute("data-scroll-bottom", "true");
  await expect.poll(() => edgeOpacity("::before")).toBe(0);
  await expect.poll(() => edgeOpacity("::after")).toBe(1);
  const fadeBounds = await viewport.evaluate((node) => {
    const list = node
      .querySelector(".launch-version-list")
      .getBoundingClientRect();
    const viewport = node.getBoundingClientRect();
    const picker = node.closest(".launch-version-picker");
    const panel = picker.getBoundingClientRect();
    const stroke = parseFloat(
      getComputedStyle(picker).getPropertyValue("--surface-stroke"),
    );
    return {
      uncoveredBottom:
        list.bottom -
        (viewport.bottom -
          parseFloat(getComputedStyle(node, "::after").bottom)),
      frameGap: panel.bottom - list.bottom,
      leftGap: viewport.left - panel.left,
      rightGap: panel.right - viewport.right,
      stroke,
    };
  });
  expect(Math.abs(fadeBounds.uncoveredBottom)).toBeLessThan(0.5);
  expect(fadeBounds.frameGap).toBeGreaterThanOrEqual(fadeBounds.stroke);
  expect(fadeBounds.leftGap).toBeGreaterThanOrEqual(fadeBounds.stroke);
  expect(fadeBounds.rightGap).toBeGreaterThanOrEqual(fadeBounds.stroke);
  const middle = await scrollFrames(0.5);
  expect(middle.some((frame) => frame.top > 0 && frame.top < 1)).toBe(true);
  expect(await edgeOpacity("::before")).toBe(1);
  expect(await edgeOpacity("::after")).toBe(1);
  await shot("picker-scroll-middle");
  const bottom = await scrollFrames(1);
  expect(bottom.some((frame) => frame.bottom > 0 && frame.bottom < 1)).toBe(
    true,
  );
  await expect(viewport).not.toHaveAttribute("data-scroll-bottom");
  expect(await edgeOpacity("::before")).toBe(1);
  expect(await edgeOpacity("::after")).toBe(0);
  await shot("picker-scroll-bottom");
  const top = await scrollFrames(0);
  expect(top.some((frame) => frame.top > 0 && frame.top < 1)).toBe(true);
  expect(top.some((frame) => frame.bottom > 0 && frame.bottom < 1)).toBe(true);
  await expect(viewport).not.toHaveAttribute("data-scroll-top");
  expect(await edgeOpacity("::before")).toBe(0);
  expect(await edgeOpacity("::after")).toBe(1);
  await shot("picker-scroll-top");
  await search.fill("1.21.4");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await expect(viewport).not.toHaveAttribute("data-scroll-top");
  await expect(viewport).not.toHaveAttribute("data-scroll-bottom");
  await expect.poll(() => edgeOpacity("::before")).toBe(0);
  await expect.poll(() => edgeOpacity("::after")).toBe(0);
  await search.fill("");
  await expect(picker.getByRole("option")).toHaveCount(26);
  await expect(viewport).toHaveAttribute("data-scroll-bottom", "true");
  checks.push(
    "List edge fades match favorites: both show mid-list, the reached edge hides with intermediate animation frames, and filtering to a non-scrollable list removes both fades even under reduced-motion preference",
  );
  await search.press("ArrowDown");
  await page.keyboard.press("End");
  await expect(picker.getByRole("option").last()).toBeFocused();
  const lastOption = await picker.getByRole("option").last().boundingBox();
  const menu = await picker.boundingBox();
  expect(lastOption.y + lastOption.height).toBeLessThan(menu.y + menu.height);
  await page.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await expect(primary).toBeEnabled();
  expect(await page.evaluate(() => document.body.scrollWidth)).toBe(375);
  checks.push(
    "A short window with 26 installed versions can scroll and select the last long-named version without moving the launch actions",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/verification.json`,
    JSON.stringify({ checks, layouts, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, layouts, errors }, null, 2));
} catch (error) {
  await shot("failure");
  throw error;
} finally {
  await browser.close();
}
