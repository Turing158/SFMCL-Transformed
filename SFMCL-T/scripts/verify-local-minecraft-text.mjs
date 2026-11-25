import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence =
  process.env.SFMCL_T_TEST_ARTIFACT_DIR ||
  runtimePath("evidence/local-minecraft-text");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 740 } });
page.setDefaultTimeout(8000);
const checks = [],
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(resourceCenterFixture);
await page.addInitScript(() => {
  const items = window.__pixelTest.resources.localItems["1.21.4"];
  items.mod[0].name = "§aMod§l原样";
  items.resourcepack[0].name = "§a绿§l粗§o斜§n下§m删§r普通§k乱码";
  items.resourcepack.push({
    ...items.resourcepack[0],
    name: "§c<img src=x onerror=alert(1)>§r 材质包",
    path: items.resourcepack[0].path.replace("test.zip", "literal.zip"),
  });
  items.shader[0].name = "§bCom§eplementary§r 光影";
  items.shader.push({
    ...items.shader[0],
    name: "§d超长光影标题_".repeat(16),
    path: items.shader[0].path.replace("test.zip", "long.zip"),
  });
  items.world[0].name = "§6我的§l世界§r 存档";
});
const local = page.locator(".local-resources");
const tabs = page.getByRole("tablist", { name: "本地资源类型" });
const search = page.getByRole("searchbox", {
  name: "搜索本地资源",
  exact: true,
});
const title = (name) => local.getByRole("heading", { name, exact: true });
const run = (heading, text) =>
  heading.locator(".minecraft-text-run").filter({ hasText: text });
const settle = () =>
  page.evaluate(() =>
    Promise.allSettled(
      document
        .getAnimations()
        .filter(
          (animation) => animation.effect.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished),
    ),
  );
try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "版本管理", exact: true })
    .click();
  await page
    .getByRole("button", { name: "查看 1.21.4 本地资源", exact: true })
    .click();
  const mod = title("§aMod§l原样");
  await expect(mod).toBeVisible();
  await expect(mod.locator(".minecraft-text")).toHaveCount(0);
  checks.push("模组标题按原名显示，包含的 § 代码不作格式转换。");

  await tabs.getByRole("tab", { name: /^材质包/ }).click();
  const pack = title("绿粗斜下删普通乱码");
  await expect(pack).toBeVisible();
  await expect(run(pack, "绿")).toHaveCSS("color", "rgb(85, 255, 85)");
  await expect(run(pack, "粗")).toHaveCSS("font-weight", "700");
  await expect(run(pack, "斜")).toHaveCSS("font-style", "italic");
  await expect(run(pack, "下")).toHaveCSS("text-decoration-line", "underline");
  await expect(run(pack, "删")).toHaveCSS(
    "text-decoration-line",
    "underline line-through",
  );
  await expect(run(pack, "普通")).toHaveCSS("font-style", "normal");
  await expect(run(pack, "普通")).toHaveCSS("text-decoration-line", "none");
  const baseColor = await pack.evaluate(
    (element) => getComputedStyle(element).color,
  );
  await expect(run(pack, "普通")).toHaveCSS("color", baseColor);
  expect(
    await run(pack, "绿").evaluate(
      (element) => getComputedStyle(element).fontSize,
    ),
  ).toBe(await pack.evaluate((element) => getComputedStyle(element).fontSize));
  const literal = title("<img src=x onerror=alert(1)> 材质包");
  await expect(literal).toBeVisible();
  await expect(literal.locator("img")).toHaveCount(0);
  checks.push(
    "材质包标题正确组合颜色、加粗、斜体、下划线和删除线；重置恢复标题样式，HTML 内容作为文字显示。",
  );

  const scramble = pack.locator(".minecraft-obfuscated");
  const glyphText = () =>
    scramble.locator(".minecraft-obfuscated-glyph").allTextContents();
  const initial = await glyphText();
  const before = await pack.boundingBox();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(glyphText).not.toEqual(initial);
  const after = await pack.boundingBox();
  expect(after.width).toBeCloseTo(before.width, 3);
  expect(after.height).toBeCloseTo(before.height, 3);
  await expect(pack).toHaveAccessibleName("绿粗斜下删普通乱码");
  checks.push(
    "§k 乱码持续变化且保留原字符占位宽度，屏幕阅读器仍读取原名；系统动画偏好不关闭效果。",
  );
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await expect(run(pack, "绿")).toHaveCSS("color", "rgb(85, 255, 85)");
    await settle();
    await page.screenshot({ path: `${evidence}/resourcepack-${theme}.png` });
  }
  await search.fill("普通乱码");
  await expect(local.locator(".resource-row")).toHaveCount(1);
  await search.fill("");

  await tabs.getByRole("tab", { name: /^光影/ }).click();
  const shader = title("Complementary 光影");
  await expect(shader).toBeVisible();
  await expect(run(shader, "Com")).toHaveCSS("color", "rgb(85, 255, 255)");
  await expect(run(shader, "plementary")).toHaveCSS(
    "color",
    "rgb(255, 255, 85)",
  );
  await search.fill("Complementary");
  await expect(local.locator(".resource-row")).toHaveCount(1);
  await expect(shader).toBeVisible();
  await shader.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Complementary 光影");
  await page.keyboard.press("Escape");
  await search.fill("");
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 740 });
    expect(
      await local.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({ path: `${evidence}/shader-${width}.png` });
  }
  checks.push(
    "光影的分段颜色、连续名称搜索和无格式码 Tooltip 正常；超长标题在窄窗口保持省略而不溢出。",
  );

  await page.setViewportSize({ width: 1120, height: 740 });
  await tabs.getByRole("tab", { name: /^存档/ }).click();
  const world = title("我的世界 存档");
  await expect(world).toBeVisible();
  await expect(run(world, "我的")).toHaveCSS("color", "rgb(255, 170, 0)");
  await page
    .getByRole("button", { name: "我的世界 存档 详情", exact: true })
    .click();
  const heading = page.locator(".local-resource-page h1");
  await expect(heading).toHaveAccessibleName("我的世界 存档");
  await expect(run(heading, "我的")).toHaveCSS("color", "rgb(255, 170, 0)");
  await expect(run(heading, "世界")).toHaveCSS("font-weight", "700");
  await expect(
    page.getByRole("navigation", { name: "页面路径" }),
  ).not.toContainText("§");
  await settle();
  await page.screenshot({ path: `${evidence}/world-detail.png` });
  await page.getByRole("button", { name: "打开所在目录", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        window.__pixelTest.requests
          .filter((request) => request.operation === "path.open")
          .at(-1).payload.path,
    ),
  ).toContain("/saves/test.zip");
  checks.push(
    "存档列表和详情标题显示相同格式，导航与操作名称使用可读原文，打开目录仍使用原始文件路径。",
  );
  expect(errors).toEqual([]);
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` });
  throw error;
} finally {
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  await browser.close();
}
console.log(JSON.stringify({ checks, errors }, null, 2));
