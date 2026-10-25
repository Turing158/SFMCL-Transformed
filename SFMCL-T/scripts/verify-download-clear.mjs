import { chromium, expect } from "@playwright/test";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";

const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture, { components: true });
await page.addInitScript(() => {
  const fixture = window.__pixelTest;
  fixture.tasks.downloads.push({
    ...fixture.tasks.downloads.find((task) => task.id === "world"),
    id: "world2",
    title: "第二份世界备份",
  });
  const order = ["world", "pack", "world2", "minecraft", "fabric"];
  fixture.tasks.downloads.sort(
    (a, b) => order.indexOf(a.id) - order.indexOf(b.id),
  );
  const state = (window.__clearTest = {
    holdPolls: false,
    polls: [],
    deliveredPolls: 0,
    clearCalls: [],
    clears: {},
    pauseMotion: true,
    motions: [],
  });
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (frames, options) {
    const animation = animate.call(this, frames, options);
    if (
      ["sfmcl-t-download-exit", "sfmcl-t-download-collapse"].includes(options?.id)
    ) {
      state.motions.push(animation);
      if (state.pauseMotion) {
        animation.pause();
        animation.currentTime = 0;
      }
    }
    return animation;
  };
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "request" && args.operation === "tasks") {
      // Capture the response before deletion, then deliver it at a chosen time.
      const snapshot = await invoke(command, args);
      if (state.holdPolls)
        await new Promise((resolve) => state.polls.push(resolve));
      state.deliveredPolls += 1;
      return snapshot;
    }
    if (
      command === "request" &&
      args.operation === "downloads.control" &&
      args.payload.action === "clear"
    ) {
      state.clearCalls.push(args.payload.id);
      await new Promise((resolve) => {
        state.clears[args.payload.id] = resolve;
      });
    }
    return invoke(command, args);
  };
});

const cards = page.locator(".download-card");
const clear = (title) =>
  page.getByRole("button", { name: `清理 ${title}`, exact: true });
const releaseClear = (id) =>
  page.evaluate((id) => window.__clearTest.clears[id](), id);
const waitForPoll = () =>
  page.waitForFunction(() => window.__clearTest.polls.length === 1);
