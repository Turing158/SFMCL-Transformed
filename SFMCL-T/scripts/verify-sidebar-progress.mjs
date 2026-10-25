import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { runtimePath } from "./lib/paths.mjs";

const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/";
const evidence = runtimePath("evidence/sidebar-progress");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 640 } });
page.setDefaultTimeout(8000);
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture, { components: true });
await page.addInitScript(() => {
  const test = window.__pixelTest;
  test.downloadTemplate = structuredClone(test.tasks.downloads[0]);
  test.jobTemplate = structuredClone(test.tasks.jobs[0]);
  test.tasks.downloads = [];
  test.tasks.jobs = [];
  test.data.settings.downloadTaskDisplay =
    new URL(location.href).searchParams.get("mode") || "always";
});
const slot = page.locator(".sidebar-progress-motion");
const progress = page.locator(".sidebar-progress");
const button = page.locator(".sidebar-task");
const ready = async (mode = "always") => {
  await page.goto(`${url}?mode=${mode}`);
  await expect(page.locator("html")).not.toHaveAttribute("data-startup");
};
const start = (kind, status = "running") =>
  page.evaluate(
    ({ kind, status }) => {
      const test = window.__pixelTest;
      const task = structuredClone(
        kind === "download" ? test.downloadTemplate : test.jobTemplate,
      );
      task.status = status;
      test.tasks[kind === "download" ? "downloads" : "jobs"] = [task];
    },
    { kind, status },
  );
const pauseMotion = async (direction, fraction = 0.5) => {
  const id = `sfmcl-t-sidebar-progress-${direction}`;
  await page.waitForFunction((id) => {
    const animation = document
      .getAnimations()
      .find((animation) => animation.id === id);
    if (!animation) return false;
    animation.pause();
    return true;
  }, id);
  return slot.evaluate(
    (element, { id, fraction }) => {
      const animation = element
        .getAnimations()
        .find((animation) => animation.id === id);
      animation.currentTime = animation.effect.getTiming().duration * fraction;
      const style = getComputedStyle(element);
      return {
        height: element.getBoundingClientRect().height,
        opacity: Number(style.opacity),
      };
    },
    { id, fraction },
  );
};
const finishMotion = () =>
  slot.evaluate((element) => {
    for (const animation of element.getAnimations()) animation.finish();
  });
const intermediate = (sample) => {
  expect(sample.height).toBeGreaterThan(0);
  expect(sample.height).toBeLessThan(16);
  expect(sample.opacity).toBeGreaterThan(0);
  expect(sample.opacity).toBeLessThan(1);
};
const shot = (name) =>
  page
    .locator(".sidebar-bottom")
    .screenshot({ path: `${evidence}/${name}.png` });

