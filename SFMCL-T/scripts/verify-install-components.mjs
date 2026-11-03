import { runtimePath } from "./lib/paths.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { installComponentsFixture } from "./fixtures/install-components.mjs";

const evidence = runtimePath("evidence/install-components");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 640 } });
page.setDefaultTimeout(8000);
await page.addInitScript(pixelAppFixture);
await page.addInitScript(installComponentsFixture);
const errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
const nav = (name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const card = (name) =>
  page.getByRole("region", { name: `${name} 组件`, exact: true });
const toggle = (name) =>
  page.getByRole("button", { name: `选择 ${name}`, exact: true });
const versionName = page.getByPlaceholder("自定义版本名称");
const back = async () => {
  await page.getByRole("button", { name: "返回上一级", exact: true }).click();
  const heading = page.getByRole("heading", {
    name: "安装 Minecraft 1.20.1",
    exact: true,
  });
  if (!(await heading.isVisible())) return;
  // Returning retains the install page. Start each independent scenario with
  // explicit empty selections so the previous compatibility filter is cleared.
  const selected = page.getByRole("button", {
    name: /^取消选择 (Forge|OptiFine|Fabric|Fabric API|NeoForge|Quilt|LiteLoader)$/,
  });
  while (await selected.count()) await selected.first().click();
  await settle();
  for (const name of [
    "Forge",
    "OptiFine",
    "Fabric",
    "NeoForge",
    "Quilt",
    "LiteLoader",
  ]) {
    const button = toggle(name);
    if (!(await button.isVisible())) continue;
    const expanded = (await button.getAttribute("aria-expanded")) === "true";
    if (!expanded) await button.click();
    const search = card(name).getByRole("searchbox");
    if (await search.count()) await search.fill("");
    if (!expanded) await button.click();
  }
};
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
const openInstall = async () => {
  await nav("资源中心");
  await page
    .getByRole("button", {
      name: "查看 Minecraft 1.20.1 安装配置",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "安装 Minecraft 1.20.1", exact: true }),
  ).toBeVisible();
};
const choose = async (name, version) => {
  if ((await toggle(name).getAttribute("aria-expanded")) !== "true")
    await toggle(name).click();
  const search = card(name).getByRole("searchbox");
  if (await search.count()) await search.fill(version);
  await card(name)
    .getByRole("radio", { name: `${name} ${version}`, exact: true })
    .click();
};
const clear = (name) =>
  page.getByRole("button", { name: `取消选择 ${name}`, exact: true }).click();
const samplePresence = () =>
  page.locator(".minecraft-components").evaluate((root) => {
    const motions = root.getAnimations({ subtree: true });
    motions.forEach((motion) => motion.pause());
    const samples = [0, 120, 240].map((time) => {
      motions.forEach((motion) => {
        motion.currentTime = time;
      });
      const cards = [...root.querySelectorAll(".install-component")];
      const presence = (name) =>
        cards
          .find((el) => el.getAttribute("aria-label") === `${name} 组件`)
          .closest(".install-component-presence");
      return {
        forge: presence("Forge").getBoundingClientRect().height,
        api: presence("Fabric API").getBoundingClientRect().height,
        apiOpacity: Number(getComputedStyle(presence("Fabric API")).opacity),
        fabricTop:
          presence("Fabric").getBoundingClientRect().top -
          root.getBoundingClientRect().top,
      };
    });
    motions.forEach((motion) => motion.finish());
    return samples;
  });
