import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";
import { answerConfirmation } from "./lib/confirmation.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("evidence/local-resource-pages");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(8000);
const errors = [],
  checks = [],
  layouts = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(resourceCenterFixture);
await page.addInitScript(() => {
  const state = window.__pixelTest;
  state.data.settings.downloadTaskDisplay = "always";
  window.__localPageTest = { copied: [], returnScroll: 0 };
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (args?.operation === "resources.toggle") {
      if (window.__localPageTest.pauseToggle)
        await new Promise((resolve) => {
          window.__localPageTest.releaseToggle = resolve;
        });
      if (window.__localPageTest.failNextToggle) {
        window.__localPageTest.failNextToggle = false;
        throw new Error("测试模组切换失败");
      }
    }
    return invoke(command, args);
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text) => window.__localPageTest.copied.push(text),
    },
  });
  const items = state.resources.localItems["1.20.1-Fabric"];
  Object.assign(items.shader[0], {
    description: "Ignored shader description",
    authors: "Ignored shader author",
    version: "Ignored shader version",
    error: "specified file not found in archive",
  });
  items.shader.push(
    {
      ...items.shader[0],
      name: "ComplementaryReimagined_超长光影名称与版本_Unbound_r5.6.1",
      path: items.shader[0].path.replace("test.zip", "long.zip"),
      size: 24657920,
    },
    {
      ...items.shader[0],
      name: "Empty shader",
      path: items.shader[0].path.replace("test.zip", "empty.zip"),
      size: 0,
    },
  );
  const original = items.mod[0];
  items.mod.push(
    ...Array.from({ length: 44 }, (_, index) => ({
      ...original,
      name: `Sodium 扩展 ${index + 1}`,
      path: original.path.replace("test.jar", `sodium-${index + 1}.jar`),
    })),
    {
      ...original,
      name: "读取失败的模组",
      path: original.path.replace("test.jar", "broken.jar"),
      error: "无法读取模组元数据，请检查文件是否完整。",
    },
  );
  Object.assign(items.world[0].details, {
    allowCommands: true,
    gameRules: Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`testRule${i}`, String(i)]),
    ),
  });
});
const nav = (name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const breadcrumbs = page.getByRole("navigation", { name: "页面路径" });
const back = () =>
  breadcrumbs
    .getByRole("button", { name: "返回上一级", exact: true })
    .first()
    .click();
const details = page.locator(".local-resource-page");
const main = page.locator("main.page");
const search = page.getByRole("searchbox", {
  name: "搜索本地资源",
  exact: true,
});
const modPagination = page.getByRole("navigation", {
  name: "本地模组分页",
  exact: true,
});
const modRows = page.locator(".local-resources .resource-list .resource-row");
const nextModPage = () =>
  modPagination.getByRole("button", { name: "下一页", exact: true }).click();
const refreshLocal = () =>
  page.getByRole("button", { name: "刷新", exact: true }).click();
const last = (operation) =>
  page.evaluate(
    (op) =>
      window.__pixelTest.requests.filter((item) => item.operation === op).at(-1)
        ?.payload,
    operation,
  );
const localRequestCount = () =>
  page.evaluate(
    () =>
      window.__pixelTest.requests.filter(
        (item) => item.operation === "resources.local",
      ).length,
  );

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await nav("版本管理");
  await page
    .getByRole("button", { name: "查看 1.20.1-Fabric 本地资源", exact: true })
    .click();
  await expect(modRows).toHaveCount(20);
  await expect(modPagination.getByRole("status")).toHaveText("第 1 / 3 页");
  await expect(
    modPagination.getByRole("button", { name: "上一页", exact: true }),
  ).toBeDisabled();
  const paginationRequests = await localRequestCount();
  const firstPageNames = await modRows.locator("h3").allTextContents();
  await main.evaluate((element) => {
    element.scrollTop = 650;
  });
  await nextModPage();
  await expect(modPagination.getByRole("status")).toHaveText("第 2 / 3 页");
  await expect(modRows).toHaveCount(20);
  expect(await main.evaluate((element) => element.scrollTop)).toBe(0);
  const secondPageNames = await modRows.locator("h3").allTextContents();
  expect(secondPageNames.some((name) => firstPageNames.includes(name))).toBe(
    false,
  );
  await nextModPage();
  await expect(modPagination.getByRole("status")).toHaveText("第 3 / 3 页");
  await expect(modRows).toHaveCount(6);
  await expect(
    modPagination.getByRole("button", { name: "下一页", exact: true }),
  ).toBeDisabled();
  const thirdPageNames = await modRows.locator("h3").allTextContents();
  expect(
    new Set([...firstPageNames, ...secondPageNames, ...thirdPageNames]).size,
  ).toBe(46);
  await modPagination
    .getByRole("button", { name: "上一页", exact: true })
    .click();
  await expect(modRows).toHaveCount(20);
  expect(await modRows.locator("h3").allTextContents()).toEqual(
    secondPageNames,
  );
  expect(await localRequestCount()).toBe(paginationRequests);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 960 });
      await main.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(modPagination).toBeInViewport();
      expect(
        await main.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true);
      expect(
        await modPagination.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `${evidence}/mod-pagination-${theme}-${width}.png`,
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  checks.push(
    "Local mods paginate into 20/20/6 rows without missing or duplicate entries or refetching; page boundaries, scroll-to-top and compact controls work in both themes at 375, 768 and 1440px.",
  );
  await search.fill("Sodium");
  await expect(modPagination.getByRole("status")).toHaveText("第 1 / 3 页");
  await nextModPage();
  const trigger = page.getByRole("button", {
    name: "Sodium 扩展 30 详情",
    exact: true,
  });
  await main.evaluate((element) => {
    element.scrollTop = 650;
  });
  await trigger.evaluate((element) =>
    element.addEventListener(
      "click",
      () => {
        window.__localPageTest.returnScroll =
          element.closest(".page").scrollTop;
      },
      { capture: true, once: true },
    ),
  );
  const requests = await localRequestCount();
  await trigger.click();
  await expect(
    details.getByRole("heading", { name: "Sodium 扩展 30", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(breadcrumbs.locator("button, strong")).toHaveText([
    "",
    "1.20.1-Fabric · 本地资源",
    "Sodium 扩展 30",
  ]);
  expect(await main.evaluate((element) => element.scrollTop)).toBe(0);
  expect(
    await details
      .locator("h1")
      .evaluate((element) => document.activeElement === element),
  ).toBe(true);
  await expect(details.locator(".world-details")).toContainText("Test");
  await expect(details.locator(".world-details")).toContainText("1.0");
  await expect(details.locator(".world-details")).toContainText("2.0 KB");
  await details
    .getByRole("button", { name: "打开所在目录", exact: true })
    .click();
  expect(await last("path.open")).toMatchObject({
    path: "C:/Pixel-Test/Minecraft/.minecraft/versions/1.20.1-Fabric/mods/sodium-30.jar",
    reveal: true,
  });
  await page.screenshot({ path: `${evidence}/mod-details.png` });
  await back();
  await expect(search).toHaveValue("Sodium");
  await expect(modPagination.getByRole("status")).toHaveText("第 2 / 3 页");
  await expect(modRows).toHaveCount(20);
  await expect(page.getByRole("tab", { name: /^模组/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(await localRequestCount()).toBe(requests);
  expect(await main.evaluate((element) => element.scrollTop)).toBe(
    await page.evaluate(() => window.__localPageTest.returnScroll),
  );
  expect(
    await trigger.evaluate((element) => document.activeElement === element),
  ).toBe(true);
  expect(
    await trigger.evaluate((element) => element.matches(":focus-visible")),
  ).toBe(false);
  checks.push(
    "Local rows open named subpages without a dialog; returning restores the second mod page, search, classification, scroll and focus without reloading or a mouse focus highlight.",
  );
  await expect(modRows.locator(".local-mod-channels")).toHaveCount(0);
  const channelRequests = () =>
    page.evaluate(
      () =>
        window.__pixelTest.requests.filter(
          (item) => item.operation === "resources.localProject",
        ).length,
    );
  expect(await channelRequests()).toBe(0);
  await trigger.click();
  await expect(
    details.getByRole("heading", { name: "Sodium 扩展 30", exact: true }),
  ).toBeVisible();
  const channelScroll = await main.evaluate((element) => element.scrollTop);
  for (const [source, label, id] of [
    ["modrinth", "Modrinth", "AANobbMI"],
    ["curseforge", "CurseForge", "394468"],
  ]) {
    const channelButton = details.getByRole("button", {
      name: `Sodium 扩展 30 的 ${label} 详情`,
      exact: true,
    });
    await channelButton.click();
    const projectPage = page.locator(
      '[data-page="versions"][data-view="resources"] .resource-subpage',
    );
    await expect(
      projectPage.getByRole("heading", { name: "Sodium", exact: true }),
    ).toBeVisible();
    await expect(
      projectPage.getByLabel(`资源渠道：${label}`, { exact: true }),
    ).toHaveText(label);
    expect(await last("resources.detail")).toMatchObject({ source, id });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(breadcrumbs.locator("button, strong")).toHaveText([
      "",
      "1.20.1-Fabric · 本地资源",
      "Sodium 扩展 30",
      "Sodium 扩展 30",
    ]);
    await projectPage.getByRole("tab", { name: /^可下载版本/ }).click();
    expect(await last("resources.files")).toMatchObject({
      source,
      id,
      gameVersion: "1.20.1",
      loader: "Fabric",
    });
    await expect(
      projectPage.getByRole("tab", { name: /^可下载版本/ }),
    ).toHaveAttribute("aria-selected", "true");
    await page.screenshot({
      path: `${evidence}/local-channel-${source}.png`,
      animations: "disabled",
    });
    await back();
    await expect(
      details.getByRole("heading", { name: "Sodium 扩展 30", exact: true }),
    ).toBeVisible();
    expect(await localRequestCount()).toBe(requests);
    expect(await main.evaluate((element) => element.scrollTop)).toBe(
      channelScroll,
    );
    expect(
      await channelButton.evaluate(
        (element) => document.activeElement === element,
      ),
    ).toBe(true);
    expect(
      await channelButton.evaluate((element) =>
        element.matches(":focus-visible"),
      ),
    ).toBe(false);
  }
  expect(await channelRequests()).toBe(2);
  await details
    .getByRole("button", {
      name: "Sodium 扩展 30 的 Modrinth 详情",
      exact: true,
    })
    .click();
  await expect(
    page.locator(
      '[data-page="versions"][data-view="resources"] .resource-subpage h1',
    ),
  ).toHaveText("Sodium");
  expect(await channelRequests()).toBe(2);
  await back();
  await back();
  await expect(search).toHaveValue("Sodium");
  await expect(modPagination.getByRole("status")).toHaveText("第 2 / 3 页");
  expect(await main.evaluate((element) => element.scrollTop)).toBe(
    await page.evaluate(() => window.__localPageTest.returnScroll),
  );
  expect(await localRequestCount()).toBe(requests);
  const otherChannelRow = modRows.filter({
    has: page.getByRole("heading", { name: "Sodium 扩展 31", exact: true }),
  });
  await page.evaluate(() => {
    window.__pixelTest.resources.unmatchedLocalSource = "curseforge";
  });
  await otherChannelRow
    .getByRole("button", { name: "Sodium 扩展 31 详情", exact: true })
    .click();
  await details
    .getByRole("button", {
      name: "Sodium 扩展 31 的 CurseForge 详情",
      exact: true,
    })
    .click();
  await expect(
    details
      .getByRole("alert")
      .filter({ hasText: "未找到此模组文件对应的 CurseForge 项目" }),
  ).toBeVisible();
  await expect(
    details.getByRole("heading", { name: "Sodium 扩展 31", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    delete window.__pixelTest.resources.unmatchedLocalSource;
    window.__pixelTest.failures["resources.localProject"] = "测试模组渠道中断";
  });
  await details
    .getByRole("button", {
      name: "Sodium 扩展 31 的 Modrinth 详情",
      exact: true,
    })
    .click();
  await expect(
    details.getByRole("alert").filter({ hasText: "测试模组渠道中断" }),
  ).toBeVisible();
  await expect(
    details.getByRole("heading", { name: "Sodium 扩展 31", exact: true }),
  ).toBeVisible();
  expect(await localRequestCount()).toBe(requests);
  await page.evaluate(() => {
    delete window.__pixelTest.failures["resources.localProject"];
    window.__pixelTest.delays["resources.localProject"] = 500;
  });
  await details
    .getByRole("button", {
      name: "Sodium 扩展 31 的 Modrinth 详情",
      exact: true,
    })
    .click();
  await back();
  await page.getByRole("tab", { name: /^光影/ }).click();
  await page.waitForTimeout(650);
  await expect(page.getByRole("tab", { name: /^光影/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(search).toBeVisible();
  await page.evaluate(() => {
    delete window.__pixelTest.delays["resources.localProject"];
  });
  await page.getByRole("tab", { name: /^模组/ }).click();
  const notices = page.locator(".notification-deck .toast");
  while (await notices.count()) {
    const count = await notices.count();
    await notices.first().click();
    await expect(notices).toHaveCount(count - 1);
  }
  await trigger.click();
  await expect(details.locator(".local-mod-channel")).toHaveCount(2);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 960 });
      await main.evaluate((element) => {
        element.scrollTop = 0;
      });
      expect(
        await main.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true);
      expect(
        await details.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `${evidence}/mod-channels-${theme}-${width}.png`,
        animations: "disabled",
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await back();
  await main.evaluate((element) => {
    element.scrollTop = 650;
  });
  checks.push(
    "Channel buttons appear only in local mod details and open the shared resource-center project/files pages with distinct source badges; returning restores the local detail and then its list's focus/search/page/scroll. Identifiers, cache, no-match/network errors, stale-response protection and narrow detail layouts work without rescanning mods.",
  );
  const toggleRow = modRows.filter({
    has: page.getByRole("heading", { name: "Sodium 扩展 30", exact: true }),
  });
  await toggleRow.evaluate((element) => {
    window.__localPageTest.toggleRow = element;
    window.__localPageTest.toggleIcon = element.querySelector(".resource-icon");
    window.__localPageTest.otherRow = element.previousElementSibling;
    window.__localPageTest.toggleScroll = element.closest(".page").scrollTop;
    window.__localPageTest.pauseToggle = true;
  });
  const beforeToggleRequests = await localRequestCount();
  await toggleRow
    .getByRole("button", { name: "禁用 Sodium 扩展 30", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => typeof window.__localPageTest.releaseToggle),
    )
    .toBe("function");
  await expect(toggleRow).not.toHaveClass(/disabled-resource/);
  await expect(toggleRow.getByText("已禁用", { exact: true })).toHaveCount(0);
  await expect(page.getByText("正在读取资源…", { exact: true })).toHaveCount(0);
  await expect(modRows).toHaveCount(20);
  await page.evaluate(() => {
    window.__localPageTest.pauseToggle = false;
    window.__localPageTest.releaseToggle();
    delete window.__localPageTest.releaseToggle;
  });
  await expect(
    toggleRow.getByRole("button", { name: "启用 Sodium 扩展 30", exact: true }),
  ).toBeEnabled();
  await expect(toggleRow).toHaveClass(/disabled-resource/);
  await expect(toggleRow.getByText("已禁用", { exact: true })).toBeVisible();
  expect(await localRequestCount()).toBe(beforeToggleRequests);
  await expect(search).toHaveValue("Sodium");
  await expect(modPagination.getByRole("status")).toHaveText("第 2 / 3 页");
  expect(
    await toggleRow.evaluate((element) => ({
      sameRow: element === window.__localPageTest.toggleRow,
      sameIcon:
        element.querySelector(".resource-icon") ===
        window.__localPageTest.toggleIcon,
      sameOtherRow:
        element.previousElementSibling === window.__localPageTest.otherRow,
      sameScroll:
        element.closest(".page").scrollTop ===
        window.__localPageTest.toggleScroll,
    })),
  ).toEqual({
    sameRow: true,
    sameIcon: true,
    sameOtherRow: true,
    sameScroll: true,
  });
  await toggleRow
    .getByRole("button", { name: "启用 Sodium 扩展 30", exact: true })
    .click();
  await expect(
    toggleRow.getByRole("button", { name: "禁用 Sodium 扩展 30", exact: true }),
  ).toBeEnabled();
  expect((await last("resources.toggle")).path).toContain(
    "/mods/.disabled/sodium-30.jar",
  );
  await expect(toggleRow).not.toHaveClass(/disabled-resource/);
  await expect(toggleRow.getByText("已禁用", { exact: true })).toHaveCount(0);
  expect(
    await toggleRow.evaluate(
      (element) => element === window.__localPageTest.toggleRow,
    ),
  ).toBe(true);
  expect(await localRequestCount()).toBe(beforeToggleRequests);
  await page.evaluate(() => {
    window.__localPageTest.failNextToggle = true;
  });
  await toggleRow
    .getByRole("button", { name: "禁用 Sodium 扩展 30", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "测试模组切换失败" }),
  ).toBeVisible();
  await expect(toggleRow).not.toHaveClass(/disabled-resource/);
  await expect(
    toggleRow.getByRole("button", { name: "禁用 Sodium 扩展 30", exact: true }),
  ).toBeEnabled();
  expect(await localRequestCount()).toBe(beforeToggleRequests);
  checks.push(
    "Mod toggles update only after success without rescanning resources or replacing rows/icons; search, page and scroll are retained, the returned file path supports re-enabling, and failures preserve the previous state.",
  );

  await trigger.click();
  await nav("设置");
  await nav("版本管理");
  await expect(
    details.getByRole("heading", { name: "Sodium 扩展 30", exact: true }),
  ).toBeVisible();
  await page.locator(".sidebar-task").click();
  await expect(breadcrumbs.locator("strong")).toHaveText("下载中心");
  await back();
  await expect(
    details.getByRole("heading", { name: "Sodium 扩展 30", exact: true }),
  ).toBeVisible();
  await back();
  await search.fill("");
  await expect(modPagination.getByRole("status")).toHaveText("第 1 / 3 页");
  const beforeOriginalToggle = await localRequestCount();
  await page
    .getByRole("button", { name: "禁用 1.20.1-Fabric Sodium", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "启用 1.20.1-Fabric Sodium",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "启用 1.20.1-Fabric Sodium", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "禁用 1.20.1-Fabric Sodium",
      exact: true,
    }),
  ).toBeVisible();
  expect(await localRequestCount()).toBe(beforeOriginalToggle);
  checks.push(
    "Cross-page switches and downloads retain the detail's navigation chain; list actions remain usable.",
  );

  await nextModPage();
  await nextModPage();
  await page
    .getByRole("button", { name: "读取失败的模组 详情", exact: true })
    .click();
  await expect(details.getByRole("alert")).toContainText("无法读取模组元数据");
  await back();
  await expect(modPagination.getByRole("status")).toHaveText("第 3 / 3 页");
  await page.getByRole("tab", { name: /^光影/ }).click();
  await expect(modPagination).toHaveCount(0);
  await page.getByRole("tab", { name: /^模组/ }).click();
  await expect(modPagination.getByRole("status")).toHaveText("第 3 / 3 页");
  await search.fill("Sodium 扩展 44");
  await expect(modRows).toHaveCount(1);
  await expect(modRows.locator("h3")).toHaveText("Sodium 扩展 44");
  await expect(modPagination.getByRole("status")).toHaveText("第 1 / 1 页");
  for (const name of ["上一页", "下一页"])
    await expect(
      modPagination.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  await search.fill("没有这个模组");
  await expect(modRows).toHaveCount(0);
  await expect(modPagination).toHaveCount(0);
  await page.getByRole("button", { name: "清空搜索", exact: true }).click();
  await expect(modRows).toHaveCount(20);
  await expect(modPagination.getByRole("status")).toHaveText("第 1 / 3 页");
  await nextModPage();
  await nextModPage();
  const beforeRefresh = await localRequestCount();
  await refreshLocal();
  await expect.poll(localRequestCount).toBe(beforeRefresh + 4);
  await expect(modRows).toHaveCount(6);
  await expect(modPagination.getByRole("status")).toHaveText("第 3 / 3 页");
  await page.evaluate(() => {
    window.__pixelTest.resources.localItems["1.20.1-Fabric"].mod.splice(20);
  });
  await refreshLocal();
  await expect(modRows).toHaveCount(20);
  await expect(modPagination.getByRole("status")).toHaveText("第 1 / 1 页");
  checks.push(
    "Mod search matches all pages and resets pagination; category changes and refresh preserve the page, empty searches hide controls, and a shorter refreshed list clamps to its final valid page.",
  );
  await page.getByRole("tab", { name: /^存档/ }).click();
  await expect(modPagination).toHaveCount(0);
  await page
    .getByRole("button", { name: "1.20.1-Fabric 我的世界 详情", exact: true })
    .click();
  await expect(details).toContainText("9223372036854775807");
  await expect(details).toContainText("允许作弊");
  await expect(details.locator(".gamerules button")).toHaveCount(30);
  expect(
    await details
      .locator(".gamerules")
      .evaluate((element) => getComputedStyle(element).maxHeight),
  ).toBe("none");
  await details
    .getByRole("button", { name: "复制世界种子", exact: true })
    .click();
  expect(await page.evaluate(() => window.__localPageTest.copied.at(-1))).toBe(
    "9223372036854775807",
  );
  await details
    .getByRole("button", { name: "复制游戏规则 testRule0", exact: true })
    .click();
  expect(await page.evaluate(() => window.__localPageTest.copied.at(-1))).toBe(
    "/gamerule testRule0 0",
  );
  await details
    .getByRole("button", { name: "打开所在目录", exact: true })
    .click();
  expect((await last("path.open")).path).toContain("/saves/test.zip");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 960 });
      await main.evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect
        .poll(() =>
          main.evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
        )
        .toBe(true);
      await page.waitForTimeout(280);
      const layout = await main.evaluate((element) => ({
        width: element.clientWidth,
        content: element.scrollWidth,
      }));
      layouts.push({ theme, viewport: width, ...layout });
      await page.screenshot({
        path: `${evidence}/world-${theme}-${width}.png`,
      });
    }
  }
  checks.push(
    "World settings, lossless 64-bit seed copying, game-rule commands, directory opening and page scrolling work in both themes at 375, 768 and 1440px.",
  );
  await back();
  await page.getByRole("tab", { name: /^光影/ }).click();
  await expect(modPagination).toHaveCount(0);
  const shaderRows = page.locator(".local-shader-row");
  await expect(shaderRows).toHaveCount(3);
  await expect(
    shaderRows.locator(".local-resource-error, .catalog-project-copy, img"),
  ).toHaveCount(0);
  await expect(shaderRows.getByText(/Ignored shader/)).toHaveCount(0);
  await expect(shaderRows.nth(2).locator(".local-resource-size")).toHaveText(
    "0 B",
  );
  await search.fill("Ignored shader description");
  await expect(shaderRows).toHaveCount(0);
  await search.fill("");
  await expect(shaderRows).toHaveCount(3);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 960 });
      await page.waitForTimeout(280);
      expect(
        await shaderRows.first().evaluate((element) => element.offsetHeight),
      ).toBe(44);
      expect(
        await shaderRows
          .nth(1)
          .evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
      ).toBe(true);
      await expect
        .poll(() =>
          main.evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: `${evidence}/shaders-${theme}-${width}.png`,
      });
    }
  }
  await shaderRows
    .first()
    .getByRole("button", {
      name: "打开 1.20.1-Fabric Complementary 所在目录",
      exact: true,
    })
    .click();
  expect(await last("path.open")).toMatchObject({
    path: "C:/Pixel-Test/Minecraft/.minecraft/versions/1.20.1-Fabric/shaderpacks/test.zip",
    reveal: true,
  });
  await page.mouse.move(5, 5);
  await expect
    .poll(() =>
      shaderRows
        .first()
        .evaluate((element) => getComputedStyle(element).translate),
    )
    .toBe("none");
  await expect(shaderRows.getByRole("button")).toHaveCount(3);
  await expect(
    shaderRows.locator(".local-shader-info :is(button, a, [tabindex])"),
  ).toHaveCount(0);
  const shaderBreadcrumbs = await breadcrumbs
    .locator("button, strong")
    .allTextContents();
  const folderRequestCount = await page.evaluate(
    () =>
      window.__pixelTest.requests.filter(
        (item) => item.operation === "path.open",
      ).length,
  );
  await shaderRows.first().locator(".local-shader-info").click();
  await expect
    .poll(() =>
      shaderRows
        .first()
        .evaluate((element) => getComputedStyle(element).translate),
    )
    .toBe("0px -2px");
  await expect(details).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(shaderRows).toHaveCount(3);
  await expect(breadcrumbs.locator("button, strong")).toHaveText(
    shaderBreadcrumbs,
  );
  expect(
    await page.evaluate(
      () =>
        window.__pixelTest.requests.filter(
          (item) => item.operation === "path.open",
        ).length,
    ),
  ).toBe(folderRequestCount);
  checks.push(
    "Shader rows only display names and sizes, stay 44px tall at all tested widths and themes, ignore cached metadata/errors, retain hover animation and directory actions, and do not open a dialog or subpage when clicked.",
  );
  await page.getByRole("tab", { name: /^材质包/ }).click();
  await expect(modPagination).toHaveCount(0);
  const packRow = page.locator(".local-compact-row");
  await expect(packRow).toHaveCount(1);
  await expect(packRow.getByRole("button")).toHaveCount(2);
  await expect(
    packRow.locator(".local-resource-title :is(button, a, [tabindex])"),
  ).toHaveCount(0);
  const packBreadcrumbs = await breadcrumbs
    .locator("button, strong")
    .allTextContents();
  await packRow.locator(".local-resource-title").click();
  await expect(details).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(breadcrumbs.locator("button, strong")).toHaveText(
    packBreadcrumbs,
  );
  await expect
    .poll(() =>
      packRow.evaluate((element) => getComputedStyle(element).translate),
    )
    .toBe("0px -2px");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 960 });
      expect(await packRow.evaluate((element) => element.offsetHeight)).toBe(
        width <= 650 ? 72 : 60,
      );
      expect(
        await packRow.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `${evidence}/resourcepack-list-${theme}-${width}.png`,
      });
    }
  }
  await packRow
    .getByRole("button", {
      name: "打开 1.20.1-Fabric Faithful 所在目录",
      exact: true,
    })
    .click();
  expect(await last("path.open")).toMatchObject({
    path: "C:/Pixel-Test/Minecraft/.minecraft/versions/1.20.1-Fabric/resourcepacks/test.zip",
    reveal: true,
  });
  checks.push(
    "Local resource packs stay in a compact 60px/72px list, retain hover animation and directory/deletion actions, and expose no detail button, dialog or subpage.",
  );
  await page
    .getByRole("button", { name: "删除 1.20.1-Fabric Faithful", exact: true })
    .click();
  await answerConfirmation(page, true);
  await expect(
    page.getByRole("heading", { name: "这里还没有资源", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "查看资源的游戏版本", exact: true })
    .click();
  await page.getByRole("option", { name: "1.21.4", exact: true }).click();
  await expect(modPagination.getByRole("status")).toHaveText("第 1 / 1 页");
  await page
    .getByRole("button", { name: "1.21.4 Sodium 详情", exact: true })
    .click();
  await expect(breadcrumbs.locator("button, strong")).toHaveText([
    "",
    "...",
    "1.21.4 Sodium",
  ]);
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.activeVersion),
  ).toBe("1.21.4");
  const versionRequests = await localRequestCount();
  await details
    .getByRole("button", {
      name: "1.21.4 Sodium 的 Modrinth 详情",
      exact: true,
    })
    .click();
  const otherVersionProject = page.locator(
    '[data-page="versions"][data-view="resources"] .resource-subpage',
  );
  await expect(
    otherVersionProject.getByRole("heading", { name: "Sodium", exact: true }),
  ).toBeVisible();
  await otherVersionProject.getByRole("tab", { name: /^可下载版本/ }).click();
  await expect(
    otherVersionProject.getByRole("textbox", { name: "筛选游戏版本" }),
  ).toHaveValue("1.21.4");
  await expect
    .poll(() => last("resources.files"))
    .toMatchObject({
      source: "modrinth",
      id: "AANobbMI",
      gameVersion: "1.21.4",
    });
  await back();
  await expect(
    details.getByRole("heading", { name: "1.21.4 Sodium", exact: true }),
  ).toBeVisible();
  await back();
  await expect(modPagination.getByRole("status")).toHaveText("第 1 / 1 页");
  expect(await localRequestCount()).toBe(versionRequests);
  checks.push(
    "Opening the same channel project from a different local game version initializes the new version's file filters and returns to its list without rescanning.",
  );
  await back();
  await expect(
    page.getByRole("heading", { name: "版本管理", exact: true }),
  ).toBeVisible();
  checks.push(
    "Mods and worlds use subpages while local resource packs and shaders remain in the list; pack deletion, viewed-version switching and two-step return to version management work without changing the launch version.",
  );
  expect(errors).toEqual([]);
  const result = { checks, layouts, errors };
  await writeFile(`${evidence}/checks.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` });
  throw error;
} finally {
  await browser.close();
}
