import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { playersFixture } from "./fixtures/players.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("players-login-motion");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 656 } });
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(playersFixture);
await page.addInitScript(() => {
  window.__loginMotions = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (frames, options) {
    const animation = animate.call(this, frames, options);
    if (options?.id?.startsWith("sfmcl-t-player-login-")) {
      window.__loginMotions.push({
        state: document.querySelector(".players-page").dataset.loginState,
        animation,
      });
      // Pause real animations so even fast states can be sampled deterministically.
      animation.pause();
      animation.currentTime = 100;
    }
    return animation;
  };
});
const ui = page.locator(".players-page");
const count = () => page.evaluate(() => window.__loginMotions.length);
const finish = () =>
  page.evaluate(() => {
    for (const { animation } of window.__loginMotions) {
      if (animation.playState === "paused") animation.finish();
    }
  });
const setStep = (step, status = "running") =>
  page.evaluate(
    ({ step, status }) => {
      const job = window.__pixelTest.tasks.jobs.at(-1);
      job.currentStep = step;
      job.status = status;
      job.error = status === "failed" ? "登录验证失败，请重试。" : "";
      job.steps.forEach((item, index) => {
        item.status =
          status === "completed" || index < step
            ? "completed"
            : index === step
              ? status
              : "queued";
      });
    },
    { step, status },
  );
const checkTransition = async (state) => {
  await expect(ui).toHaveAttribute("data-login-state", state);
  const samples = await page.evaluate(() =>
    window.__loginMotions.slice(-3).map(({ state, animation }) => {
      const element = animation.effect.target;
      const sample = (time) => {
        animation.currentTime = time;
        const style = getComputedStyle(element);
        return {
          opacity: Number(style.opacity),
          y: new DOMMatrix(style.transform).m42,
        };
      };
      const start = sample(0);
      const end = sample(280);
      const middle = sample(100);
      return { state, id: animation.id, start, middle, end };
    }),
  );
  expect(samples.map((sample) => sample.state)).toEqual([state, state, state]);
  expect(samples.map((sample) => sample.id)).toEqual(
    ["stage", "identity", "content"].map((part) => `sfmcl-t-player-login-${part}`),
  );
  for (const { start, middle, end } of samples) {
    expect(start.opacity).toBe(0);
    expect(middle.opacity).toBeGreaterThan(0);
    expect(middle.opacity).toBeLessThan(1);
    expect(end.opacity).toBe(1);
    expect(Math.abs(middle.y)).toBeGreaterThan(0);
    expect(Math.abs(middle.y)).toBeLessThan(Math.abs(start.y));
    expect(end.y).toBe(0);
  }
  await page.screenshot({ path: `${evidence}/${state}-middle.png` });
  await finish();
  checks.push({ state, samples });
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  const nav = page.getByRole("navigation", { name: "主导航" });
  await page.locator(".sidebar .profile-button").click();
  await ui.locator('[data-player-login="microsoft"]').click();
  await checkTransition("waiting");
  const beforeTick = await count();
  const beforeTime = await ui.locator("time").textContent();
  await expect(ui.locator("time")).not.toHaveText(beforeTime);
  expect(await count()).toBe(beforeTick);

  await setStep(1);
  await checkTransition("xbox");
  await setStep(1, "failed");
  await checkTransition("failed");
  await page.evaluate(() => {
    window.__pixelTest.delays["players.login"] = 600;
  });
  await ui.getByRole("button", { name: "重新登录", exact: true }).click();
  await checkTransition("preparing");
  await checkTransition("waiting");
  for (const [step, state] of [
    [1, "xbox"],
    [2, "minecraft"],
    [3, "saving"],
  ]) {
    await setStep(step);
    await checkTransition(state);
  }
  await setStep(3, "completed");
  await checkTransition("completed");
  await expect(ui.locator(".players-login-result")).toBeVisible();
  await expect(ui).not.toHaveAttribute("data-login");

  // Fast steps cancel interrupted animation handles, and navigation cleans up.
  await ui.locator('[data-player-login="microsoft"]').click();
  await checkTransition("waiting");
  await setStep(1);
  await expect(ui).toHaveAttribute("data-login-state", "xbox");
  await setStep(2);
  await expect(ui).toHaveAttribute("data-login-state", "minecraft");
  expect(
    await page.evaluate(() =>
      window.__loginMotions
        .slice(-6, -3)
        .every(({ animation }) => animation.playState === "idle"),
    ),
  ).toBe(true);
  await nav.getByRole("button", { name: "开始游戏", exact: true }).click();
  expect(
    await page.evaluate(() =>
      window.__loginMotions.every(
        ({ animation }) => animation.playState === "idle",
      ),
    ),
  ).toBe(true);

  await page.locator(".sidebar .profile-button").click();
  // The profile entry resumes the owned login; explicit back starts a fresh one.
  await page
    .getByRole("navigation", { name: "页面路径" })
    .getByRole("button", { name: "返回上一级", exact: true })
    .click();
  await page.evaluate(() => {
    window.__pixelTest.loginExpiresIn = 1;
  });
  await ui.locator('[data-player-login="microsoft"]').click();
  await checkTransition("waiting");
  await checkTransition("expired");
  await page.evaluate(() => {
    window.__pixelTest.failures["players.login"] = "无法获取设备代码";
  });
  await ui.getByRole("button", { name: "重新登录", exact: true }).click();
  await checkTransition("preparing");
  await checkTransition("failed");

  await page.emulateMedia({ reducedMotion: "reduce" });
  const beforeReduced = await count();
  await page.evaluate(() => {
    delete window.__pixelTest.failures["players.login"];
    window.__pixelTest.loginExpiresIn = 900;
  });
  await ui.getByRole("button", { name: "重新登录", exact: true }).click();
  await checkTransition("preparing");
  await checkTransition("waiting");
  await setStep(1);
  await checkTransition("xbox");
  expect(await count()).toBe(beforeReduced + 9);
  await expect(ui.locator(".players-auth-logo")).toHaveCSS(
    "animation-name",
    "players-provider-float",
  );
  await expect(ui.locator(".players-auth-orbit")).toHaveCSS(
    "animation-name",
    "players-provider-orbit",
  );

  // Changing the system preference must not cancel an in-flight transition.
  await setStep(2);
  await expect(ui).toHaveAttribute("data-login-state", "minecraft");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page.evaluate(() =>
      window.__loginMotions
        .slice(-3)
        .every(({ animation }) => animation.playState === "paused"),
    ),
  ).toBe(true);
  await checkTransition("minecraft");

  await ui.locator('[data-player-login="offline"]').click();
  await expect(ui).toHaveAttribute("data-login", "offline");
  await expect(ui.locator(".camp-flame")).toHaveCSS(
    "animation-name",
    "players-camp-flicker",
  );
  await expect(ui.locator(".camp-ember").first()).toHaveCSS(
    "animation-name",
    "players-camp-rise",
  );
  await expect(ui.locator(".camp-glow")).toHaveCSS(
    "animation-name",
    "players-camp-warmth",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/report.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(
    "PASS All login states animate both regions; countdowns stay stable, success remains visible, interruptions clean up, and both login pages retain full animations for every system motion preference.",
  );
} finally {
  await browser.close();
}