const releasePoll = async () => {
  await waitForPoll();
  await page.evaluate(async () => {
    window.__clearTest.polls.shift()();
    // Let React commit the released response before checking for resurrection.
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
};
const finishMotions = () =>
  page.evaluate(() => {
    window.__clearTest.motions
      .filter((motion) => motion.playState === "paused")
      .forEach((motion) => motion.finish());
  });
const layout = (time) =>
  page.evaluate((time) => {
    if (time !== undefined) {
      window.__clearTest.motions
        .filter((motion) => motion.playState === "paused")
        .forEach((motion) => {
          motion.currentTime = time;
        });
    }
    const list = document.querySelector(".download-list");
    const top = list.getBoundingClientRect().top;
    return Object.fromEntries(
      Array.from(list.children, (row) => {
        const bounds = row.getBoundingClientRect();
        const card = row.querySelector(".download-card");
        const style = getComputedStyle(card);
        return [
          row.dataset.downloadId,
          {
            top: bounds.top - top,
            height: bounds.height,
            opacity: Number(style.opacity),
            transform: style.transform,
          },
        ];
      }),
    );
  }, time);
const openDownloads = async () => {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page.waitForFunction(
    () => !document.documentElement.hasAttribute("data-startup"),
  );
  await page.locator(".sidebar-task").click();
  await expect(cards).toHaveCount(5);
};

try {
  await openDownloads();
  await page.evaluate(() => {
    window.__clearTest.holdPolls = true;
  });
  await waitForPoll();
  const before = await layout();

  // Rapid repeated activation sends one request; removal needs no poll response.
  await clear("世界备份").evaluate((button) => {
    button.click();
    button.click();
  });
  await expect(clear("世界备份")).toBeDisabled();
  expect(await page.evaluate(() => window.__clearTest.clearCalls)).toEqual([
    "world",
  ]);
  await releaseClear("world");
  await expect(page.locator('[data-download-id="world"]')).toHaveAttribute(
    "data-exiting",
    "true",
  );
  await expect(page.locator('[data-download-id="world"]')).toHaveAttribute(
    "inert",
    "",
  );
  // State and counts commit immediately while the visual card finishes its exit.
  await expect(cards).toHaveCount(5);
  await expect(page.getByRole("tab", { name: "全部任务" })).toContainText("4");
  const start = await layout(0);
  const middle = await layout(90);
  const later = await layout(140);
  expect(start.pack.top).toBeCloseTo(before.pack.top, 1);
  expect(start.world.opacity).toBe(1);
  expect(middle.world.opacity).toBeGreaterThan(0);
  expect(middle.world.opacity).toBeLessThan(1);
  expect(middle.world.transform).not.toBe(start.world.transform);
  expect(middle.world.height).toBeGreaterThan(0);
  expect(middle.world.height).toBeLessThan(before.world.height);
  expect(middle.pack.top).toBeLessThan(start.pack.top);
  expect(middle.pack.top).toBeGreaterThan(0);
  expect(later.pack.top).toBeLessThan(middle.pack.top);
  await finishMotions();
  await expect(clear("世界备份")).toHaveCount(0);
  await expect(cards).toHaveCount(4);
  expect((await layout()).pack.top).toBeCloseTo(0, 1);
  await expect(page.getByRole("tab", { name: "全部任务" })).toContainText("4");
  await expect(page.getByRole("tab", { name: "已完成" })).toContainText("1");
  await releasePoll();
  await expect(cards).toHaveCount(4);
  expect(await page.evaluate(() => window.__clearTest.motions.length)).toBe(2);
  await expect(clear("世界备份")).toHaveCount(0);
  await waitForPoll();

  // Failed deletion retains the task, reports the error and enables retry.
  await page.evaluate(() => {
    window.__pixelTest.failures["downloads.control"] = "测试：清理记录失败";
  });
  await clear("资源包下载").click();
  await expect(clear("资源包下载")).toBeDisabled();
  await releaseClear("pack");
  await expect(clear("资源包下载")).toBeEnabled();
  await expect(
    page.getByText("测试：清理记录失败", { exact: false }).first(),
  ).toBeVisible();
  await expect(cards).toHaveCount(4);

  // Different records can be cleared concurrently, including retry after failure.
  await page.evaluate(() => {
    delete window.__pixelTest.failures["downloads.control"];
  });
  await clear("资源包下载").click();
  await clear("第二份世界备份").click();
  await expect(clear("资源包下载")).toBeDisabled();
  await expect(clear("第二份世界备份")).toBeDisabled();
  await releaseClear("pack");
  await expect(page.locator('[data-download-id="pack"]')).toHaveAttribute(
    "data-exiting",
    "true",
  );
  const firstExit = await layout(90);
  await expect(clear("第二份世界备份")).toBeDisabled();
  await releaseClear("world2");
  await expect(page.locator('[data-download-id="world2"]')).toHaveAttribute(
    "data-exiting",
    "true",
  );
  const overlap = await layout();
  expect(overlap.minecraft.top).toBeCloseTo(firstExit.minecraft.top, 1);
  const moving = await layout(140);
  expect(moving.minecraft.top).toBeLessThan(overlap.minecraft.top);
  await finishMotions();
  await expect(cards).toHaveCount(2);
  expect((await layout()).minecraft.top).toBeCloseTo(0, 1);
  await expect(page.getByRole("tab", { name: "需要处理" })).toContainText("0");
  await expect(page.getByRole("tab", { name: "已完成" })).toContainText("0");
  await releasePoll();
  await expect(cards).toHaveCount(2);
  expect(await page.evaluate(() => window.__clearTest.clearCalls)).toEqual([
    "world",
    "pack",
    "pack",
    "world2",
  ]);

  // Fresh polling continues to update surviving tasks after invalidating old data.
  await page.evaluate(() => {
    window.__clearTest.holdPolls = false;
    window.__clearTest.pauseMotion = false;
    window.__pixelTest.tasks.downloads[0].title = "Minecraft 最新进度";
  });
  await expect(
    page.getByRole("heading", { name: "Minecraft 最新进度" }),
  ).toBeVisible();
  await expect(cards).toHaveCount(2);

  // Keep the last card until its exit finishes, then reveal the empty state.
  await page.evaluate(() => {
    const tasks = window.__pixelTest.tasks;
    tasks.downloads = [{ ...tasks.downloads[0], status: "completed" }];
  });
  await expect(cards).toHaveCount(1);
  await page.evaluate(() => {
    window.__clearTest.pauseMotion = true;
  });
  await clear("Minecraft 最新进度").click();
  await releaseClear("minecraft");
  await expect(page.locator('[data-download-id="minecraft"]')).toHaveAttribute(
    "data-exiting",
    "true",
  );
  await expect(page.locator(".download-empty")).toHaveCount(0);
  await finishMotions();
  await expect(cards).toHaveCount(0);
  await expect(page.getByText("这里暂时很安静", { exact: true })).toBeVisible();

  // Switching filters mid-exit cleans up animations on detached rows.
  await openDownloads();
  await clear("世界备份").click();
  await releaseClear("world");
  await expect(page.locator('[data-download-id="world"]')).toHaveAttribute(
    "data-exiting",
    "true",
  );
  await page.getByRole("tab", { name: "进行中", exact: false }).click();
  await expect(cards).toHaveCount(2);
  expect(
    await page.evaluate(() =>
      window.__clearTest.motions.every((motion) => motion.playState === "idle"),
    ),
  ).toBe(true);

  // System motion preferences do not disable exit animations.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openDownloads();
  await clear("世界备份").click();
  await releaseClear("world");
  await expect(page.locator('[data-download-id="world"]')).toHaveAttribute(
    "data-exiting",
    "true",
  );
  expect(await page.evaluate(() => window.__clearTest.motions.length)).toBe(2);
  await finishMotions();
  await expect(cards).toHaveCount(4);
  expect(errors).toEqual([]);
  console.log(
    "PASS Download exit and continuous sibling motion, overlapping deletion, empty state, interruption, animations enabled regardless of system preferences, stale polls, duplicate clicks and failure/retry.",
  );
} finally {
  await browser.close();
}
