import { openPlayerLogin } from "./lib/player-login.mjs";
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
  const f = window.__pixelTest;
  const invoke = window.__TAURI_INTERNALS__.invoke;
  f.littleSkin = {
    serial: 0,
    waiters: [],
    expires: 300,
    beginDelay: 400,
    saveDelay: 500,
    failSave: false,
  };
  f.finishLittleSkin = (error) => {
    for (const waiter of f.littleSkin.waiters.splice(0)) {
      if (error) waiter.reject(new Error(error));
      else
        waiter.resolve({
          sessionId: waiter.id,
          server: "https://littleskin.cn/api/yggdrasil",
          serverName: "LittleSkin",
          profiles: [
            { id: "builder", name: "Builder" },
            { id: "explorer", name: "Explorer" },
          ],
        });
    }
  };
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (
      command !== "request" ||
      !args.operation.startsWith("players.yggdrasil.")
    )
      return invoke(command, args);
    const { operation, payload } = args;
    f.requests.push({ operation, payload });
    if (operation === "players.yggdrasil.oauth.begin") {
      await new Promise((resolve) =>
        setTimeout(resolve, f.littleSkin.beginDelay),
      );
      return {
        sessionId: `little-${++f.littleSkin.serial}`,
        userCode: "ABCD-EFGH",
        verificationUri: "https://open.littleskin.cn/oauth/link",
        verificationUriComplete:
          "https://open.littleskin.cn/oauth/link?user_code=ABCD-EFGH",
        expiresIn: f.littleSkin.expires,
      };
    }
    if (operation === "players.yggdrasil.oauth.wait")
      return new Promise((resolve, reject) =>
        f.littleSkin.waiters.push({ id: payload.sessionId, resolve, reject }),
      );
    if (operation === "players.yggdrasil.select") {
      await new Promise((resolve) =>
        setTimeout(resolve, f.littleSkin.saveDelay),
      );
      if (f.littleSkin.failSave) throw new Error("保存失败，请重试");
    }
    return true;
  };
});
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
    ["stage", "identity", "content"].map(
      (part) => `sfmcl-t-player-login-${part}`,
    ),
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

