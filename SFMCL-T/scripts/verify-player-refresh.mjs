import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { playersFixture } from "./fixtures/players.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("players-implementation/refresh");
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
await page.addInitScript({
  content: `(${pixelAppFixture.toString()})(); (${playersFixture.toString()})();
    window.__pixelTest.data.players[2].online = true;`,
});
const ui = page.locator(".players-page");
const refresh = ui.getByRole("button", { name: "刷新 Alex 登录", exact: true });
const otherRefresh = ui.getByRole("button", {
  name: "刷新 Builder_07 登录",
  exact: true,
});
const nav = page.getByRole("navigation", { name: "主导航" });
const count = () =>
  page.evaluate(
    () =>
      window.__pixelTest.requests.filter(
        (request) => request.operation === "players.refresh",
      ).length,
  );
const check = (message) => {
  checks.push(message);
  console.log(`PASS ${message}`);
};
const go = async () => {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page.locator(".sidebar .profile-button").click();
  await expect(ui.locator(".players-identity h2")).toHaveText("Steve");
};

try {
  for (const [view, theme] of [
    ["grove", "light"],
    ["gallery", "dark"],
  ]) {
    await go();
    if ((await ui.getAttribute("data-view")) !== view)
      await ui.locator(".players-view-switch").click();
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-player-view-transition",
    );
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      window.__pixelTest.delays["players.refresh"] = 1700;
    }, theme);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const card = ui.locator(".players-card").filter({
      has: page.getByRole("button", { name: "刷新 Alex 登录", exact: true }),
    });
    const before = await card.boundingBox();
    await refresh.click();
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await expect(refresh).toBeDisabled();
    await expect(refresh).toHaveAttribute("data-tooltip", "正在刷新登录…");
    await expect(otherRefresh).toHaveAttribute("aria-busy", "false");
    await expect(otherRefresh.locator(".spin")).toHaveCount(0);
    await expect(ui.locator(".players-identity h2")).toHaveText("Steve");
    await refresh.evaluate((button) => {
      button.click();
      button.click();
    });
    expect(await count()).toBe(1);
    const frames = await refresh.locator("svg").evaluate(async (icon) => {
      const animation = icon
        .getAnimations()
        .find((item) => item.animationName === "spin");
      if (!animation) throw new Error("Refresh rotation is missing");
      animation.pause();
      animation.currentTime = 250;
      const first = getComputedStyle(icon).transform;
      animation.currentTime = 650;
      const second = getComputedStyle(icon).transform;
      animation.currentTime = 1050;
      await new Promise(requestAnimationFrame);
      const stillBusy = icon.closest("button").getAttribute("aria-busy");
      animation.play();
      return { first, second, stillBusy };
    });
    expect(frames.first).not.toBe(frames.second);
    expect(frames.stillBusy).toBe("true");
    const after = await card.boundingBox();
    for (const property of ["x", "y", "width", "height"])
      expect(after[property]).toBeCloseTo(before[property], 1);
    await card.screenshot({
      path: `${evidence}/${view}-${theme}-refreshing.png`,
    });
    await expect(refresh).toBeEnabled();
    await expect(refresh).toHaveAttribute("aria-busy", "false");
    await expect(refresh.locator(".spin")).toHaveCount(0);
    await expect(
      page.getByText("登录已刷新", { exact: true }).first(),
    ).toBeVisible();
    check(
      `${view}/${theme}: only the requested account rotates, long requests keep spinning, repeated clicks do not resubmit, and layout stays fixed`,
    );
  }

  await page.evaluate(() => {
    window.__pixelTest.delays["players.refresh"] = 0;
    window.__pixelTest.failures["players.refresh"] = "刷新登录失败，请重试";
  });
  await refresh.click();
  await expect(
    page.getByText("Error: 刷新登录失败，请重试", { exact: true }).first(),
  ).toBeVisible();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect(refresh).toBeEnabled();
  await expect(refresh.locator(".spin")).toHaveCount(0);
  await page.evaluate(() => {
    delete window.__pixelTest.failures["players.refresh"];
  });
  const beforeRetry = await count();
  await refresh.click();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect.poll(count).toBe(beforeRetry + 1);
  await expect(refresh).toBeEnabled();
  await expect(refresh).toHaveAttribute("data-tooltip", "刷新登录");
  check(
    "Fast failure still animates a full turn, restores the button, and can be retried successfully",
  );

  await page.evaluate(() => {
    window.__pixelTest.delays["players.refresh"] = 1200;
  });
  await refresh.click();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await nav.getByRole("button", { name: "设置", exact: true }).click();
  await expect(ui).toBeHidden();
  await page.locator(".sidebar .profile-button").click();
  await expect(refresh).toBeEnabled();
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(ui.locator(".spin")).toHaveCount(0);
  check(
    "Leaving the page retains it while refresh completes; a late response does not leave a stuck spinner on return",
  );

  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/result.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` });
  throw error;
} finally {
  await browser.close();
}
