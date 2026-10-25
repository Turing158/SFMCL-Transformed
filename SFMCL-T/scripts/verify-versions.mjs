import { runtimePath } from "./lib/paths.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";

const evidence = runtimePath("evidence/versions");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(8000);
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(() => {
  window.__pixelTest.data.settings.gameDirs.push({
    name: "另一个游戏目录",
    path: "D:/Games/Minecraft",
  });
});
const settle = () =>
  page.evaluate(() =>
    Promise.allSettled(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished),
    ),
  );
const mode = async (view) => {
  if ((await page.locator(".version-list").count()) > 0 !== (view === "list"))
    await page
      .getByRole("button", {
        name: view === "list" ? "切换为列表视图" : "切换为卡片视图",
        exact: true,
      })
      .click();
  await settle();
};
const card = (id) =>
  page
    .locator(".version-card")
    .filter({ has: page.getByRole("heading", { name: id, exact: true }) });
const selectRequests = () =>
  page.evaluate(
    () =>
      window.__pixelTest.requests.filter(
        (r) => r.operation === "versions.select",
      ).length,
  );

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "版本管理", exact: true })
    .click();
  await settle();
  await expect(page.locator(".version-view")).toHaveCount(1);
  await expect(
    page.locator(".version-management .pixel-search-count"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "选择版本", exact: true }),
  ).toHaveCount(0);
  const fabric = card("1.20.1-Fabric");
  await fabric.click({ position: { x: 100, y: 80 } });
  await expect(fabric).toHaveClass(/selected/);
  await page.getByRole("button", { name: "选择 1.21.4", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(card("1.21.4")).toHaveClass(/selected/);
  const selected = await selectRequests();
  expect(
    await card("1.21.4").evaluate((el) => ({
      shadow: getComputedStyle(el).boxShadow,
      marker: getComputedStyle(el).getPropertyValue("--surface-marker").trim(),
    })),
  ).toEqual({ shadow: "none", marker: "transparent" });
  await page
    .getByRole("button", { name: "管理 1.20.1-Fabric", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await selectRequests()).toBe(selected);
  await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await page
    .getByRole("button", { name: "查看 1.20.1-Fabric 本地资源", exact: true })
    .click();
  await expect(page.locator(".local-resources")).toBeVisible();
  await expect(
    page
      .locator("main")
      .getByRole("button", { name: "返回版本管理", exact: true }),
  ).toHaveCount(0);
  expect(await selectRequests()).toBe(selected);
  await page.getByRole("button", { name: "返回上一级", exact: true }).click();
  await settle();
  checks.push(
    "Card surface and keyboard select a version; icon actions do not select; redundant buttons and search count are removed.",
  );

  const directory = page.getByRole("combobox", {
    name: "游戏目录",
    exact: true,
  });
  await page.mouse.move(0, 0);
  await expect(directory).toHaveText("C:/Pixel-Test/Minecraft");
  await expect(
    page.locator(".versions-directory-toolbar > .lucide-folder-open"),
  ).toBeVisible();
  const restingDirectory = await directory.boundingBox();
  expect(
    await directory.evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--pixel-field-border"),
    ),
  ).toBe("rgba(0, 0, 0, 0)");
  await directory.hover();
  await settle();
  expect(await directory.boundingBox()).toEqual(restingDirectory);
  const spacing = await directory.evaluate((el) => {
    const toolbar = el.closest(".toolbar").getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const next = el
      .closest(".pixel-select")
      .nextElementSibling.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      left: rect.left - toolbar.left,
      right: next.left - rect.right,
      padding: Math.min(
        parseFloat(style.paddingLeft),
        parseFloat(style.paddingRight),
      ),
    };
  });
  expect(spacing.left).toBeGreaterThanOrEqual(16);
  expect(spacing.right).toBeGreaterThanOrEqual(10);
  expect(spacing.padding).toBeGreaterThanOrEqual(14);
  expect(
    await directory.evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--pixel-field-border"),
    ),
  ).not.toBe("rgba(0, 0, 0, 0)");
  await directory.click();
  await page.getByRole("option", { name: /另一个游戏目录/ }).click();
  await expect(directory).toHaveText("D:/Games/Minecraft");
  expect(
    await directory
      .locator(".pixel-select-value")
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("version-directory-in");
  await directory.click();
  await page.getByRole("option", { name: /像素工坊/ }).click();
  await settle();
  checks.push(
    "Directory retains its folder icon and horizontal spacing, never scales on hover, reveals its frame on hover/open, and animates a path change.",
  );

  // The shared toggle animates its icon; result geometry changes without travel.
  await page.locator(".version-view").evaluate((el) => el.click());
  await expect(page.locator(".version-view .catalog-view-symbol")).toHaveCSS(
    "animation-name",
    "catalog-view-change",
  );
  const motion = await page
    .locator("#local-version-results")
    .evaluate((root) => {
      const animations = root.getAnimations({ subtree: true });
      const sizes = animations.filter((a) =>
        a.effect.getKeyframes().some((k) => "width" in k || "height" in k),
      );
      const movement = animations.filter((a) =>
        a.effect
          .getKeyframes()
          .some((k) => "transform" in k || "translate" in k),
      );
      return { sizes: sizes.length, movement: movement.length };
    });
  expect(motion).toEqual({ sizes: 0, movement: 0 });
  await page.locator(".version-view").evaluate((el) => el.click());
  await page.locator(".version-view").evaluate((el) => el.click());
  await settle();
  await expect(page.locator(".version-list")).toHaveCount(1);
  expect(
    await page
      .locator("#local-version-results")
      .evaluate(
        (el) =>
          el
            .getAnimations({ subtree: true })
            .filter((a) => a.playState === "running").length,
      ),
  ).toBe(0);
  checks.push(
    "View toggle uses the resource-center icon animation; cards, frames and contents do not move or morph, including repeated toggles.",
  );

  for (const view of ["grid", "list"]) {
    await mode(view);
    await page.mouse.move(0, 0);
    await settle();
    const frame = fabric.locator(":scope > .surface-frame");
    const resting = await frame.boundingBox();
    const border = await frame.evaluate(
      (el) => getComputedStyle(el, "::before").backgroundColor,
    );
    await fabric
      .locator(".version-select")
      .hover({ position: { x: 8, y: 40 } });
    await settle();
    expect(await frame.boundingBox()).toEqual(resting);
    expect(
      await frame.evaluate(
        (el) => getComputedStyle(el, "::before").backgroundColor,
      ),
    ).not.toBe(border);
    expect(
      await frame.evaluate(
        (el) => getComputedStyle(el, "::before").transitionDuration,
      ),
    ).toBe("0.18s");
    await page.mouse.down();
    await settle();
    expect(await frame.boundingBox()).toEqual(resting);
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await settle();
    expect(await frame.boundingBox()).toEqual(resting);
    expect(
      await frame.evaluate(
        (el) => getComputedStyle(el, "::before").backgroundColor,
      ),
    ).toBe(border);
  }
  checks.push(
    "Grid and list frames fade their hover border and remain stationary on hover, press and pointer leave.",
  );

  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const view of ["grid", "list"]) {
        await mode(view);
        const bounds = await page.locator("main.page").evaluate((el) => ({
          width: el.clientWidth,
          content: el.scrollWidth,
        }));
        expect(bounds.content, `${theme}/${width}/${view}`).toBeLessThanOrEqual(
          bounds.width + 1,
        );
        const geometry = await card("1.21.4").evaluate((el) => {
          const rect = (selector) => {
            const r = el.querySelector(selector).getBoundingClientRect();
            return { x: r.x, y: r.y, right: r.right, width: r.width };
          };
          return {
            title: rect(".version-name"),
            badge: rect(".version-kind"),
            image: rect(".resource-icon"),
          };
        });
        if (view === "grid") {
          expect(geometry.badge.y).toBeLessThan(geometry.title.y);
          expect(geometry.badge.x).toBeGreaterThan(geometry.image.right);
        } else if (width >= 768) {
          expect(Math.abs(geometry.badge.y - geometry.title.y)).toBeLessThan(6);
          expect(geometry.badge.x).toBeGreaterThan(geometry.title.right);
        }
        if (width === 1440) {
          const badge = fabric.locator(".version-kind .badge");
          await page.mouse.move(0, 0);
          await settle();
          const before = await badge.boundingBox();
          await badge.hover();
          await settle();
          const after = await badge.boundingBox();
          expect(after.y).toBeCloseTo(before.y - 2, 1);
          expect(after.width).toBeCloseTo(before.width, 1);
          await badge.click();
          await expect(fabric).toHaveClass(/selected/);
          await page.mouse.move(0, 0);
          await settle();
          await expect(badge).toHaveCSS("transform", "none");
        }
        await page.screenshot({
          path: `${evidence}/${theme}-${width}-${view}.png`,
          animations: "disabled",
        });
      }
    }
  }
  await page.reload();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "版本管理", exact: true })
    .click();
  await expect(page.locator(".version-list")).toHaveCount(1);
  checks.push(
    "Grid/list preference persists; badge hover and click-to-select work in both views and themes; 16 responsive layouts have no horizontal overflow or selected underline.",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser.close();
}