try {
  await ready();
  await expect(button).toBeVisible();
  await expect(slot).toHaveCount(0);
  await start("download", "completed");
  await page.waitForTimeout(2600);
  await expect(slot).toHaveCount(0);
  checks.push(
    "Empty state and completed history do not show an idle progress bar",
  );

  await start("download");
  intermediate(await pauseMotion("enter"));
  await shot("enter");
  await finishMotion();
  await expect(progress).toHaveAttribute("aria-valuenow", "64");
  await expect(slot).toHaveCSS("height", "16px");
  await shot("visible");
  await page.evaluate(() => {
    window.__pixelTest.tasks.downloads[0].status = "completed";
  });
  await expect(progress).toHaveAttribute("aria-valuenow", "100");
  await page.waitForTimeout(900);
  await expect(slot).toHaveCSS("height", "16px");
  intermediate(await pauseMotion("exit"));
  await shot("exit");
  await finishMotion();
  await expect(slot).toHaveCount(0);
  await expect(button).toBeVisible();
  await shot("hidden");
  checks.push(
    "Completion holds the final 100% frame, then fades and collapses the 16px slot; the always-visible entry remains",
  );

  await start("job");
  await expect(progress).toHaveAttribute("aria-valuenow", "33");
  await expect(button).toContainText("安装 Minecraft");
  await page.evaluate(() => {
    window.__pixelTest.tasks.downloads = [];
  });
  await page.waitForTimeout(2600);
  await expect(slot).toHaveCSS("height", "16px");
  await page.evaluate(() => {
    const job = window.__pixelTest.tasks.jobs[0];
    job.status = "completed";
    job.steps.forEach((step) => {
      step.status = "completed";
    });
  });
  await expect(progress).toHaveAttribute("aria-valuenow", "100");
  await page.evaluate(() => {
    window.__pixelTest.tasks.jobs = [];
  });
  await page.waitForTimeout(650);
  await expect(progress).toHaveAttribute("aria-valuenow", "100");
  await start("download", "paused");
  await expect(progress).toHaveAttribute("aria-valuenow", "64");
  await page.waitForTimeout(2200);
  await expect(slot).toHaveCSS("height", "16px");
  checks.push(
    "Step-only work keeps progress visible; clearing a finished job preserves its final frame; pending work cancels the idle deadline",
  );

  await page.locator(".brand-logo").hover();
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await page.mouse.move(500, 300);
  await expect(progress).toHaveCSS("width", "38px");
  await page.evaluate(() => {
    window.__pixelTest.tasks.downloads = [];
  });
  const closing = await pauseMotion("exit");
  intermediate(closing);
  await shot("collapsed-exit");
  await start("job", "queued");
  const reopening = await pauseMotion("enter", 0);
  expect(reopening.height).toBeCloseTo(closing.height, 1);
  expect(reopening.opacity).toBeCloseTo(closing.opacity, 2);
  await finishMotion();
  await expect(slot).toHaveCSS("height", "16px");
  await page.evaluate(() => {
    window.__pixelTest.tasks.jobs[0].steps = [];
  });
  await expect(progress).not.toHaveAttribute("aria-valuenow");
  await expect(page.locator(".task-count")).toHaveCount(0);
  await shot("collapsed-job");
  checks.push(
    "Collapsed rail animates too; new work reverses an unfinished exit from the current frame; unknown progress has no percentage",
  );

  await page.evaluate(() => {
    window.__pixelTest.tasks.jobs[0].status = "failed";
  });
  await expect(slot).toHaveCount(0);
  await page.evaluate(() => {
    window.__pixelTest.tasks.jobs = [];
  });
  await expect(button).toContainText("暂无下载任务");
  await ready("active");
  await expect(button).toHaveCount(0);
  await start("job");
  await expect(button).toBeVisible();
  await expect(progress).toHaveAttribute("aria-valuenow", "33");
  await page.evaluate(() => {
    window.__pixelTest.tasks.jobs[0].status = "cancelled";
  });
  intermediate(await pauseMotion("exit"));
  await expect(button).toBeVisible();
  await finishMotion();
  await expect(slot).toHaveCount(0);
  await expect(button).toHaveCount(0);
  checks.push(
    "Failed and cancelled work stops the indicator; active-only mode waits for the exit animation before removing its entry",
  );

  await ready("off");
  await start("download");
  await page.waitForTimeout(900);
  await expect(button).toHaveCount(0);
  await expect(slot).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  const displayMode = async (name) => {
    await page
      .getByRole("combobox", { name: "侧栏下载任务", exact: true })
      .click();
    await page.getByRole("option", { name, exact: true }).click();
    await page
      .getByRole("button", { name: "保存设置", exact: true })
      .first()
      .click();
  };
  await displayMode("始终");
  await expect(progress).toHaveAttribute("aria-valuenow", "64");
  await displayMode("关闭");
  await expect(slot).toHaveCount(0);
  await page.evaluate(() => {
    window.__pixelTest.tasks.downloads = [];
  });
  await page.waitForTimeout(700);
  await displayMode("下载时");
  await expect(button).toHaveCount(0);
  await expect(slot).toHaveCount(0);
  await start("job");
  await expect(progress).toHaveAttribute("aria-valuenow", "33");
  expect(errors).toEqual([]);
  checks.push(
    "Changing display preferences cleans up timers and animations, and a later task can still appear; no page errors",
  );
  console.log(`PASS ${checks.length} sidebar progress behavior groups.`);
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` }).catch(() => {});
  errors.push(String(error));
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  await browser.close();
}
