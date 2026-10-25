import { runtimePath } from "./lib/paths.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { playersFixture } from "./fixtures/players.mjs";

const evidence = runtimePath("players-implementation/appearance");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(8000);
const checks = [],
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(playersFixture);
await page.addInitScript(() => {
  const animate = Element.prototype.animate;
  window.__appearance = [];
  Element.prototype.animate = function (...args) {
    const animation = animate.apply(this, args);
    if (
      window.__holdAppearance &&
      this.matches(".players-figure canvas, .players-name-transition > *")
    ) {
      animation.pause();
      window.__appearance.push(animation);
    }
    return animation;
  };
});
const ui = page.locator(".players-page");
const nav = page.getByRole("navigation", { name: "主导航" });
const title = ui.locator(".players-identity h2");
const skin = ui.locator(".skin-body");
const button = (name) => ui.getByRole("button", { name, exact: true });
const check = (message) => {
  checks.push(message);
  console.log(`PASS ${message}`);
};
const settle = async () => {
  await page.evaluate(() => {
    window.__holdAppearance = false;
    window.__appearance.forEach((animation) => {
      if (animation.playState !== "idle") animation.finish();
    });
  });
  await expect(
    ui.locator(".players-skin-outgoing, .players-name-outgoing"),
  ).toHaveCount(0);
};
const arm = async () => {
  await settle();
  await page.evaluate(() => {
    window.__appearance = [];
    window.__holdAppearance = true;
  });
};
const pixels = () => skin.evaluate((canvas) => canvas.toDataURL());
const inspectTransition = async (oldPixels, name, screenshot) => {
  await expect(title).toHaveText(name);
  await expect
    .poll(() => page.evaluate(() => window.__appearance.length))
    .toBe(4);
  await expect(ui.locator(".players-skin-outgoing")).toHaveCount(1);
  expect(
    await ui
      .locator(".players-skin-outgoing")
      .evaluate((canvas) => canvas.toDataURL()),
  ).toBe(oldPixels);
  const frames = await page.evaluate(() => {
    const sample = (time) => {
      window.__appearance.forEach((animation) => {
        animation.currentTime = time;
      });
      return [
        ".players-skin-outgoing",
        ".skin-body",
        ".players-name-outgoing",
        ".players-name-transition h2",
      ].map((selector) => {
        const element = document.querySelector(`.players-page ${selector}`);
        const style = getComputedStyle(element),
          rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, opacity: Number(style.opacity) };
      });
    };
    const start = sample(0),
      end = sample(360),
      middle = sample(140);
    return { start, middle, end };
  });
  expect(frames.end[0].x).toBeLessThan(frames.middle[0].x);
  expect(frames.middle[0].x).toBeLessThan(frames.start[0].x);
  expect(frames.end[1].x).toBeLessThan(frames.middle[1].x);
  expect(frames.middle[1].x).toBeLessThan(frames.start[1].x);
  expect(frames.middle[0].opacity).toBeGreaterThan(0);
  expect(frames.middle[1].opacity).toBeGreaterThan(0);
  expect(frames.end[2].y).toBeLessThan(frames.start[2].y);
  expect(frames.end[3].y).toBeLessThan(frames.start[3].y);
  if (screenshot)
    await page.screenshot({ path: `${evidence}/${screenshot}.png` });
};
const verifyButtons = async (root = ui) => {
  // Exercise real pointer states without activating actions or the modal backdrop.
  await page.evaluate(() => {
    window.__ignoreMotionClick = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("click", window.__ignoreMotionClick, true);
  });
  const buttons = root.locator("button:enabled");
  let tested = 0;
  for (let i = 0; i < (await buttons.count()); i++) {
    const control = buttons.nth(i);
    if (!(await control.isVisible())) continue;
    await page.mouse.move(1, 1);
    await control.evaluate((element) => element.blur());
    await page.waitForTimeout(210);
    const original = await control.boundingBox();
    await control.hover();
    await expect
      .poll(async () => (await control.boundingBox()).y)
      .toBeCloseTo(original.y - 2, 0);
    await page.mouse.down();
    await expect
      .poll(async () => (await control.boundingBox()).y)
      .toBeCloseTo(original.y + 2, 0);
    expect((await control.boundingBox()).width).toBeCloseTo(original.width, 1);
    await page.mouse.move(1, 1);
    await page.mouse.up();
    tested++;
  }
  await page.evaluate(() =>
    window.removeEventListener("click", window.__ignoreMotionClick, true),
  );
  return tested;
};
const setImage = async (color, delay = 0) =>
  page.evaluate(
    ({ color, delay }) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const context = canvas.getContext("2d");
      context.fillStyle = color;
      context.fillRect(0, 0, 64, 64);
      window.__pixelTest.image = canvas.toDataURL();
      window.__pixelTest.delays.image = delay;
    },
    { color, delay },
  );

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page.locator(".sidebar .profile-button").click();
  await expect(title).toHaveText("Steve");
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      skin.evaluate(
        (canvas) => canvas.getContext("2d").getImageData(8, 5, 1, 1).data[3],
      ),
    )
    .toBe(255);
  // The established app preference keeps animations enabled for all OS settings.
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const view of ["grove", "gallery"]) {
      if ((await ui.getAttribute("data-view")) !== view)
        await ui.locator(".players-view-switch").click();
      await expect(page.locator("html")).not.toHaveAttribute(
        "data-player-view-transition",
      );
      check(
        `${await verifyButtons()} buttons hover and press smoothly in ${theme}/${view}, without resizing`,
      );
    }
  }
  await button("更改名称").click();
  expect(await ui.locator("dialog button:enabled").count()).toBe(3);
  check(
    `${await verifyButtons(ui.locator("dialog"))} buttons include rename-dialog close, cancel and save`,
  );
  await button("取消").click();

  for (const [width, target] of [
    [1440, "Builder_07"],
    [375, "Steve"],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    const before = await pixels();
    await arm();
    await button(`选择角色 ${target}`).click();
    await inspectTransition(before, target, `character-${width}-middle`);
    await settle();
  }
  check(
    "Character switches retain old pixels and animate skin and name together at desktop and narrow sizes",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const color of ["#c43228", "#2369ce"]) {
    const before = await pixels();
    await setImage(color, 650);
    await arm();
    await button("更换皮肤").click();
    await page.waitForTimeout(150);
    expect(await pixels()).toBe(before);
    expect(await page.evaluate(() => window.__appearance.length)).toBe(0);
    await inspectTransition(before, "Steve", `skin-${color.slice(1)}-middle`);
    expect(await pixels()).not.toBe(before);
    await settle();
  }
  check(
    "Delayed imports retain the displayed skin; replacing the same file path also animates updated pixels",
  );

  let before = await pixels();
  await arm();
  await button("重置皮肤").click();
  await inspectTransition(before, "Steve");
  await settle();
  before = await pixels();
  await button("更改名称").click();
  await page.getByLabel("新的名称", { exact: true }).fill("Steve_New");
  await arm();
  await button("保存名称").click();
  await inspectTransition(before, "Steve_New");
  await settle();
  check(
    "Reset and rename preserve outgoing content and animate the updated name",
  );

  await arm();
  await page.evaluate(() => {
    window.__pixelTest.pick = null;
  });
  await button("更换皮肤").click();
  await button("刷新 Alex 登录").click();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__appearance.length)).toBe(0);
  check(
    "Cancelled pickers and unchanged account refreshes do not replay transitions",
  );

  before = await pixels();
  await arm();
  await button("选择角色 Builder_07").click();
  await inspectTransition(before, "Builder_07");
  await button("选择角色 Alex").click();
  await expect(title).toHaveText("Alex");
  await expect(ui.locator(".players-skin-outgoing")).toHaveCount(1);
  expect(
    await page.evaluate(() =>
      window.__appearance
        .slice(0, 4)
        .every((animation) => animation.playState === "idle"),
    ),
  ).toBe(true);
  await settle();
  for (const control of [ui.locator(".players-model"), button("重置皮肤")]) {
    await control.hover();
    await page.mouse.down();
    expect(
      await control.evaluate((element) => getComputedStyle(element).transform),
    ).toBe("none");
    await page.mouse.up();
  }
  check(
    "Rapid character changes cancel old animations; disabled model/reset controls stay still",
  );

  await button("选择角色 Steve_New").click();
  await expect(title).toHaveText("Steve_New");
  await page.evaluate(() => {
    window.__pixelTest.pick = "C:/Test/slow.png";
  });
  await setImage("#712ecc", 900);
  await button("更换皮肤").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__pixelTest.requests.filter(
            (request) =>
              request.operation === "image" &&
              request.payload.path === "C:/Test/slow.png",
          ).length,
      ),
    )
    .toBeGreaterThan(0);
  await button("选择角色 Alex").click();
  await expect(title).toHaveText("Alex");
  const alexPixels = await pixels();
  await page.waitForTimeout(1100);
  expect(await pixels()).toBe(alexPixels);
  await expect(title).toHaveText("Alex");
  check("A late skin response cannot overwrite the newly selected character");

  await button("离线登录").click();
  await expect(title).toHaveText("Steve");
  await arm();
  const offlineName = page.getByLabel("角色名称", { exact: true });
  await offlineName.pressSequentially("Offline_42", { delay: 30 });
  await expect(title).toHaveText("Offline_42");
  await offlineName.fill("");
  await expect(title).toHaveText("Steve");
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__appearance.length)).toBe(0);
  await expect(ui.locator(".players-name-outgoing")).toHaveCount(0);
  await settle();
  check(
    "Offline typing and clearing update the name immediately without appearance animations",
  );
  check(
    `${await verifyButtons()} offline-login buttons share hover and press feedback`,
  );
  await button("Microsoft 登录").click();
  await expect(ui.locator(".device-code")).toBeVisible();
  check(
    `${await verifyButtons()} Microsoft-login buttons include device-code and split actions`,
  );
  await page
    .getByRole("navigation", { name: "页面路径" })
    .getByRole("button", { name: "返回上一级", exact: true })
    .click();
  await expect(title).toHaveText("Alex");
  await arm();
  await button("选择角色 Builder_07").click();
  await expect
    .poll(() => page.evaluate(() => window.__appearance.length))
    .toBe(4);
  await nav.getByRole("button", { name: "开始游戏", exact: true }).click();
  await expect(ui).toBeHidden();
  expect(
    await page.evaluate(() =>
      window.__appearance.every((animation) => animation.playState === "idle"),
    ),
  ).toBe(true);
  check(
    "Leaving the page removes outgoing layers and cancels all appearance animations",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/report.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` });
  throw error;
} finally {
  await browser.close();
}
