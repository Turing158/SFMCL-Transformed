import { openPlayerLogin } from "./lib/player-login.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { runtimePath } from "./lib/paths.mjs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { playersFixture } from "./fixtures/players.mjs";

const evidence = runtimePath("yggdrasil-login");
const oauthEnabled = process.env.VITE_SFMCL_T_THIRD_PARTY_OAUTH === "true";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(8000);
await page.addInitScript({
  content: `(${pixelAppFixture.toString()})(); (${playersFixture.toString()})();`,
});
await page.addInitScript(() => {
  const animate = Element.prototype.animate;
  window.__serverMotions = [];
  Element.prototype.animate = function (...args) {
    const motion = animate.apply(this, args);
    if (
      args[1]?.id === "sfmcl-t-select-popup" &&
      this.classList.contains("players-server-popup")
    ) {
      window.__serverMotions.push(motion);
      if (window.__holdServerMotion) motion.pause();
    }
    return motion;
  };
  const f = window.__pixelTest;
  const original = window.__TAURI_INTERNALS__.invoke;
  const callbacks = new Map();
  const listeners = new Map();
  let nextCallback = 0;
  let nextListener = 0;
  window.__TAURI_INTERNALS__.transformCallback = (callback) => {
    const id = ++nextCallback;
    callbacks.set(id, callback);
    return id;
  };
  window.__TAURI_INTERNALS__.unregisterCallback = (id) => callbacks.delete(id);
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (_event, id) => {
      const listener = listeners.get(id);
      if (listener) callbacks.delete(listener.handler);
      listeners.delete(id);
    },
  };
  f.emitCard = (payload) => {
    for (const [id, listener] of listeners) {
      if (listener.event === "yggdrasil-card-drop")
        callbacks.get(listener.handler)?.({
          event: listener.event,
          id,
          payload,
        });
    }
  };
  let serial = 0;
  f.oauthWaiters = [];
  f.finishOAuth = (failure) => {
    for (const waiter of f.oauthWaiters.splice(0)) {
      if (failure) waiter.reject(new Error(failure));
      else
        waiter.resolve({
          sessionId: waiter.sessionId,
          server: "https://littleskin.cn/api/yggdrasil/",
          serverName: "LittleSkin",
          profiles: f.singleProfile
            ? [{ id: "single", name: "Solo" }]
            : [
                { id: "first", name: "Builder" },
                { id: "second", name: "Explorer" },
              ],
        });
    }
  };
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "plugin:event|listen") {
      const id = ++nextListener;
      listeners.set(id, args);
      return id;
    }
    if (command === "plugin:event|unlisten") return;
    if (command === "plugin:opener|open_url" && f.failBrowser) {
      f.requests.push({ operation: command, payload: args });
      throw new Error("Test browser open failure");
    }
    if (
      command !== "request" ||
      !args.operation.startsWith("players.yggdrasil.")
    )
      return original(command, args);
    const { operation, payload } = args;
    f.requests.push({ operation, payload });
    if (f.delays[operation])
      await new Promise((resolve) => setTimeout(resolve, f.delays[operation]));
    if (f.failures[operation]) throw new Error(f.failures[operation]);
    if (operation === "players.yggdrasil.oauth.begin") {
      return {
        sessionId: `oauth-${++serial}`,
        userCode: "ABCD-EFGH",
        verificationUri: "https://open.littleskin.cn/oauth/link",
        verificationUriComplete:
          "https://open.littleskin.cn/oauth/link?user_code=ABCD-EFGH",
        expiresIn: f.oauthExpires || 300,
      };
    }
    if (operation === "players.yggdrasil.oauth.wait")
      return new Promise((resolve, reject) =>
        f.oauthWaiters.push({ sessionId: payload.sessionId, resolve, reject }),
      );
    if (operation === "players.yggdrasil.login")
      return {
        sessionId: `session-${++serial}`,
        server: "https://skin.example/api/yggdrasil/",
        serverName: "测试皮肤站",
        profiles: f.singleProfile
          ? [{ id: "single", name: "Solo" }]
          : [
              { id: "first", name: "Builder" },
              { id: "second", name: "Explorer" },
            ],
      };
    if (operation === "players.yggdrasil.select") {
      const player = {
        uuid: `yggdrasil-${payload.profileId}`,
        name: payload.profileId === "single" ? "Solo" : "Explorer",
        online: true,
        skin: "",
        slim: false,
        yggdrasil: {
          server: "https://skin.example/api/yggdrasil/",
          serverName: "测试皮肤站",
          homepage: "https://skin.example/",
          profileId: payload.profileId,
        },
      };
      f.data.players.push(player);
      f.data.settings.activePlayer = player.uuid;
      return player;
    }
    return true;
  };
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const ui = page.locator(".players-page");
const form = ui.locator(".players-yggdrasil-content");
const enter = () => openPlayerLogin(page, "yggdrasil");
const enterAuthorization = () => openPlayerLogin(page, "yggdrasil-oauth");
const count = (operation) =>
  page.evaluate(
    (op) =>
      window.__pixelTest.requests.filter((r) => r.operation === op).length,
    operation,
  );
