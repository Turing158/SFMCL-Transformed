import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { launchDockFixture } from "./fixtures/launch-dock.mjs";
import { runtimePath } from "./lib/paths.mjs";

const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/";
const evidence = runtimePath("evidence/sidebar-favorites");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 864, height: 591 } });
page.setDefaultTimeout(8000);
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));

function favoriteFixture() {
  const test = window.__pixelTest;
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const scenario = new URL(location.href).searchParams.get("favorite-test");
  const favorites =
    JSON.parse(sessionStorage.getItem("favorite-test-state") || "null") || {};
  const primaryDirectory = test.data.settings.activeDir;
  const secondaryDirectory = "D:/Other-Minecraft";
  if (scenario.startsWith("cross"))
    test.data.settings.gameDirs.push({
      name: "另一游戏目录",
      path: secondaryDirectory,
    });
  test.data.settings.downloadTaskDisplay = "always";
  test.tasks.downloads = [];
  test.tasks.jobs = [];
  if (scenario === "no-player") test.data.settings.activePlayer = "";
  if (scenario.endsWith("slow")) test.delays["versions.select"] = 800;
  if (scenario === "failure") test.failures["versions.select"] = "版本切换失败";
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "request" && args.operation === "versions.favorite") {
      test.requests.push({
        operation: args.operation,
        payload: structuredClone(args.payload),
      });
      favorites[args.payload.id] = args.payload.favorite;
      sessionStorage.setItem("favorite-test-state", JSON.stringify(favorites));
      return true;
    }
    const result = await invoke(
      command,
      command === "request" && args.operation === "versions.favorites"
        ? { ...args, operation: "versions.list" }
        : args,
    );
    if (
      command === "request" &&
      ["versions.list", "versions.favorites"].includes(args.operation)
    ) {
      const versions = result.slice(0, 2);
      versions.push({
        ...versions[1],
        id: "我的长期生存世界与大型模组整合包收藏版本",
        path: `${primaryDirectory}/versions/long-favorite`,
      });
      if (scenario === "many") {
        for (let index = 1; index <= 16; index++)
          versions.push({
            ...versions[0],
            id: `收藏世界-${index}`,
            path: `/versions/favorite-${index}`,
          });
      }
      for (const version of versions) {
        version.favorite = favorites[version.id] ?? scenario !== "empty";
        version.directory = primaryDirectory;
        version.directoryName = "像素工坊";
      }
      if (scenario.startsWith("cross")) {
        versions.push(
          ...[
            {
              ...versions[0],
              id: "1.21.4",
              path: `${secondaryDirectory}/.minecraft/versions/1.21.4`,
            },
            {
              ...versions[1],
              id: "另一个目录的生存世界",
              path: `${secondaryDirectory}/.minecraft/versions/other-world`,
            },
          ].map((version) => ({
            ...version,
            directory: secondaryDirectory,
            directoryName: "另一游戏目录",
            favorite: true,
          })),
        );
      }
      const registered = versions.filter((version) =>
        test.data.settings.gameDirs.some(
          (directory) => directory.path === version.directory,
        ),
      );
      return args.operation === "versions.favorites"
        ? registered.filter((version) => version.favorite)
        : registered.filter(
            (version) => version.directory === test.data.settings.activeDir,
          );
    }
    if (command === "request" && args.operation === "launch")
      test.latestLaunch.directory = test.data.settings.activeDir;
    return result;
  };
}
await page.addInitScript({
  content: `(${pixelAppFixture.toString()})(); (${launchDockFixture.toString()})(); (${favoriteFixture.toString()})();`,
});
const list = page.getByRole("list", { name: "收藏版本" });
const favorite = (id, directory) => {
  const option = list.getByRole("button", {
    name: `收藏版本：${id}`,
    exact: true,
  });
  return directory
    ? option.and(list.locator(`[data-directory=${JSON.stringify(directory)}]`))
    : option;
};
const count = (operation) =>
  page.evaluate(
    (operation) =>
      window.__pixelTest.requests.filter(
        (request) => request.operation === operation,
      ).length,
    operation,
  );
