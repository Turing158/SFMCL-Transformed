import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";
import { waitForAutoSave } from "./lib/auto-save.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("evidence/minecraft-source");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
page.setDefaultTimeout(8000);
await page.addInitScript(pixelAppFixture, { persistJavaLists: true });
await page.addInitScript(resourceCenterFixture);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const nav = (name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const source = page.getByRole("combobox", {
  name: "下载源策略",
  exact: true,
});
const choose = async (name) => {
  await source.click();
  await page.getByRole("option", { name, exact: true }).click();
  await waitForAutoSave(page);
};
const manifestCount = () =>
  page.evaluate(
    () =>
      window.__pixelTest.requests.filter(
        (request) => request.operation === "manifest",
      ).length,
  );

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await nav("资源中心");
  await expect.poll(manifestCount).toBeGreaterThan(0);
  const initialCount = await manifestCount();
  await nav("设置");
  await expect(source).toContainText("速度优先（推荐）");
  await choose("镜像优先");
  expect(
    await page.evaluate(
      () => window.__pixelTest.data.settings.minecraftDownloadSource,
    ),
  ).toBe("bmclapi");
  await expect.poll(manifestCount).toBeGreaterThan(initialCount);
  await nav("资源中心");
  await nav("设置");
  await expect(source).toContainText("镜像优先");
  await page.reload();
  await nav("设置");
  await expect(source).toContainText("镜像优先");

  for (const [theme, width] of [
    ["light", 1120],
    ["dark", 720],
  ]) {
    await page.setViewportSize({ width, height: 760 });
    await page.locator(`.theme-option.${theme}`).click();
    await waitForAutoSave(page);
    await source.scrollIntoViewIfNeeded();
    expect(
      await source.evaluate((element) => {
        const field = element.closest(".field");
        return field.scrollWidth <= field.clientWidth + 1;
      }),
    ).toBe(true);
    await source.click();
    await expect(
      page.getByRole("option", { name: "官网优先", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: "镜像优先", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `${evidence}/${theme}-${width}.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
  }
  await choose("官网优先");
  expect(
    await page.evaluate(
      () => window.__pixelTest.data.settings.minecraftDownloadSource,
    ),
  ).toBe("official");
  await page.reload();
  await nav("设置");
  await expect(source).toContainText("官网优先");
  await choose("速度优先（推荐）");
  expect(
    await page.evaluate(
      () => window.__pixelTest.data.settings.minecraftDownloadSource,
    ),
  ).toBe("auto");
  await page.reload();
  await nav("设置");
  await expect(source).toContainText("速度优先（推荐）");
  expect(errors).toEqual([]);
  console.log(
    "Passed Minecraft source defaults, switching, auto-save, reload persistence, manifest refresh, and light/dark layouts.",
  );
  console.log(`Evidence: ${evidence}`);
} finally {
  await browser.close();
}
