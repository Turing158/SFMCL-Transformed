import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { runtimePath } from "./lib/paths.mjs";
import { loginMethods } from "./lib/player-login.mjs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { playersFixture } from "./fixtures/players.mjs";
import { launchDockFixture } from "./fixtures/launch-dock.mjs";
import { favoriteContextFixture } from "./fixtures/favorite-context-menu.mjs";

const evidence = runtimePath("player-login-menu");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript({
  content: `(${pixelAppFixture.toString()})(); (${launchDockFixture.toString()})(); (${favoriteContextFixture.toString()})(); (${playersFixture.toString()})();`,
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const ui = page.locator(".players-page");
const trigger = ui.getByRole("button", { name: "登录", exact: true });
const menu = page.getByRole("menu", { name: "登录方式", exact: true });
const favoriteMenu = page.getByRole("menu", { name: / 的版本操作$/ });
const comparisons = [];
const oauthEnabled = process.env.VITE_SFMCL_T_THIRD_PARTY_OAUTH === "true";
const menuLabels = Object.entries(loginMethods)
  .filter(([kind]) => kind !== "yggdrasil-oauth" || oauthEnabled)
  .map(([, label]) => label);
const enabledItems = menu.locator('[role="menuitem"]:not(:disabled)');
const expectPlayingMotion = async (panel, name, duration) => {
  const frames = await panel.evaluate(async (el, name) => {
    const animation = el
      .getAnimations()
      .find((entry) => entry.animationName === name);
    if (!animation) return null;
    await animation.ready;
    const read = () => {
      const style = getComputedStyle(el);
      return {
        time: animation.currentTime,
        state: animation.playState,
        opacity: style.opacity,
        transform: style.transform,
      };
    };
    const first = read();
    const duration = Number(animation.effect.getTiming().duration);
    const sampleTime = Math.min(Number(first.time) + duration / 2, duration);
    do {
      await new Promise(requestAnimationFrame);
    } while (
      animation.playState === "running" &&
      Number(animation.currentTime) < sampleTime
    );
    return {
      first,
      last: read(),
      duration,
    };
  }, name);
  expect(frames).not.toBeNull();
  expect(frames.duration).toBe(duration);
  expect(frames.first.state).toBe("running");
  expect(frames.last.time).toBeGreaterThan(frames.first.time);
  expect([frames.last.opacity, frames.last.transform]).not.toEqual([
    frames.first.opacity,
    frames.first.transform,
  ]);
};
const signature = (panel, animationOnly = false) =>
  panel.evaluate((el, animationOnly) => {
    const properties = [
      "min-width",
      "min-height",
      "padding",
      "margin",
      "gap",
      "font-family",
      "font-size",
      "font-weight",
      "line-height",
      "color",
      "background-color",
      "border",
      "border-radius",
      "clip-path",
      "filter",
      "rotate",
      "scale",
      "pointer-events",
      "animation-name",
      "animation-duration",
      "animation-delay",
      "animation-timing-function",
      "animation-fill-mode",
      "transition",
    ];
    const read = (node, pseudo) => {
      const style = getComputedStyle(node, pseudo);
      return Object.fromEntries(
        properties.map((key) => [key, style.getPropertyValue(key)]),
      );
    };
    const result = {
      panel: read(el),
      transformOrigin: getComputedStyle(el).transformOrigin,
      animations: el.getAnimations().map((animation) => ({
        name: animation.animationName,
        timing: animation.effect.getTiming(),
        keyframes: animation.effect.getKeyframes(),
      })),
    };
    if (animationOnly) return result;
    const row = el.querySelectorAll('[role="menuitem"]')[1];
    return {
      ...result,
      frame: read(el.querySelector(".pixel-context-frame")),
      face: read(el.querySelector(".pixel-context-face")),
      row: read(row),
      highlight: read(row, "::before"),
      icon: read(row.querySelector(".pixel-context-icon")),
      rowAnimations: row.getAnimations().map((animation) => ({
        name: animation.animationName,
        timing: animation.effect.getTiming(),
        keyframes: animation.effect.getKeyframes(),
      })),
    };
  }, animationOnly);
const workspaceLayout = () =>
  ui.locator(".players-workspace").evaluate((el) => ({
    x: el.offsetLeft,
    y: el.offsetTop,
    width: el.offsetWidth,
    height: el.offsetHeight,
  }));
const back = () =>
  page
    .getByRole("navigation", { name: "页面路径" })
    .getByRole("button", { name: "返回上一级", exact: true })
    .click();

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page.locator(".sidebar .profile-button").click();
  await expect(ui.locator(".players-heading button")).toHaveCount(1);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toHaveCount(0);
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem")).toHaveText(menuLabels);
  if (!oauthEnabled) {
    await expect(menu.locator('[data-menu-id="yggdrasil-oauth"]')).toHaveCount(
      0,
    );
    await expect(ui).not.toHaveAttribute("data-login");
    await expect(menu).toBeVisible();
  }
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  expect(await trigger.getAttribute("aria-controls")).toBe(
    await menu.getAttribute("id"),
  );
  await page.keyboard.press("End");
  await expect(enabledItems.last()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(enabledItems.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await trigger.click({ delay: 120 });
  const positions = await menu.evaluate(async (el) => {
    const positions = [];
    for (let frame = 0; frame < 12; frame++) {
      window.dispatchEvent(new Event("resize"));
      positions.push(`${el.style.left},${el.style.top}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return positions;
  });
  expect(new Set(positions).size).toBe(1);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  console.log(
    "PASS menu position stays fixed while the login button rebounds and viewport positioning refreshes",
  );

  await trigger.click();
  await trigger.click();
  await expect(menu).toHaveCSS("animation-name", "context-menu-out");
  await expect(menu).toHaveCSS("animation-duration", "0.16s");
  await expect(menu).toHaveCount(0);
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCSS("animation-name", "context-menu-out");
  await expect(menu).toHaveCount(0);
  await trigger.click();
  await ui.getByRole("heading", { name: "角色管理", level: 1 }).click();
  await expect(menu).toHaveCount(0);
  await trigger.click();
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  await expect(trigger).not.toBeFocused();
  console.log(
    `PASS single login trigger, ${menuLabels.length} menu choices, keyboard navigation, toggle, Escape, Tab and outside dismissal`,
  );

  for (const [kind, label] of Object.entries(loginMethods)) {
    if (kind === "yggdrasil-oauth" && !oauthEnabled) continue;
    await trigger.click();
    const item = menu.getByRole("menuitem", { name: label, exact: true });
    if (kind === "offline") {
      await item.focus();
      await page.keyboard.press("Enter");
    } else await item.click();
    await expect(ui).toHaveAttribute("data-login", kind);
    await expect(
      ui.getByRole("heading", { name: label, level: 1 }),
    ).toBeVisible();
    await expect(ui.locator(".players-login-actions")).toHaveCount(0);
    await expect(menu).toHaveCount(0);
    await back();
    await expect(ui).not.toHaveAttribute("data-login");
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  }
  console.log(
    "PASS available login routes hide the menu and trigger; returning restores focus to Login",
  );

  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const snapshots = [];
    for (const panel of [favoriteMenu, menu]) {
      if (panel === favoriteMenu) {
        await page
          .locator(
            '.sidebar-favorite[data-directory="C:/Pixel-Test/Minecraft"]',
          )
          .first()
          .click({ button: "right" });
      } else {
        await trigger.click();
      }
      await expect(panel).toBeVisible();
      await panel.evaluate((el) =>
        el
          .getAnimations({ subtree: true })
          .forEach((animation) => animation.finish()),
      );
      const opening = await signature(panel);
      const positionBeforeHover = await panel.boundingBox();
      if (panel === menu && theme === "light") {
        const button = await trigger.boundingBox();
        const popup = await panel.boundingBox();
        const left = Math.min(button.x, popup.x) - 8;
        const top = Math.min(button.y, popup.y) - 8;
        await page.screenshot({
          path: `${evidence}/login-button-menu.png`,
          clip: {
            x: left,
            y: top,
            width:
              Math.max(button.x + button.width, popup.x + popup.width) -
              left +
              8,
            height:
              Math.max(button.y + button.height, popup.y + popup.height) -
              top +
              8,
          },
        });
      }
      await panel.getByRole("menuitem").nth(1).hover();
      await expect(
        panel.getByRole("menuitem").nth(1).locator(".pixel-context-icon"),
      ).toHaveCSS("scale", "1.1");
      const hover = await signature(panel);
      const positionAfterHover = await panel.boundingBox();
      expect(positionAfterHover.x).toBe(positionBeforeHover.x);
      expect(positionAfterHover.y).toBe(positionBeforeHover.y);
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCSS("animation-name", "context-menu-out");
      const closing = await signature(panel, true);
      await expect(panel).toHaveCount(0);
      snapshots.push({ opening, hover, closing });
    }
    expect(snapshots[1]).toEqual(snapshots[0]);
    comparisons.push({ theme, ...snapshots[0] });
    for (const width of [1440, 1024, 768, 375]) {
      await page.setViewportSize({ width, height: width === 375 ? 450 : 900 });
      await page.evaluate(() => document.fonts.ready);
      // Navigation and the responsive sidebar can both move the workspace.
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document
                .getAnimations()
                .filter(
                  (animation) =>
                    animation.effect?.getTiming().iterations !== Infinity &&
                    animation.playState !== "finished",
                ).length,
          ),
        )
        .toBe(0);
      await expect(trigger).toBeInViewport();
      const before = await workspaceLayout();
      await trigger.click();
      await expect
        .poll(async () => {
          const button = await trigger.boundingBox();
          const panel = await menu.boundingBox();
          return Math.max(
            Math.abs(panel.y - button.y - button.height - 8),
            Math.abs(panel.x + panel.width - button.x - button.width),
          );
        })
        .toBeLessThanOrEqual(1);
      expect(await workspaceLayout()).toEqual(before);
      for (const item of await menu.getByRole("menuitem").all())
        await expect(item).toBeInViewport({ ratio: 1 });
      expect(
        await menu.evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
      await page.screenshot({ path: `${evidence}/${theme}-${width}.png` });
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    }
  }
  await writeFile(
    `${evidence}/menu-parity.json`,
    JSON.stringify(comparisons, null, 2),
  );
  console.log(
    "PASS login and favorite menus have identical frame, row, hover styles and opening/closing animation keyframes in both themes; pointer and keyboard toggles retain the closing animation",
  );
  await trigger.click();
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect
    .poll(async () => {
      const button = await trigger.boundingBox();
      const panel = await menu.boundingBox();
      return Math.abs(panel.x + panel.width - button.x - button.width);
    })
    .toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const panel of [favoriteMenu, menu]) {
    if (panel === favoriteMenu)
      await page
        .locator('.sidebar-favorite[data-directory="C:/Pixel-Test/Minecraft"]')
        .first()
        .click({ button: "right" });
    else await trigger.click();
    await expectPlayingMotion(panel, "context-menu-in", 220);
    await expect(panel.getByRole("menuitem").first()).toHaveCSS(
      "animation-duration",
      "0.18s",
    );
    await page.keyboard.press("Escape");
    await expectPlayingMotion(panel, "context-menu-out", 160);
    await expect(panel).toHaveCount(0);
  }
  await expect(trigger.locator(".players-login-chevron")).toHaveCSS(
    "transition-duration",
    "0.18s",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  console.log(
    "PASS anchored overlay stays in bounds and follows resizing; both menus visibly play full opening/closing motion and the login arrow retains its transition even when the system requests reduced motion",
  );

  await trigger.click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await expect(menu).toHaveCount(0);
  await page.locator(".sidebar .profile-button").click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(
    "PASS navigation closes the menu without reopening it on return; no browser errors",
  );
  if (!oauthEnabled) {
    // Start on a retained authorization route to verify its fallback UI too.
    await page.route("**/src/navigation.ts*", async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      const body = source
        .replace(
          'route: { page: "home" }',
          'route: { page: "players", login: "yggdrasil-oauth" }',
        )
        .replace(
          'pages: { home: { page: "home" } }',
          'pages: { players: { page: "players", login: "yggdrasil-oauth" } }',
        );
      expect(body).not.toBe(source);
      await route.fulfill({ response, body });
    });
    await page.reload();
    await expect(ui).toHaveAttribute("data-login", "yggdrasil-oauth");
    const unavailable = ui.locator(".players-authorization-unavailable");
    await expect(unavailable.getByRole("heading")).toHaveText(
      "第三方授权登录暂未开放",
    );
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (value) => (document.documentElement.dataset.theme = value),
        theme,
      );
      for (const width of [1440, 1024, 768, 375]) {
        await page.setViewportSize({ width, height: 720 });
        const alternative = unavailable.getByRole("button", {
          name: "使用第三方账号登录",
          exact: true,
        });
        await alternative.scrollIntoViewIfNeeded();
        await expect(alternative).toBeInViewport();
        expect(
          await ui.evaluate((el) => el.scrollWidth - el.clientWidth),
        ).toBeLessThanOrEqual(1);
        await page.screenshot({
          path: `${evidence}/unavailable-${theme}-${width}.png`,
        });
      }
    }
    expect(
      await page.evaluate(() =>
        window.__pixelTest.requests.filter(
          (entry) =>
            entry.operation.startsWith("players.yggdrasil.oauth.") ||
            entry.operation === "plugin:opener|open_url",
        ),
      ),
    ).toEqual([]);
    await unavailable
      .getByRole("button", { name: "使用第三方账号登录", exact: true })
      .click();
    await expect(ui).toHaveAttribute("data-login", "yggdrasil");
    await expect(ui.getByLabel("站点账号", { exact: true })).toBeVisible();
    await expect(ui.getByLabel("密码", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    console.log(
      "PASS retained authorization route shows a responsive fallback in both themes; no OAuth or browser request, and password login remains reachable",
    );
  }
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
