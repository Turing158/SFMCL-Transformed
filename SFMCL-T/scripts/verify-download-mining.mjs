import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence =
  process.env.SFMCL_T_MINING_EVIDENCE ||
  runtimePath("evidence/download-mining");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.SFMCL_T_BROWSER_PATH
    ? { executablePath: process.env.SFMCL_T_BROWSER_PATH }
    : process.platform === "win32"
      ? { channel: "msedge" }
      : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 800 } });
const errors = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript(pixelAppFixture, { components: true });
await page.addInitScript(() => {
  window.__miningTemplate = { ...window.__pixelTest.tasks.downloads[0] };
  window.__pixelTest.tasks.downloads = [];
  window.__pixelTest.tasks.jobs = [];
});
const feedback = page.locator(".download-mining");
const scene = page.locator(".download-mine-scene");
async function tasks(status, extras = {}) {
  await page.evaluate(
    ({ status, extras }) => {
      window.__pixelTest.tasks.downloads = status
        ? [{ ...window.__miningTemplate, status, ...extras }]
        : [];
    },
    { status, extras },
  );
}

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page.waitForFunction(
    () => !document.documentElement.hasAttribute("data-startup"),
  );
  await page.locator(".sidebar-task").click();
  await expect(feedback).toHaveAttribute("data-state", "idle");
  await expect(
    scene.locator('.download-mine-block[data-kind="stone"]'),
  ).toHaveCount(2);
  const idleFrame = () =>
    scene.evaluate((s) => ({
      sprite: getComputedStyle(s.querySelector(".download-mine-pick img"))
        .transform,
      anchor: getComputedStyle(s.querySelector(".download-mine-pick"))
        .transform,
      blocks: s.querySelector(".download-mine-queue").innerHTML,
      warmup: s
        .getAnimations({ subtree: true })
        .find((a) => a.id === "download-mine-idle-warmup")?.playState,
    }));
  const idleStart = await idleFrame();
  await page.waitForTimeout(220);
  const idleNext = await idleFrame();
  expect(idleStart.sprite).not.toBe(idleNext.sprite);
  expect(idleNext.sprite).toContain("matrix(");
  expect(idleNext.anchor).toBe(idleStart.anchor);
  expect(idleNext.blocks).toBe(idleStart.blocks);
  expect(idleNext.warmup).toBe("running");
  const warmup = await scene.evaluate(async (s) => {
    const animations = s
      .getAnimations({ subtree: true })
      .filter((a) => a.id.startsWith("download-mine-idle-"));
    const duration = Number(animations[0].effect.getTiming().duration);
    animations.forEach((a) => a.pause());
    const frames = [];
    for (let step = 0; step <= 40; step++) {
      animations.forEach((a) => (a.currentTime = (duration * step) / 40));
      await new Promise(requestAnimationFrame);
      const sprite = s.querySelector(".download-mine-pick img");
      const matrix = new DOMMatrix(getComputedStyle(sprite).transform);
      const rect = sprite.getBoundingClientRect();
      frames.push({
        angle: (Math.atan2(matrix.m12, matrix.m11) * 180) / Math.PI,
        centerY: rect.top + rect.height / 2,
        sparkle: [...s.querySelectorAll(".download-mine-spark")].some(
          (spark) => Number(getComputedStyle(spark).opacity) > 0.1,
        ),
      });
    }
    animations.forEach((a) => {
      a.currentTime = 0;
      a.play();
    });
    return { duration, frames };
  });
  expect(warmup.duration).toBeCloseTo(8500 / 1.5);
  const revolution = warmup.frames.slice(1).reduce((total, frame, index) => {
    const delta = frame.angle - warmup.frames[index].angle;
    return total + ((delta + 540) % 360) - 180;
  }, 0);
  expect(revolution).toBeCloseTo(360);
  expect(Math.min(...warmup.frames.map((frame) => frame.centerY))).toBeLessThan(
    warmup.frames[0].centerY - 7,
  );
  expect(warmup.frames.at(-1).centerY).toBeCloseTo(warmup.frames[0].centerY);
  expect(warmup.frames.some((frame) => frame.sparkle)).toBe(true);
  expect((await idleFrame()).blocks).toBe(idleStart.blocks);
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await expect(scene).toHaveAttribute("data-paused", "true");
  const hiddenIdle = await idleFrame();
  await page.waitForTimeout(220);
  expect(await idleFrame()).toEqual(hiddenIdle);
  expect(hiddenIdle.warmup).toBe("paused");
  await page.locator(".sidebar-task").click();
  await expect(scene).toHaveAttribute("data-paused", "false");
  await expect.poll(async () => (await idleFrame()).warmup).toBe("running");
  checks.push({
    name: "idle-warmup-full-throw-catch-sparkles-at-1.5x-and-hidden-pause",
    duration: warmup.duration,
  });
  await scene.evaluate((s) => {
    window.__miningScene = s;
    window.__firstMiningBlock = s.querySelector(".download-mine-block");
    window.__mineCycles = [];
    window.__minePhases = [];
    window.__collectionFrames = [];
    let phase = "",
      touching = false,
      hits = 0;
    let hitTimes = [];
    function sample() {
      const next = s.dataset.phase;
      if (phase !== next) {
        const blocks = [...s.querySelectorAll(".download-mine-block")].map(
          (b) => b.dataset.kind,
        );
        window.__minePhases.push({ phase: next, blocks });
        if (next === "mining") {
          hits = 0;
          hitTimes = [];
          touching = false;
        }
        if (next === "breaking")
          window.__mineCycles.push({
            hits,
            kind: blocks[0],
            brokeAt: performance.now(),
            strikeIntervals: hitTimes
              .slice(1)
              .map((time, i) => time - hitTimes[i]),
          });
        if (next === "breaking" && blocks[0] === "ore")
          window.__oreFollower = s.querySelectorAll(".download-mine-block")[1];
        phase = next;
      }
      if (
        s.dataset.paused === "false" &&
        (next === "dropping" || next === "collecting")
      ) {
        const stone = s.querySelector(".download-mine-block");
        window.__collectionFrames.push({
          phase: next,
          count: s.querySelectorAll(".download-mine-block").length,
          stoneX: new DOMMatrix(getComputedStyle(stone).transform).m41,
          diamondRight: Math.max(
            ...[...s.querySelectorAll(".download-mine-diamond")].map(
              (d) =>
                d.getBoundingClientRect().right -
                s.getBoundingClientRect().left,
            ),
          ),
        });
      }
      if (
        next === "mining" &&
        s.dataset.paused === "false" &&
        s.dataset.visual === "running" &&
        !s.dataset.handoff
      ) {
        const angle = Number(
          s
            .querySelector(".download-mine-pick")
            .style.transform.match(/rotate\(([-\d.]+)deg\)/)?.[1] || -16,
        );
        const contact = angle > 20;
        if (contact && !touching) {
          hits++;
          hitTimes.push(performance.now());
        }
        touching = contact;
      }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
  await tasks("running");
  await expect(feedback).toHaveAttribute("data-state", "running");
  expect(
    await scene.evaluate(
      (s) =>
        s === window.__miningScene &&
        s.querySelector(".download-mine-block") === window.__firstMiningBlock,
    ),
  ).toBe(true);
  await tasks("running", { downloaded: 80, total: 100 });
  await expect(scene).toHaveCSS("--mine-progress", "0.8");
  expect(
    await scene.evaluate((s) =>
      s
        .getAnimations({ subtree: true })
        .some((a) => a.id.startsWith("download-mine-idle-")),
    ),
  ).toBe(false);
  expect(await scene.evaluate((s) => s === window.__miningScene)).toBe(true);
  await page.waitForFunction(() => window.__mineCycles.length >= 2);
  const cycles = await page.evaluate(() => window.__mineCycles);
  expect(cycles.every((c) => c.hits === 3 && c.kind === "stone")).toBe(true);
  for (const interval of cycles.flatMap((c) => c.strikeIntervals)) {
    expect(interval).toBeGreaterThan(228);
    expect(interval).toBeLessThan(348);
  }
  const cycleDuration = cycles[1].brokeAt - cycles[0].brokeAt;
  expect(cycleDuration).toBeGreaterThan(1000);
  expect(cycleDuration).toBeLessThan(1250);
  checks.push({
    name: "three-strikes-faster-cycle-and-live-progress",
    cycles,
    cycleDuration,
  });

  for (const status of ["paused", "pausing", "queued", "failed", "cancelled"]) {
    await tasks(status);
    await expect(feedback).toHaveAttribute(
      "data-state",
      status === "pausing" ? "paused" : status,
    );
    await expect(scene).toHaveAttribute("data-paused", "false");
    await expect(scene).toHaveAttribute("data-visual", "idle");
    await expect(scene).not.toHaveAttribute("data-handoff", "warmup");
    await expect.poll(async () => (await idleFrame()).warmup).toBe("running");
    const before = await idleFrame();
    const sameCycle = await scene.evaluate((s) => {
      const animation = s
        .getAnimations({ subtree: true })
        .find((a) => a.id === "download-mine-idle-warmup");
      window.__waitingWarmup ??= animation;
      return animation === window.__waitingWarmup;
    });
    expect(sameCycle).toBe(true);
    await page.waitForTimeout(180);
    const after = await idleFrame();
    expect(after.sprite).not.toBe(before.sprite);
    expect(after.blocks).toBe(before.blocks);
    await expect(scene.locator(".download-mine-rest-queue")).toHaveCSS(
      "opacity",
      "1",
    );
    await expect(scene.locator(".download-mine-queue")).toHaveCSS(
      "opacity",
      "0",
    );
  }
  checks.push({
    name: "paused-pausing-queued-failed-cancelled-share-continuous-warmup",
  });
  await tasks("running", { unknownSize: true });
  await expect(scene).toHaveAttribute("data-unknown", "true");
  await expect(feedback.locator("small")).toHaveText("大小未知 · 1 个任务");
  await page.getByRole("tab", { name: /已完成/ }).click();
  await expect(feedback).toHaveAttribute("data-state", "running");
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await expect(scene).toHaveAttribute("data-paused", "true");
  const hidden = await scene.innerHTML();
  await page.waitForTimeout(250);
  expect(await scene.innerHTML()).toBe(hidden);
  await page.locator(".sidebar-task").click();
  await expect(scene).toHaveAttribute("data-paused", "false");
  checks.push({ name: "unknown-size-filter-independent-hidden-page-pauses" });

  await tasks("completed", { downloaded: 100, total: 100 });
  await expect(feedback).toHaveAttribute("data-state", "done");
  await page.waitForFunction(
    () => window.__miningScene.dataset.phase === "collecting",
  );
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await expect(scene).toHaveAttribute("data-paused", "true");
  await expect(scene).toHaveAttribute("data-phase", "collecting");
  const hiddenCollection = await scene.innerHTML();
  await page.waitForTimeout(250);
  expect(await scene.innerHTML()).toBe(hiddenCollection);
  await page.locator(".sidebar-task").click();
  await expect(scene).toHaveAttribute("data-reward", "collected");
  await expect(scene).toHaveAttribute("data-visual", "idle");
  await expect.poll(async () => (await idleFrame()).warmup).toBe("running");
  const phases = await page.evaluate(() => window.__minePhases);
  expect(
    phases.some(
      (p) => p.phase === "advancing" && p.blocks.join() === "stone,ore",
    ),
  ).toBe(true);
  expect(
    phases.some(
      (p) => p.phase === "breaking" && p.blocks.join() === "ore,stone",
    ),
  ).toBe(true);
  expect(phases.slice(-4).map((p) => p.phase)).toEqual([
    "dropping",
    "collecting",
    "restocking",
    "idle",
  ]);
  const collection = await page.evaluate(() => window.__collectionFrames);
  expect(collection.every((f) => f.count === 1 && f.stoneX === 38)).toBe(true);
  const throws = collection.filter((f) => f.phase === "collecting");
  expect(throws.length).toBeGreaterThan(5);
  expect(throws[0].diamondRight).toBeGreaterThan(100);
  expect(throws.at(-1).diamondRight).toBeLessThan(0);
  expect(
    throws.every(
      (f, i) => i === 0 || f.diamondRight <= throws[i - 1].diamondRight + 0.5,
    ),
  ).toBe(true);
  const collected = await scene.evaluate((s) => {
    window.__restingStones = [...s.querySelectorAll(".download-mine-block")];
    window.__rewardAnimation = s
      .getAnimations({ subtree: true })
      .find((a) => a.id === "download-mine-idle-warmup");
    return {
      sameStone: window.__restingStones[0] === window.__oreFollower,
      blocks: window.__restingStones.map((b) => ({
        kind: b.dataset.kind,
        x: new DOMMatrix(getComputedStyle(b).transform).m41,
      })),
      diamondsHidden: [...s.querySelectorAll(".download-mine-diamond")].every(
        (d) => getComputedStyle(d).opacity === "0",
      ),
      warmup: window.__rewardAnimation?.playState,
    };
  });
  expect(collected).toEqual({
    sameStone: true,
    blocks: [
      { kind: "stone", x: 0 },
      { kind: "stone", x: 38 },
    ],
    diamondsHidden: true,
    warmup: "running",
  });
  await page.screenshot({ path: `${evidence}/collected-idle.png` });
  await page.waitForTimeout(1100);
  expect(
    await scene.evaluate(
      (s) =>
        s.getAnimations({ subtree: true }).includes(window.__rewardAnimation) &&
        [...s.querySelectorAll(".download-mine-block")].every(
          (b, i) => b === window.__restingStones[i],
        ),
    ),
  ).toBe(true);
  checks.push({
    name: "ore-with-stone-drop-throw-left-restock-idle-no-poll-replay",
    phases,
    collected,
    diamondExitRight: throws.at(-1).diamondRight,
  });
  checks.push({ name: "collection-pauses-on-hidden-page-and-resumes" });

  await tasks("running");
  await expect(feedback).toHaveAttribute("data-state", "running");
  await expect(scene.locator('[data-kind="stone"]')).toHaveCount(2);
  await tasks("completed");
  await expect(feedback).toHaveAttribute("data-state", "done");
  await tasks("cancelled");
  await expect(feedback).toHaveAttribute("data-state", "cancelled");
  await expect(scene).toHaveAttribute("data-visual", "idle");
  await tasks(null);
  await expect(feedback).toHaveAttribute("data-state", "idle");
  await tasks("completed");
  await expect(feedback).toHaveAttribute("data-state", "done");
  await expect(scene).toHaveAttribute("data-phase", "idle");
  await expect(scene).toHaveAttribute("data-visual", "idle");
  await expect(scene.locator('[data-kind="stone"]')).toHaveCount(2);
  checks.push({ name: "new-task-cancellation-clear-and-completed-history" });

  await tasks("running");
  await expect(feedback).toHaveAttribute("data-state", "running");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(scene).toHaveAttribute("data-paused", "false");
  for (const width of [1120, 768, 375]) {
    await page.setViewportSize({ width, height: 800 });
    expect(
      await page
        .locator("main.page")
        .evaluate((s) => s.scrollWidth > s.clientWidth),
    ).toBe(false);
    expect(
      await scene.evaluate((s) =>
        [...s.querySelectorAll("img")].every(
          (i) => i.complete && i.naturalWidth > 0,
        ),
      ),
    ).toBe(true);
    const title = await page
      .locator(".downloads-page .page-title")
      .boundingBox();
    const animation = await page
      .locator(".download-mine-viewport")
      .boundingBox();
    expect(title.x + title.width).toBeLessThanOrEqual(animation.x + 1);
    if (width !== 768)
      await page.screenshot({
        path: `${evidence}/${width === 375 ? "mobile" : "desktop"}.png`,
      });
  }
  checks.push({
    name: "responsive-local-assets-full-motion",
    widths: [1120, 768, 375],
  });
  const transitions = await scene.evaluate(async (original) => {
    const { createDownloadMiningMotion } =
      await import("/src/downloadMiningMotion.ts");
    const isolated = original.cloneNode(true);
    isolated.querySelector(".download-mine-rest-queue")?.remove();
    isolated.style.cssText =
      "position:fixed;left:200px;top:120px;transform:none";
    document.body.append(isolated);
    const controller = createDownloadMiningMotion(isolated);
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const results = [];
    const pose = () => {
      const pick = isolated.querySelector(".download-mine-pick");
      const sprite = pick.querySelector("img");
      const outer = getComputedStyle(pick),
        inner = getComputedStyle(sprite);
      const [ox, oy] = outer.transformOrigin.split(" ").map(parseFloat);
      const [ix, iy] = inner.transformOrigin.split(" ").map(parseFloat);
      const matrix = new DOMMatrix()
        .translate(pick.offsetLeft, pick.offsetTop)
        .translate(ox, oy)
        .multiply(new DOMMatrix(outer.transform))
        .translate(-ox, -oy)
        .translate(ix, iy)
        .multiply(new DOMMatrix(inner.transform))
        .translate(-ix, -iy);
      return [
        [0, 0],
        [38, 0],
        [0, 38],
        [38, 38],
      ].map(([x, y]) => {
        const point = new DOMPoint(x, y).matrixTransform(matrix);
        return [point.x, point.y];
      });
    };
    const distance = (before, after) =>
      Math.max(
        ...before.map((point, index) =>
          Math.hypot(point[0] - after[index][0], point[1] - after[index][1]),
        ),
      );
    const change = (state) => {
      const before = pose();
      controller.setState(state);
      results.push({ state, jump: distance(before, pose()) });
    };
    const seekThrow = () => {
      const animation = isolated
        .getAnimations({ subtree: true })
        .find((a) => a.id === "download-mine-idle-warmup");
      animation.currentTime =
        Number(animation.effect.getTiming().duration) * 0.4;
    };
    try {
      controller.setVisible(true);
      await new Promise(requestAnimationFrame);
      seekThrow();
      change("running");
      await pause(75);
      change("paused");
      await pause(75);
      const cycle = isolated
        .getAnimations({ subtree: true })
        .find((a) => a.id === "download-mine-idle-warmup");
      for (const state of ["queued", "failed", "cancelled", "idle"]) {
        change(state);
        results.push({
          state,
          sameCycle: isolated.getAnimations({ subtree: true }).includes(cycle),
        });
      }
      controller.setVisible(false);
      const hidden = pose();
      await pause(120);
      results.push({ hiddenHandoffJump: distance(hidden, pose()) });
      controller.setVisible(true);
      await pause(400);
      seekThrow();
      change("running");
      await pause(75);
      change("failed");
      await pause(400);
    } finally {
      controller.dispose();
      results.push({
        animationsAfterDispose: isolated.getAnimations({ subtree: true })
          .length,
      });
      isolated.remove();
    }
    return results;
  });
  checks.push({
    name: "airborne-pose-continuity-rapid-reversals-hidden-handoff-and-disposal",
    transitions,
  });
  for (const transition of transitions) {
    if ("jump" in transition) expect(transition.jump).toBeLessThan(0.1);
    if ("sameCycle" in transition) expect(transition.sameCycle).toBe(true);
    if ("hiddenHandoffJump" in transition)
      expect(transition.hiddenHandoffJump).toBeLessThan(0.1);
    if ("animationsAfterDispose" in transition)
      expect(transition.animationsAfterDispose).toBe(0);
  }
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/report.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(`PASS ${checks.length} download mining integration checks.`);
} catch (error) {
  await writeFile(
    `${evidence}/failure.json`,
    JSON.stringify(
      {
        error: String(error),
        checks,
        errors,
        cycles: await page
          .evaluate(() => window.__mineCycles ?? [])
          .catch(() => []),
        frames: await page
          .evaluate(() => window.__collectionFrames ?? [])
          .catch(() => []),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
