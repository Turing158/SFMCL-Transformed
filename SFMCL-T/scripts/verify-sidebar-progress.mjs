import { chromium, expect } from "@playwright/test";
import { waitForAutoSave } from "./lib/auto-save.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { runtimePath } from "./lib/paths.mjs";

const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/";
const evidence =
  process.env.SFMCL_T_TEST_ARTIFACT_DIR ||
  runtimePath("evidence/sidebar-progress");
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
const entry = page.locator(".sidebar-downloads");
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
        scale: new DOMMatrix(style.transform).a,
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
const pauseEntry = async (direction, fraction = 0.5) => {
  const id = `sfmcl-t-sidebar-task-${direction}`;
  await page.waitForFunction((id) => {
    const animation = document
      .getAnimations()
      .find((motion) => motion.id === id);
    if (!animation) return false;
    animation.pause();
    return true;
  }, id);
  return entry.evaluate(
    (element, { id, fraction }) => {
      const animation = element
        .getAnimations()
        .find((motion) => motion.id === id);
      const duration = animation.effect.getTiming().duration;
      animation.currentTime = duration * fraction;
      const style = getComputedStyle(element);
      const cardStyle = getComputedStyle(
        element.querySelector(".sidebar-task"),
      );
      const transform = new DOMMatrix(cardStyle.transform);
      return {
        duration,
        opacity: Number(style.opacity),
        height: element.getBoundingClientRect().height,
        fullHeight: parseFloat(cardStyle.height),
        margin: parseFloat(style.marginBottom),
        scale: transform.a,
        offset: transform.f,
      };
    },
    { id, fraction },
  );
};
const finishEntry = () =>
  entry.evaluate((element) => {
    for (const animation of element.getAnimations()) animation.finish();
  });
