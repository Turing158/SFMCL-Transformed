import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { runtimePath } from "./lib/paths.mjs";

const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:4186";
const evidence = runtimePath("onboarding-verification");
await mkdir(evidence, { recursive: true });
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.SFMCL_T_BROWSER_EXECUTABLE
    ? { executablePath: process.env.SFMCL_T_BROWSER_EXECUTABLE }
    : existsSync(edge)
      ? { executablePath: edge }
      : {}),
});
const errors = [],
  checks = [],
  motions = [];
const fresh = async ({
  old = false,
  theme = "light",
  width = 1120,
  height = 720,
  reducedMotion = "reduce",
  dismissDuringEntry = false,
} = {}) => {
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(pixelAppFixture);
  await page.addInitScript(
    ({ old, theme, dismissDuringEntry }) => {
      const fixture = window.__pixelTest;
      fixture.data.players = [];
      fixture.versions.length = 0;
      Object.assign(fixture.data.settings, {
        activePlayer: "",
        activeVersion: "",
        activeDir: "",
        gameDirs: [],
        javaPaths: [],
        theme,
        onboardingVersion: old
          ? undefined
          : Number(sessionStorage.getItem("tour-version") || 0),
      });
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__tourCommands = [];
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        window.__tourCommands.push(command);
        const result = await invoke(command, args);
        if (command === "request" && args.operation === "settings.save")
          sessionStorage.setItem(
            "tour-version",
            String(result.onboardingVersion),
          );
        return result;
      };
      // Observe from insertion so the very first appearance cannot be missed
      // by a Playwright locator waiting until the card is already visible.
      window.__tourLifecycles = [];
      let observed;
      new MutationObserver(() => {
        const layer = document.querySelector(".onboarding-layer");
        if (!layer || layer === observed) return;
        observed = layer;
        const frames = [];
        window.__tourLifecycles.push(frames);
        const card = layer.querySelector(".onboarding-card");
        const readSvg = (selector) =>
          [...layer.querySelectorAll(selector)].map((element) =>
            Object.fromEntries(
              ["x", "y", "width", "height"].map((name) => [
                name,
                Number(element.getAttribute(name)),
              ]),
            ),
          );
        let dismissed = false;
        let frame = 0;
        const read = () => {
          const bounds = card.getBoundingClientRect();
          const opacity = Number(getComputedStyle(layer).opacity);
          return {
            time: performance.now(),
            phase: layer.dataset.phase,
            step: layer.dataset.step,
            opacity,
            measured: getComputedStyle(card).visibility === "visible",
            modal: layer.matches(":modal"),
            sameCard: card === layer.querySelector(".onboarding-card"),
            card: { left: bounds.left, top: bounds.top },
            outlines: readSvg(".onboarding-outline"),
            cutouts: readSvg('#onboarding-cutout rect[fill="black"]'),
            loginMenu: !!document.querySelector(".onboarding-login-menu"),
            enabledButtons: layer.querySelectorAll("button:not(:disabled)")
              .length,
          };
        };
        const sample = () => {
          frame = 0;
          if (!layer.isConnected) {
            frames.push({ time: performance.now(), phase: "removed" });
            phaseObserver.disconnect();
            return;
          }
          const snapshot = read();
          frames.push(snapshot);
          if (
            dismissDuringEntry &&
            !dismissed &&
            snapshot.opacity > 0.15 &&
            snapshot.opacity < 0.8
          ) {
            dismissed = true;
            layer.querySelector(".onboarding-skip").click();
          }
          if (snapshot.phase !== "open") frame = requestAnimationFrame(sample);
        };
        const phaseObserver = new MutationObserver(() => {
          if (!frame && layer.dataset.phase !== "open") sample();
          else if (
            layer.dataset.phase !== "open" ||
            frames.at(-1)?.phase !== "open"
          )
            frames.push(read());
        });
        phaseObserver.observe(layer, {
          attributes: true,
          attributeFilter: ["data-phase", "style"],
          subtree: true,
        });
        const recordDismiss = () =>
          frames.push({ ...read(), phase: "dismiss-request" });
        layer.addEventListener("cancel", recordDismiss, true);
        layer.addEventListener(
          "click",
          (event) => {
            const button = event.target.closest("button");
            if (button && ["跳过", "完成"].includes(button.textContent.trim()))
              recordDismiss();
          },
          true,
        );
        sample();
      }).observe(document, { childList: true, subtree: true });
    },
    { old, theme, dismissDuringEntry },
  );
  await page.goto(url);
  await page.waitForFunction(
    () => !document.documentElement.hasAttribute("data-startup"),
  );
  return page;
};
const tour = (page) => page.locator(".onboarding-layer");
const next = (page) =>
  tour(page).getByRole("button", { name: "下一步", exact: true });