const nav = (name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const ready = async (scenario = "") => {
  await page.goto(`${url}?favorite-test=${scenario}`);
  await expect(page.locator("html")).not.toHaveAttribute("data-startup");
  await expect(list).toBeVisible();
};
const shot = (name) =>
  page.screenshot({ path: `${evidence}/${name}.png`, animations: "disabled" });

try {
  await ready();
  await expect(list.locator("button")).toHaveCount(3);
  expect(
    await list
      .locator("button")
      .evaluateAll((nodes) => nodes.map((node) => node.textContent.trim())),
  ).toEqual([
    "我的长期生存世界与大型模组整合包收藏版本",
    "1.20.1-Fabric",
    "1.21.4",
  ]);
  for (const height of [591, 720, 1000]) {
    await page.setViewportSize({ width: 864, height });
    const geometry = await list.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const top = document
        .querySelector("#sidebar-navigation button:last-child")
        .getBoundingClientRect();
      const bottom = document
        .querySelector(".sidebar-task")
        .getBoundingClientRect();
      const rail = node.closest(".sidebar");
      return {
        height: box.height,
        topGap: box.top - top.bottom,
        optionHeight: top.height,
        bottomGap: bottom.top - box.bottom,
        overflow: rail.scrollHeight > rail.clientHeight,
      };
    });
    expect(geometry.height).toBeLessThanOrEqual(320);
    expect(geometry.topGap).toBeGreaterThanOrEqual(geometry.optionHeight);
    expect(geometry.bottomGap).toBe(12);
    expect(geometry.overflow).toBe(false);
    if (height === 1000) expect(geometry.height).toBe(320);
  }
  await page.setViewportSize({ width: 864, height: 591 });
  await shot("864x591-light");
  const oneLine = favorite("1.21.4");
  expect(
    await oneLine.evaluate((button) => {
      const text = button
        .querySelector(".sidebar-favorite-copy")
        .getBoundingClientRect();
      const icon = button
        .querySelector(".sidebar-favorite-icon")
        .getBoundingClientRect();
      return Math.abs(text.top + text.height / 2 - icon.top - icon.height / 2);
    }),
  ).toBeLessThan(1);
  const longText = list.locator(".sidebar-favorite-copy").first();
  expect((await longText.boundingBox()).height).toBe(32);
  const navigationFill = await page
    .locator("#sidebar-navigation button.active > .surface-frame")
    .evaluate((frame) => getComputedStyle(frame, "::after").backgroundColor);
  const favoriteFill = () =>
    oneLine
      .locator(":scope > .surface-frame")
      .evaluate((frame) => getComputedStyle(frame, "::after").backgroundColor);
  await expect.poll(favoriteFill).not.toBe(navigationFill);
  await expect(oneLine).toHaveCSS("--surface-depth", "0px");
  await expect(oneLine).toHaveCSS("--surface-stroke", "2px");
  await expect(oneLine).toHaveCSS("translate", "none");
  const selectedFill = await favoriteFill();
  await oneLine.hover();
  await expect.poll(favoriteFill).toBe(selectedFill);
  await expect(oneLine).toHaveCSS("translate", "none");
  const icon = oneLine.locator(".sidebar-favorite-icon");
  await expect(icon).toHaveCSS("rotate", "8deg");
  await expect(icon).toHaveCSS("scale", "1.1");
  const avatar = page.locator(".profile-button .avatar");
  await page.locator(".profile-button").hover();
  await expect(avatar).toHaveCSS("rotate", "8deg");
  expect(await icon.evaluate((node) => getComputedStyle(node).transition)).toBe(
    await avatar.evaluate((node) => getComputedStyle(node).transition),
  );
  checks.push(
    "Bottom anchoring, one-option top gap, 12px bottom gap, 320px cap, reverse order, two-line text and matching icon motion",
  );

  await nav("版本管理");
  await favorite("1.20.1-Fabric").click();
  await expect(favorite("1.20.1-Fabric")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await count("launch")).toBe(0);
  await favorite("1.20.1-Fabric").click();
  await expect.poll(() => count("launch")).toBe(1);
  await expect(
    page.getByRole("heading", { name: "版本管理", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__pixelTest.latestLaunch.title))
    .toBe("启动 1.20.1-Fabric");
  await expect(favorite("1.20.1-Fabric")).toBeDisabled();
  checks.push(
    "First click selects, next click launches once, active launch locks shortcuts, current page is preserved",
  );

  for (const scenario of ["", "slow"]) {
    await ready(scenario);
    await nav("设置");
    await favorite("1.20.1-Fabric").dblclick({ delay: 50 });
    await expect.poll(() => count("launch")).toBe(1);
    expect(await count("versions.select")).toBe(1);
    await expect(
      page.getByRole("heading", { name: "设置", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => window.__pixelTest.latestLaunch.title),
    ).toBe("启动 1.20.1-Fabric");
  }
  checks.push(
    "Direct double click survives an 800ms selection delay and launches exactly once from Settings",
  );

  await ready("failure");
  await favorite("1.20.1-Fabric").dblclick();
  await expect(
    page.getByText("Error: 版本切换失败", { exact: true }).first(),
  ).toBeVisible();
  expect(await count("launch")).toBe(0);
  await ready("no-player");
  await favorite("1.20.1-Fabric").dblclick();
  await expect(
    page
      .getByText("Error: 请先选择一个角色，再启动游戏", { exact: true })
      .first(),
  ).toBeVisible();
  expect(await count("launch")).toBe(0);
  checks.push(
    "Failed selection and missing player produce an error without launching",
  );

  await ready();
  await nav("版本管理");
  await page
    .getByRole("button", { name: "取消收藏 1.20.1-Fabric", exact: true })
    .click();
  await expect(favorite("1.20.1-Fabric")).toHaveCount(0);
  await page.reload();
  await expect(list.locator("button")).toHaveCount(2);
  await nav("版本管理");
  await page
    .getByRole("button", { name: "收藏 1.20.1-Fabric", exact: true })
    .click();
  await expect(favorite("1.20.1-Fabric")).toHaveCount(1);
  await page.reload();
  await expect(list.locator("button")).toHaveCount(3);
  checks.push(
    "Version management can add and remove favorites; state is reflected after refresh and reload",
  );

  await ready("many");
  await expect(list.locator("button")).toHaveCount(19);
  expect(
    await list.evaluate(
      (node) =>
        node.scrollHeight > node.clientHeight &&
        Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) < 1,
    ),
  ).toBe(true);
  await expect(favorite("1.21.4")).toBeInViewport();
  await list.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(favorite("收藏世界-16")).toBeInViewport();
  const scrollbar = page.getByRole("scrollbar", { name: "收藏版本滚动条" });
  const thumb = scrollbar.locator(".sidebar-favorites-scrollbar-thumb");
  const frames = () =>
    scrollbar.evaluate(async (node) => {
      const values = [],
        start = performance.now();
      await new Promise((resolve) => {
        const sample = (time) => {
          values.push(Number(getComputedStyle(node).opacity));
          if (time - start < 400) requestAnimationFrame(sample);
          else resolve();
        };
        requestAnimationFrame(sample);
      });
      return values;
    });
  await page.mouse.move(4, 4);
  await expect(scrollbar).toHaveAttribute("data-scrollable", "true");
  await expect(scrollbar).not.toHaveAttribute("data-scrolling", "true");
  await expect(scrollbar).toHaveCSS("opacity", "0");
  const optionWidth = await list
    .locator("button")
    .first()
    .evaluate((node) => node.getBoundingClientRect().width);
  const bar = await scrollbar.boundingBox();
  expect(bar.width).toBe(6);
  expect(await scrollbar.getAttribute("aria-controls")).toBe(
    await list.getAttribute("id"),
  );
  const selections = await count("versions.select");
  const enter = frames();
  await scrollbar.hover({ position: { x: 3, y: bar.height / 2 } });
  expect((await enter).some((value) => value > 0 && value < 1)).toBe(true);
  await expect(scrollbar).toHaveCSS("opacity", "1");
  await expect(scrollbar).not.toHaveAttribute("data-scrolling", "true");
  const leave = frames();
  await page.mouse.move(bar.x - 20, bar.y + bar.height / 2);
  expect((await leave).some((value) => value > 0 && value < 1)).toBe(true);
  await expect(scrollbar).toHaveCSS("opacity", "0");
  await page.mouse.wheel(0, 100);
  await expect
    .poll(() => list.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  await expect(scrollbar).toHaveCSS("opacity", "1");
  await page.mouse.move(4, 4);
  await expect(scrollbar).toHaveCSS("opacity", "0");
  await scrollbar.click({ position: { x: 3, y: bar.height * 0.65 } });
  await expect
    .poll(() => list.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(100);
  const handle = await thumb.boundingBox();
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(bar.x + 3, bar.y + 2, { steps: 8 });
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBe(0);
  // Pointer capture keeps the scrollbar visible even outside its track.
  await page.mouse.move(bar.x + 40, bar.y + 2);
  await expect(scrollbar).toHaveAttribute("data-dragging", "true");
  await expect(scrollbar).not.toHaveAttribute("data-scrolling", "true");
  await expect(scrollbar).toHaveCSS("opacity", "1");
  await page.mouse.up();
  await expect(scrollbar).toHaveCSS("opacity", "0");
  await page.keyboard.press("Tab");
  await scrollbar.focus();
  await page.keyboard.press("End");
  await expect
    .poll(() =>
      list.evaluate((node) =>
        Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop),
      ),
    )
    .toBeLessThan(1);
  await page.keyboard.press("Home");
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBe(0);
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBe(44);
  await page.keyboard.press("Home");
  await scrollbar.evaluate((node) => node.blur());
  await page.mouse.move(4, 4);
  await expect(scrollbar).toHaveCSS("opacity", "0");
  expect(await count("versions.select")).toBe(selections);
  expect(
    await list
      .locator("button")
      .first()
      .evaluate((node) => node.getBoundingClientRect().width),
  ).toBe(optionWidth);
  checks.push(
    "Scrollbar fades on scroll and track hover, stays visible during captured dragging, supports track clicks and keyboard scrolling without selecting favorites or changing option widths",
  );
  await shot("scroll-top");
  await page.setViewportSize({ width: 864, height: 1000 });
  await shot("maximum-height-320");
  await page.setViewportSize({ width: 650, height: 591 });
  await expect(page.locator(".sidebar")).toHaveClass(/rail-collapsed/);
  await expect(list.locator(".sidebar-favorite-copy").first()).toHaveCSS(
    "visibility",
    "hidden",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await shot("collapsed");
  await page.setViewportSize({ width: 864, height: 591 });
  await ready();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await shot("864x591-dark");
  await favorite("1.20.1-Fabric").focus();
  await page.keyboard.press("Enter");
  await expect(favorite("1.20.1-Fabric")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("Enter");
  await expect.poll(() => count("launch")).toBe(1);
  checks.push(
    "Scrollable overflow, collapsed rail, dark theme and keyboard activation",
  );
  const primaryDirectory = "C:/Pixel-Test/Minecraft";
  const secondaryDirectory = "D:/Other-Minecraft";
  for (const scenario of ["cross", "cross-slow"]) {
    await ready(scenario);
    await expect(list.locator("button")).toHaveCount(5);
    await expect(favorite("1.21.4", primaryDirectory)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(favorite("1.21.4", secondaryDirectory)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await nav("设置");
    await favorite("1.21.4", secondaryDirectory).dblclick({ delay: 50 });
    await expect.poll(() => count("launch")).toBe(1);
    expect(await count("versions.select")).toBe(1);
    expect(
      await page.evaluate(() => window.__pixelTest.latestLaunch.directory),
    ).toBe(secondaryDirectory);
    await expect(
      page.getByRole("heading", { name: "设置", exact: true }),
    ).toBeVisible();
    await expect(list.locator("button")).toHaveCount(5);
  }
  checks.push(
    "All registered directories appear together, same-name versions remain distinct, cross-directory double click selects and launches the correct game once",
  );

  await ready("cross");
  await nav("版本管理");
  const directory = page.getByRole("combobox", {
    name: "游戏目录",
    exact: true,
  });
  await directory.click();
  await page.getByRole("option", { name: /另一游戏目录/ }).click();
  await expect(directory).toHaveText(secondaryDirectory);
  await expect(list.locator("button")).toHaveCount(5);
  await favorite("1.21.4", primaryDirectory).click();
  await expect(favorite("1.21.4", primaryDirectory)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(favorite("1.21.4", secondaryDirectory)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(await count("launch")).toBe(0);
  await directory.click();
  await page.getByRole("option", { name: /另一游戏目录/ }).click();
  await expect(directory).toHaveText(secondaryDirectory);
  await page.getByRole("button", { name: "移除目录记录", exact: true }).click();
  await page
    .getByRole("dialog", { name: "确认操作" })
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await expect(list.locator("button")).toHaveCount(3);
  await expect(favorite("1.21.4", secondaryDirectory)).toHaveCount(0);
  await expect(favorite("1.21.4", primaryDirectory)).toHaveCount(1);
  await page.getByRole("button", { name: "移除目录记录", exact: true }).click();
  await page
    .getByRole("dialog", { name: "确认操作" })
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await expect(list.locator("button")).toHaveCount(0);
  checks.push(
    "Switching the active folder preserves all favorites; removing a folder removes only its favorites, removing the last folder empties the list",
  );
  expect(errors).toEqual([]);
  console.log(
    `PASS ${checks.length} favorite behavior groups; no page errors.`,
  );
} catch (error) {
  process.exitCode = 1;
  console.error(error);
  await shot("failure").catch(() => {});
} finally {
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  await browser.close();
}