const entryIntermediate = (sample) => {
  expect(sample.duration).toBe(300);
  expect(sample.opacity).toBeGreaterThan(0);
  expect(sample.opacity).toBeLessThan(1);
  expect(sample.height).toBeGreaterThan(0);
  expect(sample.height).toBeLessThan(sample.fullHeight);
  expect(sample.margin).toBeGreaterThan(0);
  expect(sample.margin).toBeLessThan(12);
  expect(sample.scale).toBeGreaterThan(0.96);
  expect(sample.scale).toBeLessThan(1);
  expect(sample.offset).toBeGreaterThan(0);
  expect(sample.offset).toBeLessThan(8);
};
const intermediate = (sample) => {
  expect(sample.scale).toBeGreaterThan(0.84);
  expect(sample.scale).toBeLessThan(1);
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
    "Empty state and completed history do not show an idle progress ring",
  );

  await start("download");
  intermediate(await pauseMotion("enter"));
  await shot("enter");
  await finishMotion();
  await expect(progress).toHaveAttribute("aria-valuenow", "64");
  await expect(button.locator(".sidebar-progress")).toHaveCount(1);
  await expect(page.locator(".sidebar-progress-fill, .task-count")).toHaveCount(
    0,
  );
  await expect(slot).toHaveCSS("height", "30px");
  await shot("visible");
  await page.evaluate(() => {
    window.__pixelTest.tasks.downloads[0].status = "completed";
  });
  await expect(progress).toHaveAttribute("aria-valuenow", "100");
  await page.waitForTimeout(900);
  await expect(slot).toHaveCSS("height", "30px");
  intermediate(await pauseMotion("exit"));
  await shot("exit");
  await finishMotion();
  await expect(slot).toHaveCount(0);
  await expect(button).toBeVisible();
  await shot("hidden");
  checks.push(
    "Completion holds the final closed 100% ring, then fades it away; the always-visible entry remains",
  );

  await start("job");
  await expect(progress).toHaveAttribute("aria-valuenow", "33");
  await expect(button).toContainText("安装 Minecraft");
  await page.evaluate(() => {
    window.__pixelTest.tasks.downloads = [];
  });
  await page.waitForTimeout(2600);
  await expect(slot).toHaveCSS("height", "30px");
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
  await expect(slot).toHaveCSS("height", "30px");
  checks.push(
    "Step-only work keeps progress visible; clearing a finished job preserves its final frame; pending work cancels the idle deadline",
  );

  await page.locator(".brand-logo").hover();
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await page.mouse.move(500, 300);
  await expect(progress).toHaveCSS("width", "30px");
  await page.evaluate(() => {
    window.__pixelTest.tasks.downloads = [];
  });
  const closing = await pauseMotion("exit");
  intermediate(closing);
  await shot("collapsed-exit");
  await start("job", "queued");
  const reopening = await pauseMotion("enter", 0);
  expect(reopening.scale).toBeCloseTo(closing.scale, 2);
  expect(reopening.opacity).toBeCloseTo(closing.opacity, 2);
  await finishMotion();
  await expect(slot).toHaveCSS("height", "30px");
  await page.evaluate(() => {
    window.__pixelTest.tasks.jobs[0].steps = [];
  });
  await expect(progress).not.toHaveAttribute("aria-valuenow");
  await expect(
    page.locator('.sidebar-progress-percent [data-transition="number"]'),
  ).toHaveText("···");
  await expect(
    page.locator(".sidebar-progress-glyph svg.lucide-hourglass"),
  ).toHaveCount(1);
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

  for (const preference of ["no-preference", "reduce"]) {
    await page.emulateMedia({ reducedMotion: preference });
    await ready("active");
    if (preference === "reduce") {
      await page.locator(".brand-logo").hover();
      await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
      await page.mouse.move(500, 300);
      await expect(page.locator(".sidebar")).toHaveClass(/rail-collapsed/);
      await page.waitForTimeout(320);
    }
    await page.evaluate(() => {
      window.__pixelTest.downloadTemplate.title = "26.1.2 · 启动检查";
    });
    await start("download");
    entryIntermediate(await pauseEntry("enter"));
    await shot(`card-enter-${preference}`);
    await finishEntry();
    await expect(entry).toHaveCSS("opacity", "1");
    await expect(entry).toHaveCSS("margin-bottom", "12px");
    await expect(entry).not.toHaveAttribute("inert");
    await page.evaluate(() => {
      window.__pixelTest.tasks.downloads[0].status = "completed";
    });
    const exiting = await pauseEntry("exit");
    entryIntermediate(exiting);
    await expect(entry).toHaveAttribute("inert", "");
    await expect(entry).toHaveAttribute("aria-hidden", "true");
    await expect(slot).toHaveCount(0);
    await expect(button).toContainText("26.1.2 · 启动检查");
    await expect(button).toContainText("已完成");
    await shot(`card-exit-${preference}`);
    await start("download", "paused");
    const reversing = await pauseEntry("enter", 0);
    for (const field of ["opacity", "height", "margin", "scale", "offset"])
      expect(reversing[field]).toBeCloseTo(exiting[field], 2);
    await finishEntry();
    await expect(entry).not.toHaveAttribute("inert");
    await expect(progress).toHaveAttribute("aria-valuenow", "64");
    await page.evaluate(() => {
      window.__pixelTest.tasks.downloads[0].status = "completed";
    });
    entryIntermediate(await pauseEntry("exit"));
    await finishEntry();
    await expect(entry).toHaveCount(0);
    await expect(slot).toHaveCount(0);
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
  checks.push(
    "The whole startup-check card fades, slides and scales for 300ms while its height and gap animate; reduced-motion and collapsed mode retain full motion, exiting content stays intact and inert, and new work reverses smoothly",
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
    await waitForAutoSave(page);
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
  // Verify actual state motion under the user's full-animation preference.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => {
    window.__sidebarMotionSamples = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      const animation = animate.call(this, frames, options);
      if (options?.id?.startsWith("sfmcl-t-sidebar-")) {
        window.__sidebarMotionSamples.push({
          id: options.id,
          frames,
          duration: options.duration,
        });
      }
      return animation;
    };
  });
  const glyph = page.locator(".sidebar-progress-icon");
  const setJobState = async (status, unknown = false) => {
    await page.evaluate(
      ({ status, unknown }) => {
        const job = window.__pixelTest.tasks.jobs[0];
        job.status = status;
        job.steps = unknown
          ? []
          : structuredClone(window.__pixelTest.jobTemplate.steps);
      },
      { status, unknown },
    );
    await expect(progress).toHaveAttribute("data-status", status);
  };
  await setJobState("paused");
  await expect(glyph).toHaveAttribute("data-icon", "pause");
  await expect(progress).toHaveCSS("color", "rgb(238, 212, 154)");
  await setJobState("running");
  await expect(glyph).toHaveAttribute("data-icon", "arrow-down");
  await setJobState("running", true);
  await expect(glyph).toHaveAttribute("data-icon", "hourglass");
  await expect(progress).not.toHaveAttribute("aria-valuenow");
  await expect(page.locator(".sidebar-progress-chart")).toHaveAttribute(
    "data-spinning",
    "true",
  );
  await setJobState("paused", true);
  await expect(glyph).toHaveAttribute("data-icon", "pause");
  await expect(page.locator(".sidebar-progress-chart")).not.toHaveAttribute(
    "data-spinning",
  );
  await setJobState("running");
  await page.evaluate(() => {
    window.__pixelTest.tasks.jobs[0].steps[1].status = "completed";
  });
  await expect(progress).toHaveAttribute("aria-valuenow", "67");
  await expect(
    page.locator('.sidebar-progress-percent [data-transition="number"]'),
  ).toHaveText("67%");
  const motionSamples = await page.evaluate(
    () => window.__sidebarMotionSamples,
  );
  for (const kind of ["icon", "text", "number"])
    expect(
      motionSamples.some(
        (sample) => sample.id === `sfmcl-t-sidebar-${kind}-in`,
      ),
    ).toBeTruthy();
  expect(
    motionSamples
      .filter((sample) => sample.id.includes("icon-"))
      .every((sample) => sample.duration === 280),
  ).toBeTruthy();
  expect(
    motionSamples
      .filter((sample) => sample.id.includes("text-"))
      .every((sample) => sample.duration === 240),
  ).toBeTruthy();
  const numeric = motionSamples.filter((sample) =>
    sample.id.includes("number"),
  );
  expect(
    numeric.every(
      (sample) =>
        sample.duration === 220 &&
        sample.frames.every(
          (frame) =>
            !frame.transform?.includes("px") ||
            /translateY\(-?3px\)/.test(frame.transform),
        ),
    ),
  ).toBeTruthy();
  await page.waitForTimeout(500);
  await expect(page.locator(".sidebar-progress-outgoing")).toHaveCount(0);
  await page.evaluate(() => {
    window.__pixelTest.tasks.jobs[0].status = "completed";
  });
  await expect(progress).toHaveAttribute("aria-valuenow", "100");
  await expect(glyph).toHaveAttribute("data-icon", "check");
  await expect(page.locator(".sidebar-progress-arc")).toHaveCSS(
    "stroke-dashoffset",
    "0px",
  );
  await expect(
    page.locator(".sidebar-progress-glyph .sidebar-progress-current path"),
  ).toHaveAttribute("pathLength", "1");
  await expect(
    page.locator('.sidebar-progress-percent [data-transition="number"]'),
  ).toHaveText("100%");
  await page.evaluate(() => {
    const job = window.__pixelTest.tasks.jobs[0];
    job.status = "paused";
    job.steps = structuredClone(window.__pixelTest.jobTemplate.steps);
  });
  await expect(glyph).toHaveAttribute("data-icon", "pause");
  await page.waitForTimeout(500);
  await expect(page.locator(".sidebar-progress-outgoing")).toHaveCount(0);
  await expect(progress).toHaveAttribute("aria-valuenow", "33");
  await shot("paused-ring");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  checks.push(
    "Pause, resume, unknown hourglass, completed check and whole-number swaps animate under reduced-motion preference; numbers move only ±3px and the 100% ring closes completely",
  );
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