const checkCompactLayout = async (state) => {
  const viewport = page.viewportSize();
  const theme = await page.locator("html").getAttribute("data-theme");
  for (const currentTheme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, currentTheme);
    for (const size of [
      { width: 850, height: 591 },
      { width: 650, height: 500 },
      { width: 375, height: 450 },
    ]) {
      await page.setViewportSize(size);
      await expect
        .poll(
          () =>
            ui.evaluate((el) => {
              const content = el.querySelector(".players-login-content");
              const collection = el.querySelector(".players-collection");
              const host = el.closest(".page");
              const bounds = content.getBoundingClientRect();
              const overflow = [
                content.scrollWidth - content.clientWidth,
                content.scrollHeight - content.clientHeight,
                collection.scrollWidth - collection.clientWidth,
                collection.scrollHeight - collection.clientHeight,
                host.scrollWidth - host.clientWidth,
                host.scrollHeight - host.clientHeight,
              ];
              for (const control of content.querySelectorAll("button")) {
                const rect = control.getBoundingClientRect();
                overflow.push(
                  rect.bottom - bounds.bottom,
                  bounds.top - rect.top,
                  rect.right - bounds.right,
                  bounds.left - rect.left,
                );
              }
              return Math.max(...overflow);
            }),
          {
            message: `${state} fits at ${size.width}x${size.height}/${currentTheme}`,
          },
        )
        .toBeLessThanOrEqual(1);
      await expect(ui.locator(".players-login-content")).toHaveCSS(
        "overflow-y",
        "visible",
      );
      expect(
        await ui.locator(".players-stage").evaluate((el) => el.clientHeight),
      ).toBeGreaterThan(24);
      await page.screenshot({
        path: `${evidence}/compact-${state}-${currentTheme}-${size.width}.png`,
      });
    }
  }
  await page.setViewportSize(viewport);
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  const nav = page.getByRole("navigation", { name: "主导航" });
  await page.locator(".sidebar .profile-button").click();
  await openPlayerLogin(page, "microsoft");
  await checkTransition("waiting");
  await checkCompactLayout("microsoft-waiting");
  await page.evaluate(() => {
    window.__pixelTest.failures["plugin:opener|open_url"] = "浏览器不可用";
  });
  await ui.getByRole("button", { name: "打开授权页面", exact: true }).click();
  await checkCompactLayout("microsoft-browser-error");
  await page.evaluate(() => {
    delete window.__pixelTest.failures["plugin:opener|open_url"];
  });
  await ui.getByRole("button", { name: "打开授权页面", exact: true }).click();
  const beforeTick = await count();
  const beforeTime = await ui.locator("time").textContent();
  await expect(ui.locator("time")).not.toHaveText(beforeTime);
  expect(await count()).toBe(beforeTick);

  await setStep(1);
  await checkTransition("xbox");
  await setStep(1, "failed");
  await checkTransition("failed");
  await checkCompactLayout("microsoft-failed");
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
  await openPlayerLogin(page, "microsoft");
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
  await openPlayerLogin(page, "microsoft");
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

  await openPlayerLogin(page, "offline");
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

  // LittleSkin uses the same complete scene transitions with real OAuth milestones.
  const littleBegins = () =>
    page.evaluate(
      () =>
        window.__pixelTest.requests.filter(
          (r) => r.operation === "players.yggdrasil.oauth.begin",
        ).length,
    );
  const littleBeginsBefore = await littleBegins();
  await openPlayerLogin(page, "yggdrasil-oauth");
  await checkTransition("waiting");
  await checkCompactLayout("littleskin-waiting");
  await page.evaluate(() => {
    window.__pixelTest.failures["plugin:opener|open_url"] = "浏览器不可用";
  });
  await ui.getByRole("button", { name: "打开授权页面", exact: true }).click();
  await checkCompactLayout("littleskin-browser-error");
  await page.evaluate(() => {
    delete window.__pixelTest.failures["plugin:opener|open_url"];
  });
  await ui.getByRole("button", { name: "打开授权页面", exact: true }).click();
  expect(await littleBegins()).toBe(littleBeginsBefore + 1);
  await expect(ui.locator(".players-auth-logo")).toHaveAttribute(
    "aria-label",
    "LittleSkin 登录步骤",
  );
  await expect(ui.locator(".players-login-steps .steps li")).toHaveClass([
    "completed",
    "running",
    "queued",
    "queued",
  ]);
  await expect(ui.locator(".players-auth-logo > svg")).toHaveCSS(
    "animation-name",
    "players-littleskin-globe",
  );
  await expect(ui.locator(".players-auth-orbit")).toHaveCSS(
    "animation-name",
    "players-provider-orbit",
  );
  const littleBeforeTick = await count();
  const littleBeforeTime = await ui.locator("time").textContent();
  await expect(ui.locator("time")).not.toHaveText(littleBeforeTime);
  expect(await count()).toBe(littleBeforeTick);
  const littleBeforeBrowser = await count();
  await ui.getByRole("button", { name: "打开授权页面", exact: true }).click();
  expect(await count()).toBe(littleBeforeBrowser);

  await page.evaluate(() => window.__pixelTest.finishLittleSkin());
  await checkTransition("profiles");
  await checkCompactLayout("littleskin-profiles");
  await expect(ui.locator(".players-login-steps .steps li")).toHaveClass([
    "completed",
    "completed",
    "running",
    "queued",
  ]);
  await expect(ui.locator(".players-auth-logo")).toHaveAttribute(
    "aria-label",
    "游戏角色 登录步骤",
  );
  await page.evaluate(() => {
    window.__pixelTest.littleSkin.failSave = true;
  });
  await ui.getByRole("button", { name: "Explorer", exact: true }).click();
  await checkTransition("saving");
  await checkTransition("failed");
  await expect(ui.getByRole("alert")).toContainText("保存失败");
  await checkCompactLayout("littleskin-failed");
  await page.evaluate(() => {
    window.__pixelTest.littleSkin.failSave = false;
  });
  await ui
    .getByRole("button", { name: "重试保存 Explorer", exact: true })
    .click();
  await checkTransition("saving");
  await checkTransition("completed");
  await expect(ui.locator(".players-login-steps")).toHaveCount(0);
  await expect(ui.locator(".players-login-result")).toContainText("角色已加入");
  await expect(ui).not.toHaveAttribute("data-login");

  await openPlayerLogin(page, "yggdrasil-oauth");
  await checkTransition("waiting");
  await page.evaluate(() =>
    window.__pixelTest.finishLittleSkin("你已拒绝 LittleSkin 授权"),
  );
  await checkTransition("failed");
  await ui
    .getByRole("button", { name: "重新授权 LittleSkin", exact: true })
    .click();
  await checkTransition("preparing");
  await checkTransition("waiting");
  await page.evaluate(() => window.__pixelTest.finishLittleSkin());
  await checkTransition("profiles");
  // Navigation cancels both the profile session and paused transition handles.
  await nav.getByRole("button", { name: "开始游戏", exact: true }).click();
  expect(
    await page.evaluate(() =>
      window.__loginMotions.every(
        ({ animation }) => animation.playState === "idle",
      ),
    ),
  ).toBe(true);
  await page.locator(".sidebar .profile-button").click();
  await checkTransition("waiting");
  await ui.getByRole("button", { name: "取消授权", exact: true }).click();
  await checkTransition("idle");
  await page.evaluate(() => window.__pixelTest.finishLittleSkin());
  await expect(
    ui.getByRole("button", { name: "Explorer", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.__pixelTest.littleSkin.expires = 1;
  });
  await ui
    .getByRole("button", { name: "使用 LittleSkin 授权登录", exact: true })
    .click();
  await checkTransition("preparing");
  await checkTransition("waiting");
  await checkTransition("expired");
  await expect(ui.getByRole("alert")).toContainText("过期");

  // Refresh failure retries the saved list, without consuming the profile session twice.
  await page.evaluate(() => {
    window.__pixelTest.littleSkin.expires = 300;
  });
  await ui
    .getByRole("button", { name: "重新授权 LittleSkin", exact: true })
    .click();
  await checkTransition("preparing");
  await checkTransition("waiting");
  await page.evaluate(() => window.__pixelTest.finishLittleSkin());
  await checkTransition("profiles");
  await page.evaluate(() => {
    window.__pixelTest.failures.bootstrap = "刷新失败";
  });
  await ui.getByRole("button", { name: "Explorer", exact: true }).click();
  await checkTransition("saving");
  await checkTransition("failed");
  await expect(ui.getByRole("alert")).toContainText("角色已保存");
  const littleSaves = () =>
    page.evaluate(
      () =>
        window.__pixelTest.requests.filter(
          (r) => r.operation === "players.yggdrasil.select",
        ).length,
    );
  const savesBeforeRefresh = await littleSaves();
  await page.evaluate(() => {
    delete window.__pixelTest.failures.bootstrap;
  });
  await ui.getByRole("button", { name: "刷新角色列表", exact: true }).click();
  await checkTransition("completed");
  await expect(ui).not.toHaveAttribute("data-login");
  expect(await littleSaves()).toBe(savesBeforeRefresh);
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/report.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(
    "PASS Microsoft and LittleSkin login states animate all regions; countdown/browser retries stay stable, real OAuth milestones and save retries advance steps, success remains visible, interruptions clean up, and full animations persist with reduced-motion enabled.",
  );
} finally {
  await browser.close();
}