const submit = async (address = "https://skin.example/api/yggdrasil") => {
  await form.getByLabel("验证服务器地址", { exact: true }).fill(address);
  await form.getByLabel("站点账号", { exact: true }).fill("test@example.com");
  await form.getByLabel("密码", { exact: true }).fill("test-only-password");
  await form.getByRole("button", { name: "登录验证站点", exact: true }).click();
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page.locator(".sidebar .profile-button").click();
  await enter();
  await expect(ui).toHaveAttribute("data-login", "yggdrasil");
  await expect(form.getByRole("tab")).toHaveCount(0);
  await expect(
    ui.getByRole("heading", { name: "第三方账号登录", level: 1 }),
  ).toBeVisible();
  await expect(ui.locator(".players-login-actions")).toHaveCount(0);
  await expect(form.locator(".players-littleskin-form")).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "页面路径" }).locator("strong"),
  ).toHaveText("第三方账号登录");
  await expect(form.locator(".players-login-intro")).toHaveCount(0);
  await expect(
    form.getByText("填写站点提供的 API 地址，或支持自动发现的站点网址。", {
      exact: true,
    }),
  ).toHaveCount(0);
  const server = form.getByRole("combobox", {
    name: "验证服务器地址",
    exact: true,
  });
  const options = page.getByRole("listbox", {
    name: "预选验证服务",
    exact: true,
  });
  await form
    .getByRole("button", { name: "显示预选验证服务", exact: true })
    .click();
  await expect(options.getByRole("option")).toHaveCount(2);
  await expect(
    options.getByRole("option", { name: /LittleSkin/ }),
  ).toBeVisible();
  await options.getByRole("option", { name: /Blessing Skin/ }).click();
  await expect(server).toHaveValue("https://skin.prinzeugen.net/api/yggdrasil");
  await expect(options).toHaveCount(0);
  await server.click();
  await expect(options.getByRole("option")).toHaveCount(2);
  await server.fill("lItTlE");
  await expect(options.getByRole("option")).toHaveCount(1);
  await expect(options.getByRole("option")).toContainText("LittleSkin");
  await server.press("Enter");
  await expect(server).toHaveValue("https://littleskin.cn/api/yggdrasil");
  expect(await count("players.yggdrasil.login")).toBe(0);
  await server.fill("prinzeugen.net");
  await expect(
    options.getByRole("option", { name: /Blessing Skin/ }),
  ).toBeVisible();
  await server.press("Escape");
  await expect(server).toHaveValue("prinzeugen.net");
  await expect(options).toHaveCount(0);
  await server.fill("https://custom.example/auth");
  await expect(
    options.getByRole("option", { name: /使用自定义地址/ }),
  ).toBeVisible();
  await server.press("Enter");
  await expect(server).toHaveValue("https://custom.example/auth");
  await expect(options).toHaveCount(0);
  await server.fill("no matching service");
  await expect(options).toContainText("未找到预选服务");
  await server.press("Tab");
  await expect(server).toHaveValue("no matching service");
  await expect(options).toHaveCount(0);
  await server.fill("");
  await server.press("Escape");
  await server.press("ArrowUp");
  await server.press("Enter");
  await expect(server).toHaveValue("https://skin.prinzeugen.net/api/yggdrasil");
  await server.fill("");
  await server.press("Escape");
  console.log(
    "PASS removed descriptions; presets, name/address search, keyboard selection, Escape/Tab and custom addresses",
  );
  const popup = page.locator(".players-server-popup");
  const sampleMotion = (fraction) =>
    page.evaluate((fraction) => {
      const motion = window.__serverMotions.at(-1);
      const timing = motion.effect.getTiming();
      motion.currentTime = timing.duration * fraction;
      const style = getComputedStyle(motion.effect.target);
      return {
        duration: timing.duration,
        opacity: Number(style.opacity),
        clip: style.clipPath,
        transform: style.transform,
      };
    }, fraction);
  for (const reducedMotion of ["no-preference", "reduce"]) {
    await expect(popup).toHaveCount(0);
    await page.emulateMedia({ reducedMotion });
    await page.evaluate(() => (window.__holdServerMotion = true));
    await server.press("ArrowDown");
    const start = await sampleMotion(0);
    const middle = await sampleMotion(0.5);
    expect(start.duration).toBe(220);
    expect(start.opacity).toBe(0);
    expect(middle.opacity).toBeGreaterThan(0);
    expect(middle.opacity).toBeLessThan(1);
    expect(middle.clip).not.toBe(start.clip);
    expect(middle.transform).not.toBe(start.transform);
    const motions = await page.evaluate(() => window.__serverMotions.length);
    await server.fill("Little");
    await expect(options.getByRole("option")).toHaveCount(1);
    await server.fill("");
    expect(await page.evaluate(() => window.__serverMotions.length)).toBe(
      motions,
    );
    await server.press("Escape");
    const reverse = await sampleMotion(0);
    expect(reverse.duration).toBe(160);
    expect(reverse.opacity).toBeCloseTo(middle.opacity, 4);
    expect(reverse.clip).toBe(middle.clip);
    expect(reverse.transform).toBe(middle.transform);
    await expect(options).toHaveCount(0);
    await expect(popup).toHaveAttribute("inert", "");
    const closing = await sampleMotion(0.5);
    expect(closing.opacity).toBeLessThan(reverse.opacity);
    await server.press("ArrowDown");
    const reopened = await sampleMotion(0);
    expect(reopened.opacity).toBeCloseTo(closing.opacity, 4);
    expect(reopened.clip).toBe(closing.clip);
    expect(reopened.transform).toBe(closing.transform);
    await page.evaluate(() => window.__serverMotions.at(-1).finish());
    await expect(options).toBeVisible();
    await expect(server).toHaveCSS("border-image-width", "8px");
    await expect(
      form.locator(".players-server-toggle > .pixel-icon"),
    ).toHaveAttribute("shape-rendering", "crispEdges");
    for (const field of await form.locator("input.pixel-input").all())
      await expect(field).toHaveCSS("height", "32px");
    expect(
      (await options.getByRole("option").first().boundingBox()).height,
    ).toBeLessThanOrEqual(38);
    await server.press("Escape");
    expect((await sampleMotion(0)).opacity).toBe(1);
    expect((await sampleMotion(0.999)).opacity).toBeLessThan(0.01);
    await page.evaluate(() => {
      window.__serverMotions.at(-1).finish();
      window.__holdServerMotion = false;
    });
    await expect(popup).toHaveCount(0);
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
  console.log(
    "PASS shared pixel styling, compact sizing, full unfold/fold motion with either motion preference, smooth reversal, and filtering without restarting animation",
  );
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1100, height: 720 },
    { width: 900, height: 650 },
    { width: 375, height: 450 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(300);
    await expect(form.getByLabel("密码", { exact: true })).toHaveAttribute(
      "type",
      "password",
    );
    const overflow = await ui.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await server.click();
    await expect(options).toBeVisible();
    await popup.evaluate((el) =>
      Promise.allSettled(el.getAnimations().map((motion) => motion.finished)),
    );
    const menuBounds = await options.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: innerWidth,
        height: innerHeight,
      };
    });
    expect(menuBounds.left).toBeGreaterThanOrEqual(0);
    expect(menuBounds.top).toBeGreaterThanOrEqual(0);
    expect(menuBounds.right).toBeLessThanOrEqual(menuBounds.width);
    expect(menuBounds.bottom).toBeLessThanOrEqual(menuBounds.height);
    await page.screenshot({
      path: `${evidence}/server-options-${viewport.width}.png`,
    });
    await server.press("Escape");
    await expect(popup).toHaveCount(0);
    await form
      .getByRole("button", { name: "登录验证站点", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      form.getByRole("button", { name: "登录验证站点", exact: true }),
    ).toBeInViewport();
    await page.screenshot({ path: `${evidence}/form-${viewport.width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(
    () =>
      (window.__pixelTest.failures["players.yggdrasil.login"] =
        "验证失败：账号或密码错误"),
  );
  await submit("https://littleskin.cn/api/yggdrasil");
  expect(
    await page.evaluate(
      () =>
        window.__pixelTest.requests
          .filter((r) => r.operation === "players.yggdrasil.login")
          .at(-1).payload.server,
    ),
  ).toBe("https://littleskin.cn/api/yggdrasil");
  await expect(form.getByRole("alert")).toContainText("验证失败");
  await expect(form.getByLabel("密码", { exact: true })).toHaveValue("");
  await expect(form.getByLabel("站点账号", { exact: true })).toHaveValue(
    "test@example.com",
  );
  await page.evaluate(
    () => delete window.__pixelTest.failures["players.yggdrasil.login"],
  );
  await submit();
  expect(
    await page.evaluate(
      () =>
        window.__pixelTest.requests
          .filter((r) => r.operation === "players.yggdrasil.login")
          .at(-1).payload.server,
    ),
  ).toBe("https://skin.example/api/yggdrasil");
  await expect(
    form.getByRole("button", { name: "Explorer", exact: true }),
  ).toBeVisible();
  expect(await count("players.yggdrasil.select")).toBe(0);
  await page.screenshot({ path: `${evidence}/profiles.png` });
  await form.getByRole("button", { name: "Explorer", exact: true }).click();
  await expect(ui).not.toHaveAttribute("data-login");
  await expect(ui.locator(".players-identity-name h2")).toHaveText("Explorer");
  await expect(
    ui.getByRole("button", { name: "更换皮肤", exact: true }),
  ).toHaveCount(0);
  await expect(
    ui.getByRole("button", { name: "更改名称", exact: true }),
  ).toHaveCount(0);
  await ui.getByRole("button", { name: "打开验证站点", exact: true }).click();
  await expect.poll(() => count("plugin:opener|open_url")).toBe(1);
  await ui
    .getByRole("button", { name: "刷新 Explorer 登录", exact: true })
    .click();
  await expect.poll(() => count("players.refresh")).toBe(1);
  await page.screenshot({ path: `${evidence}/account.png` });
  console.log(
    "PASS form sizes, errors, password clearing, multiple profiles, site management and refresh",
  );

  await ui.locator(".players-view-switch").click();
  await enter();
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await page.waitForTimeout(400);
  await server.click();
  await expect(options).toBeVisible();
  await popup.evaluate((el) =>
    Promise.allSettled(el.getAnimations().map((motion) => motion.finished)),
  );
  await page.screenshot({ path: `${evidence}/server-options-dark.png` });
  await server.press("Escape");
  await expect(popup).toHaveCount(0);
  await page.screenshot({ path: `${evidence}/gallery-dark.png` });
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1120, height: 640 },
    { width: 1120, height: 420 },
    { width: 900, height: 650 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(300);
    const stage = ui.locator(".players-yggdrasil-stage");
    const geometry = await stage.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const icon = element.querySelector("svg").getBoundingClientRect();
      return {
        width: icon.width,
        height: icon.height,
        overflow: Math.max(
          ...Array.from(element.children)
            .filter((child) => child.getClientRects().length)
            .flatMap((child) => {
              const rect = child.getBoundingClientRect();
              return [
                bounds.top - rect.top,
                rect.bottom - bounds.bottom,
                bounds.left - rect.left,
                rect.right - bounds.right,
              ];
            }),
        ),
      };
    });
    expect(geometry.width).toBeGreaterThan(0);
    expect(geometry.width).toBeCloseTo(geometry.height, 3);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log(
    "PASS landscape third-party preview keeps a complete, proportionate globe and unclipped labels in short windows",
  );
  expect(
    await ui.evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page.evaluate(() => (window.__pixelTest.singleProfile = true));
  await submit();
  await expect(ui).not.toHaveAttribute("data-login");
  await expect(ui.locator(".players-identity-name h2")).toHaveText("Solo");
  console.log("PASS single-profile login saves automatically");

  await enter();
  await page.evaluate(() => {
    window.__pixelTest.singleProfile = false;
    window.__pixelTest.delays["players.yggdrasil.login"] = 500;
  });
  const selects = await count("players.yggdrasil.select");
  await submit();
  await openPlayerLogin(page, "offline");
  await expect.poll(() => count("players.yggdrasil.cancel")).toBeGreaterThan(0);
  expect(await count("players.yggdrasil.select")).toBe(selects);
  await expect(ui).toHaveAttribute("data-login", "offline");
  console.log(
    "PASS leaving during authentication discards late sessions without saving or redirecting",
  );
  await enter();
  if (oauthEnabled) {
    await enterAuthorization();
    const startOAuth = () =>
      form
        .getByRole("button", { name: /(?:使用|重新授权) LittleSkin/ })
        .click();
    await expect(ui).toHaveAttribute("data-login", "yggdrasil-oauth");
    await expect(
      ui.getByRole("heading", { name: "第三方授权登录", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "页面路径" }).locator("strong"),
    ).toHaveText("第三方授权登录");
    await expect(ui.locator("#players-collection-title")).toHaveText(
      "第三方授权登录",
    );
    await expect(ui.locator(".players-login-actions")).toHaveCount(0);
    await expect(form.getByRole("tab")).toHaveCount(0);
    await expect(form.getByLabel("站点账号", { exact: true })).toHaveCount(0);
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await expect(
      page.getByLabel("LittleSkin Client ID", { exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => window.__pixelTest.data.settings),
    ).not.toHaveProperty("littleskinClientId");
    await page.locator(".sidebar .profile-button").click();
    await enter();
    await enterAuthorization();
    await page.evaluate(() => (window.__pixelTest.failBrowser = true));
    await startOAuth();
    await expect(
      form.getByRole("button", { name: "复制授权码 ABCD-EFGH" }),
    ).toBeVisible();
    await expect(form.getByRole("alert")).toContainText("复制授权链接");
    await page.evaluate(() => (window.__pixelTest.failBrowser = false));
    await form
      .getByRole("button", { name: "打开授权页面", exact: true })
      .click();
    expect(
      await page.evaluate(
        () =>
          window.__pixelTest.requests
            .filter((r) => r.operation === "plugin:opener|open_url")
            .at(-1).payload.url,
      ),
    ).toContain("user_code=ABCD-EFGH");
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 375, height: 600 },
    ]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(250);
      expect(
        await ui.evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
      await form
        .getByRole("button", { name: "取消授权", exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${evidence}/oauth-${viewport.width}.png`,
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const beforeOAuth = await count("players.yggdrasil.select");
    await page.evaluate(() => window.__pixelTest.finishOAuth());
    await expect(
      form.getByRole("button", { name: "Explorer", exact: true }),
    ).toBeVisible();
    expect(await count("players.yggdrasil.select")).toBe(beforeOAuth);
    await form.getByRole("button", { name: "Explorer", exact: true }).click();
    await expect(ui).not.toHaveAttribute("data-login");
    console.log(
      "PASS OAuth login without a Client ID field, browser fallback, responsive authorization code and profile selection",
    );

    await enter();
    await enterAuthorization();
    await startOAuth();
    await expect(
      form.getByRole("button", { name: "取消授权", exact: true }),
    ).toBeVisible();
    await page.evaluate(() =>
      window.__pixelTest.finishOAuth("你已拒绝 LittleSkin 授权"),
    );
    await expect(form.getByRole("alert")).toContainText("拒绝");
    await startOAuth();
    await expect(
      form.getByRole("button", { name: "复制授权码 ABCD-EFGH" }),
    ).toBeVisible();
    const beforeCancel = await count("players.yggdrasil.cancel");
    await form.getByRole("button", { name: "取消授权", exact: true }).click();
    await expect
      .poll(() => count("players.yggdrasil.cancel"))
      .toBeGreaterThan(beforeCancel);
    const beforeStale = await count("players.yggdrasil.select");
    await page.evaluate(() => window.__pixelTest.finishOAuth());
    await expect(
      form.getByRole("button", {
        name: "使用 LittleSkin 授权登录",
        exact: true,
      }),
    ).toBeVisible();
    expect(await count("players.yggdrasil.select")).toBe(beforeStale);
    await page.evaluate(() => (window.__pixelTest.oauthExpires = 1));
    await startOAuth();
    await expect(form.getByRole("alert")).toContainText("过期");
    await page.evaluate(() => {
      window.__pixelTest.finishOAuth();
      window.__pixelTest.oauthExpires = 300;
    });
    await startOAuth();
    await expect(
      form.getByRole("button", { name: "复制授权码 ABCD-EFGH" }),
    ).toBeVisible();
    await enter();
    await page.evaluate(() => window.__pixelTest.finishOAuth());
    await expect(server).toBeVisible();
    await expect(form.getByLabel("站点账号", { exact: true })).toHaveValue("");
    expect(await count("players.yggdrasil.select")).toBe(beforeStale);
    await enterAuthorization();
    await page.evaluate(
      () => (window.__pixelTest.delays["players.yggdrasil.oauth.begin"] = 500),
    );
    const waitsBefore = await count("players.yggdrasil.oauth.wait");
    const beginsBefore = await count("players.yggdrasil.oauth.begin");
    await startOAuth();
    await expect
      .poll(() => count("players.yggdrasil.oauth.begin"))
      .toBeGreaterThan(beginsBefore);
    await openPlayerLogin(page, "offline");
    await page.waitForTimeout(600);
    expect(await count("players.yggdrasil.oauth.wait")).toBe(waitsBefore);
    await expect(ui).toHaveAttribute("data-login", "offline");
    await page.evaluate(() => {
      delete window.__pixelTest.delays["players.yggdrasil.oauth.begin"];
      window.__pixelTest.singleProfile = true;
    });
    await enter();
    await enterAuthorization();
    await startOAuth();
    await expect(
      form.getByRole("button", { name: "复制授权码 ABCD-EFGH" }),
    ).toBeVisible();
    await page.evaluate(() => window.__pixelTest.finishOAuth());
    await expect(ui).not.toHaveAttribute("data-login");
    await expect(ui.locator(".players-identity-name h2")).toHaveText("Solo");
    console.log(
      "PASS OAuth denial/retry, expiry, cancellation, mode/page changes, late results and automatic single-profile login",
    );
  } else {
    await page.getByRole("button", { name: "返回上一级", exact: true }).click();
    await ui.getByRole("button", { name: "登录", exact: true }).click();
    await expect(
      page.locator('[role="menuitem"][data-menu-id="yggdrasil-oauth"]'),
    ).toHaveCount(0);
    await expect(ui).not.toHaveAttribute("data-login");
    expect(await count("players.yggdrasil.oauth.begin")).toBe(0);
    expect(await count("players.yggdrasil.oauth.wait")).toBe(0);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("menu", { name: "登录方式", exact: true }),
    ).toHaveCount(0);
    console.log(
      "PASS pending OAuth entry is hidden without starting authorization",
    );
  }

  await enter();
  await expect(form.getByRole("tab")).toHaveCount(0);
  await expect(form.getByRole("tab", { name: "拖拽登录" })).toHaveCount(0);
  const card = (server) =>
    `authlib-injector:yggdrasil-server:${encodeURIComponent(server)}`;
  const drag = (type, text, mime = "text/plain") =>
    page.evaluate(
      ({ type, text, mime }) => {
        const dataTransfer = new DataTransfer();
        dataTransfer.setData(mime, text);
        document.body.dispatchEvent(
          new DragEvent(type, {
            dataTransfer,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      { type, text, mime },
    );
  const overlay = page.locator(".yggdrasil-drop-overlay");
  const importedAddress = form.locator(".players-imported-address");
  const breadcrumb = page
    .getByRole("navigation", { name: "页面路径" })
    .locator("strong");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "开始游戏", exact: true })
    .click();
  await drag("dragenter", card("https://skin.example/api/yggdrasil"));
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveClass("drop-overlay yggdrasil-drop-overlay");
  await expect(overlay.locator(".modpack-drop-frame")).toBeVisible();
  await expect(overlay).toContainText("松开以登录验证站点");
  await expect(overlay).toHaveCSS("opacity", "0.75");
  await expect(page.locator(".modpack-drop-overlay")).toHaveCount(0);
  await page.screenshot({ path: `${evidence}/card-drop-placeholder.png` });
  await drag("dragleave", "");
  await expect(overlay).toHaveCount(0);
  const homeUrl = page.url();
  await drag("drop", "https://example.com/ordinary-link", "text/uri-list");
  expect(page.url()).toBe(homeUrl);
  // Hold the exit animation to prove navigation waits for the placeholder.
  await drag("dragenter", card("https://skin.example/api/yggdrasil"));
  await expect(overlay).toHaveCSS("opacity", "0.75");
  await page.evaluate(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const motion = animate.apply(this, args);
      if (args[1]?.id === "sfmcl-t-yggdrasil-drop-exit") {
        motion.pause();
        window.__dropExit = motion;
      }
      return motion;
    };
    window.__restoreDropAnimation = () => {
      Element.prototype.animate = animate;
    };
  });
  await drag("drop", card("https://skin.example/api/yggdrasil"));
  await expect(overlay).toHaveAttribute("data-exiting", "true");
  await expect(page.locator(".players-yggdrasil-import")).toHaveCount(0);
  await page.evaluate(() => {
    window.__dropExit.finish();
    window.__restoreDropAnimation();
  });
  await expect(overlay).toHaveCount(0);
  await expect(ui).toHaveAttribute("data-login", "yggdrasil");
  await expect(breadcrumb).toHaveText("外置登录");
  await expect(
    ui.getByRole("heading", { name: "外置登录", level: 1 }),
  ).toBeVisible();
  await expect(form.getByRole("tab")).toHaveCount(0);
  await expect(server).toHaveCount(0);
  await expect(importedAddress).toHaveText(
    "https://skin.example/api/yggdrasil",
  );
  await expect(
    form.getByRole("heading", { name: "登录 skin.example" }),
  ).toBeVisible();
  await form.getByLabel("站点账号", { exact: true }).fill("old-account");
  await form.getByLabel("密码", { exact: true }).fill("old-password");
  await drag(
    "drop",
    `# card\r\n${card("https://other.example/api/yggdrasil")}`,
    "text/uri-list",
  );
  await expect(importedAddress).toHaveText(
    "https://other.example/api/yggdrasil",
  );
  await expect(form.getByLabel("站点账号", { exact: true })).toHaveValue("");
  await expect(form.getByLabel("密码", { exact: true })).toHaveValue("");
  const loginCount = await count("players.yggdrasil.login");
  await drag("drop", card("https://user:secret@invalid.example/api"));
  await expect(page.locator(".notification-deck")).toContainText(
    "服务器地址无效",
  );
  await expect(importedAddress).toHaveText(
    "https://other.example/api/yggdrasil",
  );
  expect(await count("players.yggdrasil.login")).toBe(loginCount);
  console.log(
    "PASS shared placeholder layout, exit-before-navigation, dedicated imported login without tabs/server chooser, invalid links and credential reset",
  );

  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 720 });
      await page.waitForTimeout(350);
      await expect(importedAddress).toBeVisible();
      await form
        .getByRole("button", { name: "登录验证站点", exact: true })
        .scrollIntoViewIfNeeded();
      await expect(
        form.getByRole("button", { name: "登录验证站点", exact: true }),
      ).toBeInViewport();
      expect(
        await ui.evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
      await page.screenshot({
        path: `${evidence}/imported-${theme}-${width}.png`,
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await form.getByLabel("站点账号", { exact: true }).fill("test@example.com");
  await form.getByLabel("密码", { exact: true }).fill("test-only-password");
  await page.evaluate(() => {
    delete window.__pixelTest.delays["players.yggdrasil.login"];
    window.__pixelTest.singleProfile = true;
  });
  await form.getByRole("button", { name: "登录验证站点", exact: true }).click();
  await expect(ui).not.toHaveAttribute("data-login");
  const lastLogin = await page.evaluate(() =>
    window.__pixelTest.requests
      .filter((r) => r.operation === "players.yggdrasil.login")
      .at(-1),
  );
  expect(lastLogin.payload.server).toBe("https://other.example/api/yggdrasil");
  console.log(
    "PASS imported server is used for password authentication; light/dark and compact layouts",
  );

  await page.evaluate(() => {
    window.__pixelTest.singleProfile = false;
  });
  const oauthBeforeDrop = await count("players.yggdrasil.oauth.begin");
  await drag("drop", card("https://littleskin.cn/api/yggdrasil"));
  if (oauthEnabled) {
    await expect(
      form.getByRole("button", { name: "复制授权码 ABCD-EFGH" }),
    ).toBeVisible();
    await expect(
      form.getByRole("heading", { name: "登录 LittleSkin" }),
    ).toBeVisible();
    await expect(form.getByRole("tab")).toHaveCount(0);
    await expect(form.getByLabel("站点账号", { exact: true })).toHaveCount(0);
    expect(await count("players.yggdrasil.oauth.begin")).toBe(
      oauthBeforeDrop + 1,
    );
    await page.screenshot({ path: `${evidence}/imported-littleskin.png` });
    await drag("drop", card("https://littleskin.cn/api/yggdrasil"));
    expect(await count("players.yggdrasil.oauth.begin")).toBe(
      oauthBeforeDrop + 1,
    );
    await page.evaluate(() => window.__pixelTest.finishOAuth());
    await expect(
      form.getByRole("button", { name: "Explorer", exact: true }),
    ).toBeVisible();
    await form.getByRole("button", { name: "Explorer", exact: true }).click();
    await expect(ui).not.toHaveAttribute("data-login");
    console.log(
      "PASS imported LittleSkin authorization page, duplicate-drop guard and profile selection",
    );
  } else {
    await expect(
      form.getByRole("heading", { name: "登录 LittleSkin" }),
    ).toBeVisible();
    await expect(form.getByLabel("站点账号", { exact: true })).toBeVisible();
    await expect(form.getByLabel("密码", { exact: true })).toBeVisible();
    await expect(form.locator(".players-authorization-note")).toContainText(
      "浏览器授权暂未开放",
    );
    await drag("drop", card("https://littleskin.cn/api/yggdrasil"));
    expect(await count("players.yggdrasil.oauth.begin")).toBe(oauthBeforeDrop);
    await page.screenshot({ path: `${evidence}/imported-littleskin.png` });
    await form.getByLabel("站点账号", { exact: true }).fill("test@example.com");
    await form.getByLabel("密码", { exact: true }).fill("test-only-password");
    await form
      .getByRole("button", { name: "登录验证站点", exact: true })
      .click();
    await expect(
      form.getByRole("button", { name: "Explorer", exact: true }),
    ).toBeVisible();
    await form.getByRole("button", { name: "Explorer", exact: true }).click();
    await expect(ui).not.toHaveAttribute("data-login");
    console.log(
      "PASS imported LittleSkin uses password login while authorization is pending; duplicate drop starts no OAuth",
    );
  }

  await page.evaluate(() => window.__pixelTest.emitCard({ phase: "enter" }));
  await expect(overlay).toBeVisible();
  await page.evaluate(() => window.__pixelTest.emitCard({ phase: "leave" }));
  await expect(overlay).toHaveCount(0);
  await page.evaluate(
    (text) => window.__pixelTest.emitCard({ phase: "drop", text }),
    card("https://native.example/api"),
  );
  await expect(importedAddress).toHaveText("https://native.example/api");
  await expect(breadcrumb).toHaveText("外置登录");
  await page.getByRole("button", { name: "返回上一级", exact: true }).click();
  await expect(ui).not.toHaveAttribute("data-login");
  await enter();
  await expect(breadcrumb).toHaveText("第三方账号登录");
  await expect(form.getByRole("tab")).toHaveCount(0);
  await expect(server).toHaveValue("");
  const beforeNativeOAuth = await count("players.yggdrasil.oauth.begin");
  await page.evaluate(
    (text) => window.__pixelTest.emitCard({ phase: "drop", text }),
    card("https://littleskin.cn/api/yggdrasil"),
  );
  if (oauthEnabled) {
    await expect(
      form.getByRole("button", { name: "复制授权码 ABCD-EFGH" }),
    ).toBeVisible();
    expect(await count("players.yggdrasil.oauth.begin")).toBe(
      beforeNativeOAuth + 1,
    );
    const cancellations = await count("players.yggdrasil.cancel");
    await page.getByRole("button", { name: "返回上一级", exact: true }).click();
    await expect
      .poll(() => count("players.yggdrasil.cancel"))
      .toBeGreaterThan(cancellations);
    await page.evaluate(() => window.__pixelTest.finishOAuth());
    await expect(ui).not.toHaveAttribute("data-login");
    console.log(
      "PASS native event bridge, imported child back navigation, manual login remains separate and leaving cancels authorization",
    );
  } else {
    await expect(form.getByLabel("站点账号", { exact: true })).toBeVisible();
    await expect(form.getByLabel("密码", { exact: true })).toBeVisible();
    expect(await count("players.yggdrasil.oauth.begin")).toBe(
      beforeNativeOAuth,
    );
    await page.getByRole("button", { name: "返回上一级", exact: true }).click();
    await expect(ui).not.toHaveAttribute("data-login");
    console.log(
      "PASS native LittleSkin cards use password login without starting OAuth",
    );
  }
  expect(errors).toEqual([]);
} finally {
  await browser.close();
}