const submit = async (success = true) => {
  await page.getByRole("button", { name: "开始安装", exact: true }).click();
  if (success)
    await expect(
      page.getByRole("heading", { name: "下载中心", exact: true }),
    ).toBeVisible();
};
const payload = () =>
  page.evaluate(
    () =>
      window.__pixelTest.requests
        .filter((request) => request.operation === "install")
        .at(-1)?.payload,
  );

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await openInstall();
  await expect(versionName).toHaveValue("1.20.1");
  await expect(page.locator(".install-component")).toHaveCount(7);
  await expect(
    page.getByRole("combobox", { name: "加载器", exact: true }),
  ).toHaveCount(0);
  await expect(toggle("Fabric API")).toHaveCount(0);
  await expect(toggle("LiteLoader")).toHaveCount(0);
  await expect(card("LiteLoader")).toHaveCount(0);
  await settle();
  expect(
    await page
      .locator(
        '.install-component-presence:has([aria-label="LiteLoader 组件"])',
      )
      .evaluate((el) => el.getBoundingClientRect().height),
  ).toBe(0);
  checks.push("没有可安装版本的加载器隐藏且不占空间，隐藏控件退出辅助功能导航");
  await toggle("Forge").click();
  await expect(card("Forge").getByRole("searchbox")).toBeVisible();
  const forgePanel = card("Forge").locator(".install-component-expand");
  await settle();
  const expandedHeight = await forgePanel.evaluate(
    (el) => el.getBoundingClientRect().height,
  );
  await toggle("Forge").click();
  await expect(forgePanel).toHaveAttribute("inert", "");
  const shrinking = await forgePanel.evaluate((el) => {
    const animations = el.getAnimations();
    animations.forEach((animation) => animation.pause());
    const heights = [0, 110, 220].map((time) => {
      animations.forEach((animation) => {
        animation.currentTime = time;
      });
      return el.getBoundingClientRect().height;
    });
    animations.forEach((animation) => animation.finish());
    return heights;
  });
  expect(shrinking[0]).toBeCloseTo(expandedHeight, 0);
  expect(shrinking[1]).toBeGreaterThan(0);
  expect(shrinking[1]).toBeLessThan(shrinking[0]);
  expect(shrinking[2]).toBe(0);
  await toggle("Fabric").click();
  await settle();
  await card("Fabric")
    .getByRole("radio", { name: "Fabric 0.16.10", exact: true })
    .evaluate((el) => el.click());
  const appearing = await samplePresence();
  expect(appearing[0].forge).toBeGreaterThan(appearing[1].forge);
  expect(appearing[1].forge).toBeGreaterThan(appearing[2].forge);
  expect(appearing[2].forge).toBe(0);
  expect(appearing[0].api).toBe(0);
  expect(appearing[1].api).toBeGreaterThan(0);
  expect(appearing[1].api).toBeLessThan(appearing[2].api);
  expect(appearing[1].apiOpacity).toBeGreaterThan(0);
  expect(appearing[1].apiOpacity).toBeLessThan(1);
  expect(appearing[0].fabricTop).toBeGreaterThan(appearing[1].fabricTop);
  expect(appearing[1].fabricTop).toBeGreaterThan(appearing[2].fabricTop);
  await expect(toggle("Forge")).toHaveCount(0);
  await page
    .getByRole("button", { name: "取消选择 Fabric", exact: true })
    .evaluate((el) => el.click());
  const disappearing = await samplePresence();
  expect(disappearing[0].forge).toBe(0);
  expect(disappearing[1].forge).toBeGreaterThan(0);
  expect(disappearing[1].forge).toBeLessThan(disappearing[2].forge);
  expect(disappearing[0].api).toBeGreaterThan(disappearing[1].api);
  expect(disappearing[1].api).toBeGreaterThan(0);
  expect(disappearing[2].api).toBe(0);
  expect(disappearing[0].fabricTop).toBeLessThan(disappearing[1].fabricTop);
  expect(disappearing[1].fabricTop).toBeLessThan(disappearing[2].fabricTop);
  await expect(toggle("Fabric API")).toHaveCount(0);
  checks.push(
    "依赖与互斥卡片显隐时高度和透明度连续变化，其余条目双向平滑补位，隐藏控件退出键盘与辅助功能导航",
  );
  await choose("Quilt", "0.27.0");
  await expect(versionName).toHaveValue("1.20.1-quilt-0.27.0");
  await versionName.fill("手动名称");
  await clear("Quilt");
  await expect(versionName).toHaveValue("1.20.1");
  await choose("Forge", "47.4.0");
  await expect(versionName).toHaveValue("1.20.1-forge-47.4.0");
  await expect(toggle("OptiFine")).toHaveCount(0);
  await clear("Forge");
  await expect(toggle("OptiFine")).toBeVisible();
  await choose("Forge", "47.2.18");
  await toggle("OptiFine").click();
  await expect(card("OptiFine").getByRole("radio")).toHaveCount(2);
  await expect(card("OptiFine")).toContainText("兼容 Forge 47.2.18");
  await choose("OptiFine", "HD_U_I6");
  await expect(versionName).toHaveValue("1.20.1-forge-47.2.18");
  await expect(page.locator(".minecraft-install-summary")).toContainText(
    "Forge 47.2.18 + OptiFine HD_U_I6",
  );
  for (const name of ["Fabric", "NeoForge", "Quilt", "LiteLoader"])
    await expect(toggle(name)).toHaveCount(0);
  await page.evaluate(() => {
    window.__pixelTest.failures.install = "模拟组合安装失败";
  });
  await submit(false);
  await expect(
    page.locator(".resource-subpage").getByRole("alert"),
  ).toContainText("模拟组合安装失败");
  expect(await payload()).toMatchObject({
    minecraft: "1.20.1",
    name: "1.20.1-forge-47.2.18",
    loader: { kind: "Forge", version: "47.2.18" },
    optifine: { kind: "OptiFine", version: "HD_U_I6" },
    fabricApi: null,
  });
  await expect(card("Forge")).toContainText("已选择 47.2.18");
  await expect(card("OptiFine")).toContainText("已选择 HD_U_I6");
  await page
    .getByRole("button", {
      name: "关闭通知：Error: 模拟组合安装失败",
      exact: true,
    })
    .click();
  await page.evaluate(() => {
    delete window.__pixelTest.failures.install;
  });
  await submit();
  await expect(
    page.getByRole("heading", { name: "下载中心", exact: true }),
  ).toBeVisible();
  await back();
  checks.push(
    "卡片取代加载器下拉框；展开/收起动画与 inert 生效，Forge + OptiFine 只显示匹配版本，安装失败保留组合，成功进入下载并可返回",
  );

  await choose("OptiFine", "HD_U_I5");
  await toggle("Forge").click();
  await expect(card("Forge").getByRole("radio")).toHaveText([
    "不安装",
    "47.1.0",
  ]);
  await choose("Forge", "47.1.0");
  await clear("Forge");
  await expect(versionName).toHaveValue("1.20.1-optifine_1.20.1_HD_U_I5");
  await expect(card("OptiFine")).toContainText("已选择 HD_U_I5");
  await submit();
  expect(await payload()).toMatchObject({
    loader: { kind: "OptiFine", version: "HD_U_I5" },
    optifine: null,
  });
  await back();
  await choose("OptiFine", "HD_U_I7_pre1");
  await expect(toggle("Forge")).toHaveCount(0);
  await submit();
  expect(await payload()).toMatchObject({
    loader: { kind: "OptiFine", version: "HD_U_I7_pre1" },
    optifine: null,
  });
  await back();
  checks.push(
    "先选 OptiFine 会反向筛选 Forge；取消 Forge 保留 OptiFine 独立安装，官网标注 N/A 的版本不会误配 Forge",
  );

  await choose("Fabric", "0.16.10");
  await expect(versionName).toHaveValue("1.20.1-fabric-0.16.10");
  await versionName.fill("我的 Fabric");
  await toggle("Fabric API").click();
  await expect(card("Fabric API").getByRole("radio")).toHaveCount(2);
  await choose("Fabric API", "0.92.12+1.20.1");
  await expect(versionName).toHaveValue("我的 Fabric");
  await submit();
  expect(await payload()).toMatchObject({
    name: "我的 Fabric",
    loader: { kind: "Fabric", version: "0.16.10" },
    optifine: null,
    fabricApi: { path: "fabric-api-current.jar" },
  });
  await back();
  await choose("Fabric", "0.16.10");
  await choose("Fabric API", "0.92.12+1.20.1");
  await clear("Fabric");
  await expect(
    page.getByRole("button", { name: "取消选择 Fabric API", exact: true }),
  ).toHaveCount(0);
  await expect(toggle("Fabric API")).toHaveCount(0);
  await submit();
  expect(await payload()).toMatchObject({
    loader: null,
    optifine: null,
    fabricApi: null,
  });
  await back();
  checks.push(
    "Fabric API 只允许适配当前 Minecraft 且有下载文件的版本；组合请求正确，取消 Fabric 会移除 API，空选择仍可安装原版",
  );

  await back();
  await page.evaluate(() => {
    window.__pixelTest.installComponents.failures.NeoForge =
      "NeoForge 请求失败";
  });
  await openInstall();
  await toggle("NeoForge").click();
  await expect(card("NeoForge").getByRole("alert")).toContainText(
    "NeoForge 请求失败",
  );
  await page.evaluate(() => {
    delete window.__pixelTest.installComponents.failures.NeoForge;
  });
  await card("NeoForge")
    .getByRole("button", { name: "重新获取 NeoForge" })
    .click();
  await expect(
    card("NeoForge").getByRole("radio", {
      name: "NeoForge 47.1.106",
      exact: true,
    }),
  ).toBeVisible();
  await choose("NeoForge", "47.1.106");
  await expect(versionName).toHaveValue("1.20.1-neoforge-47.1.106");
  await clear("NeoForge");
  await expect(versionName).toHaveValue("1.20.1");
  checks.push(
    "选择和取消加载器同步版本名称；Fabric/Quilt 名称省略 loader，Forge 联装沿用主加载器名称，Fabric API 保留手动名称并按该名称提交安装",
  );
  await toggle("Fabric").focus();
  await page.keyboard.press("Enter");
  await card("Fabric")
    .getByRole("radio", { name: "不安装 Fabric", exact: true })
    .focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    card("Fabric").getByRole("radio", { name: "Fabric 0.16.10", exact: true }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(toggle("Fabric")).toBeFocused();
  await expect(toggle("Fabric")).toHaveAttribute("aria-expanded", "false");
  await clear("Fabric");
  await toggle("Forge").click();
  await expect(card("Forge").getByRole("radio")).toHaveCount(61);
  await card("Forge")
    .getByRole("button", { name: /显示更多版本/ })
    .click();
  await expect(card("Forge").getByRole("radio")).toHaveCount(74);
  await card("Forge").getByRole("searchbox").fill("47.2.18");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "安装 Minecraft 1.20.1", exact: true }),
  ).toBeVisible();
  await expect(card("Forge").getByRole("radio")).toHaveCount(2);
  await choose("Forge", "47.2.18");
  await choose("OptiFine", "HD_U_I6");
  checks.push(
    "每张卡片独立处理错误与重试；键盘方向键可选择、Escape 收起并还原焦点；大量版本支持搜索和增量显示，搜索 Enter 不误提交安装",
  );

  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [375, 850, 1120, 1440]) {
      await page.setViewportSize({ width, height: 640 });
      await settle();
      const metrics = await page
        .locator(".resource-subpage-body")
        .evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
      expect(metrics.scroll).toBeLessThanOrEqual(metrics.client + 1);
      await page.locator("main.page").evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.screenshot({
        path: `${evidence}/cards-${theme}-${width}.png`,
      });
    }
  }
  await page.setViewportSize({ width: 1120, height: 640 });
  await toggle("OptiFine").click();
  await settle();
  const option = card("OptiFine").getByRole("radio", {
    name: "OptiFine HD_U_I6",
    exact: true,
  });
  await option.hover();
  await expect(option.locator("span")).toHaveCSS("translate", /^2px(?: 0px)?$/);
  await expect(card("OptiFine")).toHaveCSS("translate", "0px -2px");
  await settle();
  await page.screenshot({ path: `${evidence}/optifine-expanded.png` });
  checks.push(
    "375/850/1120/1440px 明暗主题无横向溢出，组件卡片与已选版本都有 hover 动画",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` });
  throw error;
} finally {
  await browser.close();
}