const lifecycleEvidence = [];
const verifyEntrance = async (page, id) => {
  await expect(tour(page)).toHaveAttribute("data-moving", "false");
  const frames = await page.evaluate(() => window.__tourLifecycles.at(-1));
  const samples = frames.filter((frame) => frame.measured);
  expect(frames[0].opacity).toBe(0);
  expect(samples[0].opacity).toBeLessThan(0.5);
  expect(samples.at(-1).opacity).toBe(1);
  expect(samples.at(-1).phase).toBe("open");
  expect(new Set(samples.map((frame) => frame.opacity)).size).toBeGreaterThan(
    3,
  );
  expect(samples[0].card.top - samples.at(-1).card.top).toBeGreaterThan(4);
  for (let i = 1; i < samples.length; i++) {
    expect(samples[i].opacity).toBeGreaterThanOrEqual(samples[i - 1].opacity);
    expect(samples[i].card.top).toBeLessThanOrEqual(
      samples[i - 1].card.top + 0.1,
    );
  }
  expect(samples.every((frame) => frame.modal && frame.sameCard)).toBe(true);
  lifecycleEvidence.push({ id, frames });
};
const verifyExit = async (page, id, { interrupted = false } = {}) => {
  await expect(tour(page)).toHaveCount(0);
  await page.waitForFunction(
    () => window.__tourLifecycles.at(-1)?.at(-1)?.phase === "removed",
  );
  const frames = await page.evaluate(() => window.__tourLifecycles.at(-1));
  const samples = frames.filter((frame) => frame.phase === "closing");
  expect(samples.length).toBeGreaterThan(3);
  expect(samples[0].opacity).toBeGreaterThan(0);
  if (interrupted) expect(samples[0].opacity).toBeLessThan(1);
  else expect(samples[0].opacity).toBe(1);
  expect(samples.at(-1).opacity).toBeLessThan(0.05);
  expect(new Set(samples.map((frame) => frame.opacity)).size).toBeGreaterThan(
    3,
  );
  expect(samples.at(-1).card.top - samples[0].card.top).toBeGreaterThan(4);
  expect(
    samples.every(
      (frame) => frame.modal && frame.sameCard && !frame.enabledButtons,
    ),
  ).toBe(true);
  if (samples[0].step === "players")
    expect(samples.every((frame) => frame.loginMenu)).toBe(true);
  for (let i = 0; i < samples.length; i++) {
    const frame = samples[i];
    expect(frame.cutouts).toEqual(frame.outlines);
    expect(Math.abs(frame.card.left - samples[0].card.left)).toBeLessThan(0.1);
    if (i > 0) {
      expect(frame.opacity).toBeLessThanOrEqual(samples[i - 1].opacity);
      expect(frame.card.top).toBeGreaterThanOrEqual(samples[i - 1].card.top);
    }
    frame.outlines.forEach((rect, index) => {
      const original = samples[0].outlines[index];
      expect(rect.x).toBe(original.x);
      expect(rect.y).toBe(original.y);
      expect(rect.width).toBeLessThanOrEqual(original.width);
      expect(rect.height).toBeLessThanOrEqual(original.height);
    });
  }
  for (const [index, rect] of samples[0].outlines.entries()) {
    expect(samples.at(-1).outlines[index]?.width ?? 0).toBeLessThan(
      rect.width / 4,
    );
    expect(samples.at(-1).outlines[index]?.height ?? 0).toBeLessThan(
      rect.height / 4,
    );
  }
  // Saving may let the entry/step animation advance after the click. Once
  // closing begins, its first animation frame must retain the drawn state.
  const firstClosing = frames.findIndex((frame) => frame.phase === "closing");
  expect(samples[1].card).toEqual(samples[0].card);
  expect(samples[1].opacity).toBe(samples[0].opacity);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement.closest(".sidebar") !== null,
      ),
    )
    .toBe(true);
  lifecycleEvidence.push({
    id,
    frames: frames.slice(Math.max(0, firstClosing - 2)),
  });
};
const step = async (page, id, owner) => {
  await expect(tour(page)).toHaveAttribute("data-step", id);
  await expect(page.locator("main.page")).toHaveAttribute("data-page", owner);
  await expect(
    tour(page).getByRole("button", {
      name: id === "launch" ? "完成" : "下一步",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(tour(page)).toHaveAttribute("data-moving", "false");
  await page.evaluate(async () => {
    // Let the real page/tab transitions settle before checking geometry and
    // taking evidence, without waiting for unrelated looping decorations.
    const animations = document
      .getAnimations()
      .filter(
        (animation) =>
          animation.id.startsWith("sfmcl-t-navigation-") ||
          animation.id === "sfmcl-t-resource-tab",
      );
    await Promise.allSettled(animations.map((animation) => animation.finished));
    await new Promise(requestAnimationFrame);
  });
  // The note must fit the viewport and leave every highlighted control visible.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const card = document
          .querySelector(".onboarding-card")
          .getBoundingClientRect();
        const holes = [...document.querySelectorAll(".onboarding-outline")].map(
          (rect) => rect.getBoundingClientRect(),
        );
        return (
          holes.length > 0 &&
          card.left >= 0 &&
          card.top >= 0 &&
          card.right <= innerWidth &&
          card.bottom <= innerHeight &&
          holes.every(
            (rect) =>
              Math.min(card.right, rect.right) <=
                Math.max(card.left, rect.left) ||
              Math.min(card.bottom, rect.bottom) <=
                Math.max(card.top, rect.top),
          )
        );
      }),
    )
    .toBe(true);
  if (id === "players-entry" || id === "versions-entry") {
    await expect(page.locator(".onboarding-login-menu")).toHaveCount(0);
    await expect(page.locator(".onboarding-outline")).toHaveCount(1);
    // The entry itself must be fully highlighted, including a collapsed rail.
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const target = document
            .querySelector(`[data-tour="${id}"]`)
            .getBoundingClientRect();
          const highlight = document
            .querySelector(".onboarding-outline")
            .getBoundingClientRect();
          return (
            target.width > 0 &&
            target.height > 0 &&
            highlight.left <= target.left &&
            highlight.top <= target.top &&
            highlight.right >= target.right &&
            highlight.bottom >= target.bottom
          );
        }, id),
      )
      .toBe(true);
  }
};
const assertNoActions = async (page) => {
  expect(
    await page.evaluate(() =>
      window.__tourCommands.filter((name) => name === "plugin:dialog|open"),
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(() =>
      window.__pixelTest.requests.filter(({ operation }) =>
        /^(launch$|players\.(add|login)|java\.(discover|probe)|minecraft\.install|downloads\.(start|retry))/.test(
          operation,
        ),
      ),
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(() => ({
      players: window.__pixelTest.data.players,
      versions: window.__pixelTest.versions,
      dirs: window.__pixelTest.data.settings.gameDirs,
    })),
  ).toEqual({ players: [], versions: [], dirs: [] });
};

// Sample rendered frames, including the very first one after a step change.
// Checking only the settled position would miss a flash, teleport or early removal.
const captureMotion = (page, button, expectedStep, interrupt = false) =>
  page.evaluate(
    async ({ button, expectedStep, interrupt }) => {
      const layer = document.querySelector(".onboarding-layer");
      const originalCard = document.querySelector(".onboarding-card");
      const originalOutline = document.querySelector(".onboarding-outline");
      const readRect = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
      };
      const readSvg = (element) =>
        Object.fromEntries(
          ["x", "y", "width", "height"].map((name) => [
            name,
            Number(element.getAttribute(name)),
          ]),
        );
      const addedTarget = () => {
        const selector = {
          "players-entry": '[data-tour="players-entry"]',
          players: ".page [data-player-login-trigger]",
          downloads: ".sidebar-downloads",
        }[layer.dataset.step];
        const element = selector ? document.querySelector(selector) : null;
        return element ? readRect(element) : null;
      };
      const read = () => ({
        time: performance.now(),
        step: layer.dataset.step,
        moving: layer.dataset.moving,
        pageAnimations: document
          .getAnimations()
          .filter(
            (animation) =>
              animation.playState === "running" &&
              (animation.id.startsWith("sfmcl-t-navigation-") ||
                animation.id === "sfmcl-t-resource-tab"),
          )
          .map((animation) => ({
            id: animation.id,
            time: Number(animation.currentTime),
          })),
        addedTarget: addedTarget(),
        card: readRect(originalCard),
        visible: originalCard.checkVisibility({
          checkVisibilityCSS: true,
          checkOpacity: true,
        }),
        sameCard: originalCard === document.querySelector(".onboarding-card"),
        sameOutline:
          !originalOutline ||
          originalOutline === document.querySelector(".onboarding-outline"),
        outlines: [...document.querySelectorAll(".onboarding-outline")].map(
          readSvg,
        ),
        cutouts: [
          ...document.querySelectorAll('#onboarding-cutout rect[fill="black"]'),
        ].map(readSvg),
      });
      const frames = [read()];
      const click = (label) =>
        [...layer.querySelectorAll("button")]
          .find((element) => element.textContent.trim() === label)
          ?.click();
      click(button);
      let settled = 0,
        interrupted = false;
      while (performance.now() - frames[0].time < 2500) {
        await new Promise(requestAnimationFrame);
        const frame = read();
        frames.push(frame);
        if (
          interrupt &&
          !interrupted &&
          frame.step === "players" &&
          frame.outlines.length === 2 &&
          frame.outlines[1].width > 10
        ) {
          click("上一步");
          interrupted = true;
        }
        settled =
          frame.step === expectedStep &&
          frame.moving === "false" &&
          (!interrupt || interrupted)
            ? settled + 1
            : 0;
        if (settled >= 3) break;
      }
      return frames;
    },
    { button, expectedStep, interrupt },
  );

const verifyMotion = (frames, fromCount, toCount) => {
  const before = frames[0],
    after = frames.at(-1);
  expect(after.moving).toBe("false");
  expect(before.outlines.length).toBe(fromCount);
  expect(after.outlines.length).toBe(toCount);
  expect(
    frames.every(
      (frame) => frame.visible && frame.sameCard && frame.sameOutline,
    ),
  ).toBe(true);
  for (const frame of frames) expect(frame.cutouts).toEqual(frame.outlines);
  const distinctPositions = new Set(
    frames.map(
      ({ card }) => `${Math.round(card.left)},${Math.round(card.top)}`,
    ),
  );
  expect(distinctPositions.size).toBeGreaterThan(3);
  // The card starts at its prior position, even while the target page mounts.
  const firstChanged = frames.find((frame) => frame.step !== before.step);
  expect(Math.abs(firstChanged.card.left - before.card.left)).toBeLessThan(1);
  expect(Math.abs(firstChanged.card.top - before.card.top)).toBeLessThan(1);
  if (fromCount && toCount) {
    expect(
      new Set(
        frames.map(
          (frame) =>
            `${Math.round(frame.outlines[0].x)},${Math.round(frame.outlines[0].y)}`,
        ),
      ).size,
    ).toBeGreaterThan(3);
  }
  if (toCount > fromCount) {
    const added = after.outlines[fromCount];
    const samples = frames.flatMap((frame) =>
      frame.outlines[fromCount] ? [frame.outlines[fromCount]] : [],
    );
    expect(samples[0].width).toBeLessThan(1);
    expect(samples[0].height).toBeLessThan(1);
    expect(
      samples.some(
        (rect) =>
          rect.width > 1 &&
          rect.width < added.width - 1 &&
          rect.height > 1 &&
          rect.height < added.height - 1,
      ),
    ).toBe(true);
    // The growth origin follows the target's top-left while its page slides.
    // Allow one rendered frame of displacement between the two RAF callbacks.
    const anchored = frames.filter(
      (frame) => frame.outlines[fromCount] && frame.addedTarget,
    );
    expect(anchored.length).toBeGreaterThan(3);
    for (const frame of anchored) {
      const rect = frame.outlines[fromCount],
        target = frame.addedTarget;
      const previous = frames[frames.indexOf(frame) - 1];
      const priorTarget =
        previous?.step === frame.step ? previous.addedTarget : null;
      // Compare against one actual frame of target travel; a fixed pixel
      // allowance incorrectly fails when a busy browser takes a longer frame.
      const travelX = priorTarget
        ? Math.abs(target.left - priorTarget.left)
        : 10;
      const travelY = priorTarget ? Math.abs(target.top - priorTarget.top) : 10;
      expect(Math.abs(rect.x - Math.max(8, target.left - 6))).toBeLessThan(
        travelX + 2,
      );
      expect(Math.abs(rect.y - Math.max(8, target.top - 6))).toBeLessThan(
        travelY + 2,
      );
    }
  }
  if (toCount < fromCount) {
    const removed = before.outlines[toCount];
    const samples = frames.flatMap((frame) =>
      frame.outlines[toCount] ? [frame.outlines[toCount]] : [],
    );
    expect(
      samples.some(
        (rect) =>
          rect.width > 1 &&
          rect.width < removed.width - 1 &&
          rect.height > 1 &&
          rect.height < removed.height - 1,
      ),
    ).toBe(true);
    expect(samples.at(-1).width).toBeLessThan(removed.width / 4);
    expect(samples.at(-1).height).toBeLessThan(removed.height / 4);
    expect(
      samples.every(
        (rect) =>
          Math.abs(rect.x - removed.x) < 1 && Math.abs(rect.y - removed.y) < 1,
      ),
    ).toBe(true);
  }
};
const verifyConcurrentMotion = (
  frames,
  animationId = "sfmcl-t-navigation-content",
) => {
  const before = frames[0];
  const overlaps = frames.filter((frame) => {
    const animation = frame.pageAnimations.find(
      (entry) => entry.id === animationId,
    );
    const cardMoved =
      Math.hypot(
        frame.card.left - before.card.left,
        frame.card.top - before.card.top,
      ) > 1;
    const outlineMoved =
      Math.hypot(
        frame.outlines[0].x - before.outlines[0].x,
        frame.outlines[0].y - before.outlines[0].y,
      ) > 1;
    return animation && cardMoved && outlineMoved;
  });
  expect(overlaps.length).toBeGreaterThan(2);
  // Both guide elements must already move in the opening part of the page
  // animation; merely starting at the very end would still feel sequential.
  expect(
    overlaps[0].pageAnimations.find((entry) => entry.id === animationId).time,
  ).toBeLessThan(100);
};
try {
  const page = await fresh();
  await expect(tour(page)).toHaveAttribute("data-step", "welcome");
  await verifyEntrance(page, "welcome-reduced-motion");
  await page.screenshot({ path: `${evidence}/welcome.png` });
  await tour(page).getByRole("button", { name: "开始引导" }).click();
  await step(page, "players-entry", "home");
  await expect(tour(page).locator(".onboarding-topline")).toContainText(
    "1 / 7",
  );
  await page.screenshot({ path: `${evidence}/players-entry.png` });
  await next(page).click();
  await step(page, "players", "players");
  await expect(page.locator(".onboarding-login-menu")).toBeVisible();
  await expect(page.locator("[data-player-login-trigger]")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await page.screenshot({ path: `${evidence}/players.png` });
  await next(page).click();
  await step(page, "versions-entry", "players");
  await page.screenshot({ path: `${evidence}/versions-entry.png` });
  await next(page).click();
  await step(page, "directory", "versions");
  await expect(page.locator(".onboarding-login-menu")).toHaveCount(0);
  await page.screenshot({ path: `${evidence}/directory.png` });
  await tour(page).getByRole("button", { name: "上一步" }).click();
  await step(page, "versions-entry", "players");
  await tour(page).getByRole("button", { name: "上一步" }).click();
  await step(page, "players", "players");
  await expect(page.locator(".onboarding-login-menu")).toBeVisible();
  await tour(page).getByRole("button", { name: "上一步" }).click();
  await step(page, "players-entry", "home");
  await next(page).click();
  await step(page, "players", "players");
  await next(page).click();
  await step(page, "versions-entry", "players");
  await next(page).click();
  await step(page, "directory", "versions");
  await next(page).click();
  await step(page, "java", "settings");
  await expect(page.locator(".settings-page")).toHaveAttribute(
    "data-tab",
    "game",
  );
  await page.screenshot({ path: `${evidence}/java.png` });
  await next(page).click();
  await step(page, "downloads", "downloads");
  await expect(page.locator(".sidebar-downloads")).toBeVisible();
  await page.screenshot({ path: `${evidence}/downloads.png` });
  await next(page).click();
  await step(page, "launch", "home");
  await page.screenshot({ path: `${evidence}/launch.png` });
  await assertNoActions(page);
  // Native dialog focus and explicit wrap keep keyboard navigation in the guide.
  const finish = tour(page).getByRole("button", { name: "完成", exact: true });
  await finish.focus();
  await page.keyboard.press("Tab");
  await expect(
    tour(page).getByRole("button", { name: "跳过", exact: true }),
  ).toBeFocused();
  await finish.click();
  await verifyExit(page, "complete-reduced-motion");
  await expect
    .poll(() =>
      page.evaluate(() => window.__pixelTest.data.settings.onboardingVersion),
    )
    .toBe(1);
  await page.reload();
  await page.waitForFunction(
    () => !document.documentElement.hasAttribute("data-startup"),
  );
  await expect(tour(page)).toHaveCount(0);
  checks.push(
    "Empty installation completes all seven steps, highlighting both navigation entries before opening their pages, without login, installation, Java discovery or file picking; completion persists across reload.",
  );

  // Replaying works even after the settings page was retained on another tab.
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "重新查看引导" }).click();
  await verifyEntrance(page, "replay");
  await tour(page).getByRole("button", { name: "开始引导" }).click();
  await step(page, "players-entry", "home");
  await next(page).click();
  await step(page, "players", "players");
  await page.keyboard.press("Escape");
  await verifyExit(page, "escape-with-login-menu");
  await expect(page.locator(".onboarding-login-menu")).toHaveCount(0);
  await page.locator("[data-player-login-trigger]").click();
  await expect(page.getByRole("menu", { name: "登录方式" })).toBeVisible();
  await page.getByRole("menuitem", { name: "离线登录", exact: true }).click();
  await expect(page.locator(".players-page")).toHaveAttribute(
    "data-login",
    "offline",
  );
  checks.push(
    "Replay, previous step, Escape dismissal, focus trapping and normal login menu work after the tour.",
  );

  for (const size of [
    { width: 800, height: 600, theme: "dark" },
    { width: 864, height: 591, theme: "light" },
    { width: 1440, height: 900, theme: "light" },
  ]) {
    const resized = await fresh(size);
    await tour(resized).getByRole("button", { name: "开始引导" }).click();
    for (const [id, owner] of [
      ["players-entry", "home"],
      ["players", "players"],
      ["versions-entry", "players"],
      ["directory", "versions"],
      ["java", "settings"],
      ["downloads", "downloads"],
      ["launch", "home"],
    ]) {
      await step(resized, id, owner);
      await resized.screenshot({ path: `${evidence}/${size.width}-${id}.png` });
      if (id !== "launch") await next(resized).click();
    }
    await resized.setViewportSize({ width: 1000, height: 640 });
    await step(resized, "launch", "home");
    await tour(resized)
      .getByRole("button", { name: "完成", exact: true })
      .click();
    await expect(tour(resized)).toHaveCount(0);
    await assertNoActions(resized);
    await resized.context().close();
  }
  checks.push(
    "Light and dark themes, 800×600 / 864×591 / 1120×720 / 1440×900 windows and live resize keep notes clear of highlighted controls.",
  );

  const animated = await fresh({ reducedMotion: "no-preference" });
  await verifyEntrance(animated, "welcome-full-motion");
  let fromCount = 0;
  for (const [id, owner, count] of [
    ["players-entry", "home", 1],
    ["players", "players", 2],
    ["versions-entry", "players", 1],
    ["directory", "versions", 1],
    ["java", "settings", 1],
    ["downloads", "downloads", 2],
    ["launch", "home", 1],
  ]) {
    const frames = await captureMotion(
      animated,
      fromCount ? "下一步" : "开始引导",
      id,
    );
    motions.push({ id, frames });
    verifyMotion(frames, fromCount, count);
    if (["players", "directory", "java", "downloads", "launch"].includes(id))
      verifyConcurrentMotion(frames);
    if (id === "java") verifyConcurrentMotion(frames, "sfmcl-t-resource-tab");
    await step(animated, id, owner);
    fromCount = count;
  }
  const backwards = await captureMotion(animated, "上一步", "downloads");
  motions.push({ id: "back-to-downloads", frames: backwards });
  verifyMotion(backwards, 1, 2);
  verifyConcurrentMotion(backwards);
  await step(animated, "downloads", "downloads");
  await assertNoActions(animated);
  await tour(animated)
    .getByRole("button", { name: "跳过", exact: true })
    .click();
  await verifyExit(animated, "skip-two-highlights");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "重新查看引导" }).click();
  await expect(tour(page)).toHaveAttribute("data-moving", "false");
  // Reduced motion still preserves the explicitly requested displacement,
  // with a shorter transition. Test interruption from the current drawn frame.
  await tour(page).getByRole("button", { name: "开始引导" }).click();
  await step(page, "players-entry", "home");
  const interruptedMotion = await captureMotion(
    page,
    "下一步",
    "players-entry",
    true,
  );
  motions.push({ id: "interrupted", frames: interruptedMotion });
  expect(interruptedMotion.at(-1).step).toBe("players-entry");
  expect(interruptedMotion.at(-1).moving).toBe("false");
  expect(
    interruptedMotion.every(
      (frame) => frame.visible && frame.sameCard && frame.sameOutline,
    ),
  ).toBe(true);
  const reversedIndex = interruptedMotion.findIndex(
    (frame, i) =>
      i > 0 &&
      frame.step === "players-entry" &&
      interruptedMotion[i - 1].step === "players",
  );
  expect(reversedIndex).toBeGreaterThan(0);
  expect(
    Math.abs(
      interruptedMotion[reversedIndex].card.left -
        interruptedMotion[reversedIndex - 1].card.left,
    ),
  ).toBeLessThan(1);
  expect(
    Math.abs(
      interruptedMotion[reversedIndex].card.top -
        interruptedMotion[reversedIndex - 1].card.top,
    ),
  ).toBeLessThan(1);
  await step(page, "players-entry", "home");
  checks.push(
    "Every step moves the retained card and highlight frames continuously; page and tab transitions overlap with both guide animations from their opening frames, additions grow from the moving target's top-left, removals shrink before unmounting, mask cutouts stay synchronized, and interrupted moves resume from the current position.",
  );

  const skip = await fresh();
  await skip.evaluate(() => {
    window.__pixelTest.failures["settings.save"] = "test save failure";
  });
  await tour(skip).getByRole("button", { name: "跳过", exact: true }).click();
  await expect(tour(skip).getByRole("alert")).toContainText("保存失败");
  await expect(tour(skip)).toHaveAttribute("data-phase", "open");
  expect(
    await skip.evaluate(() =>
      window.__tourLifecycles.at(-1).some((frame) => frame.phase === "closing"),
    ),
  ).toBe(false);
  await skip.evaluate(() => {
    delete window.__pixelTest.failures["settings.save"];
  });
  await tour(skip).getByRole("button", { name: "跳过", exact: true }).click();
  await verifyExit(skip, "skip-after-save-retry");
  const interrupted = await fresh();
  await tour(interrupted).getByRole("button", { name: "开始引导" }).click();
  await step(interrupted, "players-entry", "home");
  await next(interrupted).click();
  await step(interrupted, "players", "players");
  await interrupted.reload();
  await expect(tour(interrupted)).toHaveAttribute("data-step", "welcome");
  await tour(interrupted).getByRole("button", { name: "开始引导" }).click();
  await step(interrupted, "players-entry", "home");
  await next(interrupted).click();
  await step(interrupted, "players", "players");
  await tour(interrupted)
    .getByRole("button", { name: "跳过", exact: true })
    .click();
  await expect(tour(interrupted)).toHaveCount(0);
  await expect(interrupted.locator(".onboarding-login-menu")).toHaveCount(0);
  expect(
    await interrupted.evaluate(() => sessionStorage.getItem("tour-version")),
  ).toBe("1");
  await skip.reload();
  await skip.waitForFunction(
    () => !document.documentElement.hasAttribute("data-startup"),
  );
  await expect(tour(skip)).toHaveCount(0);
  const old = await fresh({ old: true });
  await expect(tour(old)).toHaveCount(0);
  const earlyExit = await fresh({
    reducedMotion: "no-preference",
    dismissDuringEntry: true,
  });
  await verifyExit(earlyExit, "skip-during-entrance", { interrupted: true });
  const movingExit = await fresh({ reducedMotion: "no-preference" });
  await tour(movingExit).getByRole("button", { name: "开始引导" }).click();
  await step(movingExit, "players-entry", "home");
  await movingExit.evaluate(async () => {
    const layer = document.querySelector(".onboarding-layer");
    [...layer.querySelectorAll("button")]
      .find((button) => button.textContent.trim() === "下一步")
      .click();
    while (true) {
      await new Promise(requestAnimationFrame);
      const outline = layer.querySelectorAll(".onboarding-outline")[1];
      if (
        layer.dataset.step === "players" &&
        Number(outline?.getAttribute("width")) > 10
      )
        break;
    }
    layer.querySelector(".onboarding-skip").click();
    layer.querySelector(".onboarding-skip").click();
    layer.dispatchEvent(new Event("cancel", { cancelable: true }));
  });
  await verifyExit(movingExit, "skip-during-page-movement");
  expect(
    await movingExit.evaluate(
      () =>
        window.__pixelTest.requests.filter(
          (request) => request.operation === "settings.save",
        ).length,
    ),
  ).toBe(1);
  checks.push(
    "Initial and replay appearances slide/fade in; completion, skip and Escape slide/fade out while highlights shrink and remain aligned with the mask. Modal focus and presentation menus survive until exit completes, failures stay open, and early/repeated dismissal preserves continuity without duplicate saves.",
  );
  checks.push(
    "Welcome skip is persisted; failed writes allow retry; legacy empty configurations do not auto-open the guide.",
  );
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ checks, errors, evidence }, null, 2));
} catch (error) {
  for (const [i, context] of browser.contexts().entries())
    for (const page of context.pages())
      await page
        .screenshot({ path: `${evidence}/failure-${i}.png` })
        .catch(() => {});
  throw error;
} finally {
  await writeFile(`${evidence}/motion.json`, JSON.stringify(motions, null, 2));
  await writeFile(
    `${evidence}/lifecycle.json`,
    JSON.stringify(lifecycleEvidence, null, 2),
  );
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  await browser.close();
}
