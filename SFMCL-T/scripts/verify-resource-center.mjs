import { runtimePath } from "./lib/paths.mjs";
import { answerConfirmation } from "./lib/confirmation.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";

const evidence = runtimePath("evidence/resource-center");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(8000);
const errors = [],
  checks = [],
  layouts = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(resourceCenterFixture);
await page.addInitScript(() => {
  const state = window.__pixelTest;
  state.data.settings.gameDirs.push({
    name: "测试目录",
    path: "C:/Pixel-Test/Other",
  });
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "request" && args.operation === "install") {
      state.requests.push(structuredClone(args));
      if (state.failures.install) throw new Error(state.failures.install);
      return "test-install-job";
    }
    if (command === "request" && args.operation === "manifest") {
      const value = await invoke(command, args);
      return state.minecraftVersions
        ? { versions: structuredClone(state.minecraftVersions) }
        : value;
    }
    return invoke(command, args);
  };
});
const nav = (name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const backToList = () =>
  page
    .getByRole("navigation", { name: "页面路径" })
    .getByRole("button", { name: "返回上一级", exact: true })
    .click();
const select = async (name, option) => {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
};
const setCatalogView = async (view) => {
  const projects = page.locator(".catalog-projects");
  const toggle = page.getByRole("button", { name: /^切换为(列表|卡片)视图$/ });
  await expect(toggle).toHaveCount(1);
  if (
    !(await projects.evaluate(
      (element, mode) => element.classList.contains(mode),
      view,
    ))
  )
    await toggle.click();
  await expect(projects).toHaveClass(new RegExp(view));
  await expect(projects.getByRole("button", { name: /^安装 / })).toHaveCount(0);
  await expect(toggle).toHaveAccessibleName(
    view === "list" ? "切换为卡片视图" : "切换为列表视图",
  );
};
const search = async (term) => {
  await page
    .getByRole("searchbox", { name: "搜索资源", exact: true })
    .fill(term);
  await page
    .getByRole("searchbox", { name: "搜索资源", exact: true })
    .press("Enter");
};
const last = (operation) =>
  page.evaluate(
    (op) =>
      window.__pixelTest.requests.findLast(
        (request) => request.operation === op,
      )?.payload,
    operation,
  );
const settled = () =>
  expect(page.locator(".catalog-results")).toHaveAttribute(
    "aria-busy",
    "false",
  );
const showFilters = async () => {
  if (
    !(await page
      .getByRole("textbox", { name: "游戏版本", exact: true })
      .isVisible())
  )
    await page.getByRole("button", { name: /^筛选/ }).click();
};
const screenshot = (name) =>
  page.screenshot({ path: `${evidence}/${name}.png`, animations: "disabled" });
const verifyCatalogReturn = async (tab, trigger) => {
  const requests = () =>
    page.evaluate(
      (minecraft) =>
        window.__pixelTest.requests.filter((request) =>
          [
            minecraft && "manifest",
            "resources.search",
            "resources.categories",
          ].includes(request.operation),
        ),
      tab === "Minecraft",
    );
  await trigger.scrollIntoViewIfNeeded();
  // Clicking can scroll a row above the sticky pagination bar. Capture the
  // position at the actual click, immediately before React opens the child.
  await trigger.evaluate((element) => {
    element.addEventListener(
      "click",
      () => {
        window.__pixelTest.catalogScrollTop =
          element.closest(".page").scrollTop;
      },
      { once: true, capture: true },
    );
  });
  const before = await requests();
  await trigger.click();
  const position = await page.evaluate(
    () => window.__pixelTest.catalogScrollTop,
  );
  await expect(page.locator(".resource-subpage")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".resource-subpage-header h1")).toBeFocused();
  expect(
    await page.locator(".page").evaluate((element) => element.scrollTop),
  ).toBe(0);
  await expect(
    page.getByRole("button", { name: "返回上一级", exact: true }),
  ).toHaveAttribute("data-tooltip", `返回${tab}资源`);
  await backToList();
  await expect(trigger).toBeFocused();
  expect(
    await page.locator(".page").evaluate((element) => element.scrollTop),
  ).toBeCloseTo(position, 0);
  expect(await requests()).toEqual(before);
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await nav("资源中心");
  const resourceTabs = page.getByRole("tablist", { name: "资源中心分类" });
  const installer = page.locator(".minecraft-install");
  const versionTypes = installer.getByRole("tablist", {
    name: "Minecraft 版本类型",
  });
  await expect(versionTypes.getByRole("tab")).toHaveText([
    "正式版",
    "快照版",
    "愚人节",
    "历史版",
    "全部",
  ]);
  await expect(
    installer.locator(
      ".catalog-result-count, .catalog-filter-toggle, .catalog-sort, .catalog-filters, .catalog-active-filters",
    ),
  ).toHaveCount(0);
  await expect(resourceTabs.getByRole("tab")).toHaveText([
    "Minecraft",
    "模组",
    "材质包",
    "光影",
    "数据包",
    "整合包",
  ]);
  await expect(
    resourceTabs.getByRole("tab", { name: "Minecraft", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(installer).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(installer.locator(".catalog-project")).toHaveCount(3);
  await expect(installer.locator(".install-options")).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "版本名称", exact: true }),
  ).toHaveCount(0);
  expect(await last("resources.search")).toBeUndefined();
  expect(await last("resources.categories")).toBeUndefined();
  await page.keyboard.press("Control+k");
  const versionSearch = page.getByRole("searchbox", { name: "搜索可安装版本" });
  await expect(versionSearch).toBeFocused();
  await versionSearch.fill("no-matching-version");
  await expect(
    page.getByRole("heading", { name: "没有找到匹配版本" }),
  ).toBeVisible();
  await versionSearch.press("Escape");
  const installTrigger = page.getByRole("button", {
    name: "查看 Minecraft 1.20.1 安装配置",
    exact: true,
  });
  await installTrigger.click();
  const installPage = page.getByRole("region", {
    name: "安装 Minecraft 1.20.1",
    exact: true,
  });
  await expect(installPage).toBeVisible();
  await expect(
    installPage.getByRole("heading", {
      name: "安装 Minecraft 1.20.1",
      exact: true,
    }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(installPage).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await backToList();
  await expect(installPage).toHaveCount(0);
  await expect(installTrigger).toBeFocused();
  await page
    .getByRole("button", {
      name: "查看 Minecraft 1.20.1 安装配置",
      exact: true,
    })
    .click();
  await expect(installPage).toBeVisible();
  await page
    .getByRole("textbox", { name: "版本名称", exact: true })
    .fill("Minecraft-test");
  await select("安装目录", "测试目录");
  await page.evaluate(() => {
    window.__pixelTest.failures.install = "测试安装失败";
  });
  await page.getByRole("button", { name: "开始安装", exact: true }).click();
  await expect(installPage.getByRole("alert")).toContainText("测试安装失败");
  await expect(installPage).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "版本名称", exact: true }),
  ).toHaveValue("Minecraft-test");
  await page.evaluate(() => {
    delete window.__pixelTest.failures.install;
  });
  await page.getByRole("button", { name: "开始安装", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "下载中心", exact: true }),
  ).toBeVisible();
  expect(await last("install")).toEqual({
    minecraft: "1.20.1",
    name: "Minecraft-test",
    root: "C:/Pixel-Test/Other",
    loader: null,
    optifine: null,
    fabricApi: null,
  });
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.activeDir),
  ).toBe("C:/Pixel-Test/Minecraft");
  const downloadBack = page.getByRole("button", {
    name: "返回上一级",
    exact: true,
  });
  await expect(downloadBack).toHaveAttribute(
    "data-tooltip",
    "返回1.20.1 · 安装配置",
  );
  await downloadBack.click();
  await expect(
    page.getByRole("heading", { name: "安装 Minecraft 1.20.1", exact: true }),
  ).toBeVisible();
  await nav("版本管理");
  await page.getByRole("button", { name: "安装新版本", exact: true }).click();
  await expect(installer).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "资源中心", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "页面路径" })
      .locator("button, strong"),
  ).toHaveText(["Minecraft资源"]);
  checks.push(
    "Minecraft has its own default tab; existing install links navigate here, search works, failures retain configuration, and install submits the selected directory before opening downloads",
  );

  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const [width, height] of [
      [375, 450],
      [768, 600],
      [1024, 768],
      [1440, 900],
    ]) {
      await page.setViewportSize({ width, height });
      for (const view of ["list", "grid"]) {
        await setCatalogView(view);
        await expect(
          installer.locator(`.catalog-projects.${view}`),
        ).toBeVisible();
        // Sidebar and catalog transitions can briefly retain the old width.
        await expect
          .poll(
            () =>
              page
                .locator("main.page")
                .evaluate(
                  (element) => element.scrollWidth <= element.clientWidth + 1,
                ),
            { message: `Minecraft ${theme} ${view} ${width}` },
          )
          .toBe(true);
        await screenshot(`minecraft-${theme}-${view}-${width}`);
        await page
          .getByRole("button", {
            name: "查看 Minecraft 1.20.1 安装配置",
            exact: true,
          })
          .click();
        await installPage
          .getByRole("button", { name: "选择 Fabric", exact: true })
          .click();
        await expect(
          installPage.getByRole("radio", {
            name: "Fabric 0.16.9",
            exact: true,
          }),
        ).toBeEnabled();
        await installPage
          .getByRole("radio", { name: "Fabric 0.16.9", exact: true })
          .click();
        const fit = await installPage.evaluate((section) => {
          const box = section.getBoundingClientRect();
          const body = section.querySelector(".resource-subpage-body");
          return {
            x: box.x,
            right: box.right,
            overflow: body.scrollWidth - body.clientWidth,
          };
        });
        expect(fit.x).toBeGreaterThanOrEqual(0);
        expect(fit.right).toBeLessThanOrEqual(width);
        expect(fit.overflow).toBeLessThanOrEqual(1);
        await installPage
          .getByRole("button", { name: "开始安装", exact: true })
          .scrollIntoViewIfNeeded();
        await expect(
          installPage.getByRole("button", { name: "开始安装", exact: true }),
        ).toBeInViewport();
        await installPage
          .getByRole("combobox", { name: "安装目录", exact: true })
          .click();
        await expect(page.getByRole("listbox")).toBeInViewport();
        await page.keyboard.press("Escape");
        await expect(installPage).toBeVisible();
        await screenshot(`minecraft-subpage-${theme}-${view}-${width}`);
        await page.keyboard.press("Escape");
        await expect(installPage).toBeVisible();
        await backToList();
        await expect(installPage).toHaveCount(0);
        await expect(
          page.getByRole("button", {
            name: "查看 Minecraft 1.20.1 安装配置",
            exact: true,
          }),
        ).toBeFocused();
      }
    }
  }
  await setCatalogView("list");
  await page.evaluate(() => {
    window.__pixelTest.minecraftVersions = [
      ...Array.from({ length: 27 }, (_, index) => ({
        id: `1.test.${index}`,
        type: "release",
        releaseTime: `2026-01-${String(index + 1).padStart(2, "0")}`,
        url: "",
      })),
      { id: "26w01a", type: "snapshot", releaseTime: "2026-02-01", url: "" },
      {
        id: "24w14potato",
        type: "snapshot",
        releaseTime: "2024-04-01",
        url: "",
      },
      { id: "b1.7.3", type: "old_beta", releaseTime: "2011-07-08", url: "" },
    ];
  });
  await resourceTabs.getByRole("tab", { name: "模组", exact: true }).click();
  await resourceTabs
    .getByRole("tab", { name: "Minecraft", exact: true })
    .click();
  await expect(installer.locator(".catalog-project")).toHaveCount(20);
  await expect(installer.locator(".catalog-project h2").first()).toHaveText(
    "1.test.26",
  );
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(installer.locator(".catalog-project")).toHaveCount(7);
  await verifyCatalogReturn(
    "Minecraft",
    installer.locator(".catalog-project-info").last(),
  );
  await expect(installer.locator(".catalog-page-indicator")).toContainText(
    "第 2 / 2 页",
  );
  for (const [type, id] of [
    ["快照版", "26w01a"],
    ["愚人节", "24w14potato"],
    ["历史版", "b1.7.3"],
  ]) {
    await versionTypes.getByRole("tab", { name: type, exact: true }).click();
    await expect(installer.locator(".catalog-project h2")).toHaveText([id]);
    await expect(installer.locator(".catalog-page-indicator")).toContainText(
      "第 1 / 1 页",
    );
  }
  await versionTypes.getByRole("tab", { name: "历史版", exact: true }).focus();
  await page.keyboard.press("End");
  await expect(
    versionTypes.getByRole("tab", { name: "全部", exact: true }),
  ).toBeFocused();
  await expect(installer.getByRole("tabpanel")).toHaveAccessibleName("全部");
  await expect(installer.locator(".catalog-project h2").first()).toHaveText(
    "26w01a",
  );
  await versionSearch.fill("1.test.26");
  await expect(installer.locator(".catalog-project h2")).toHaveText([
    "1.test.26",
  ]);
  await page
    .getByRole("button", {
      name: "查看 Minecraft 1.test.26 安装配置",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("textbox", { name: "版本名称", exact: true }),
  ).toHaveValue("1.test.26");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(versionSearch).toHaveValue("1.test.26");
  await versionSearch.press("Escape");
  await setCatalogView("grid");
  await resourceTabs.getByRole("tab", { name: "模组", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "切换为列表视图", exact: true }),
  ).toBeVisible();
  await setCatalogView("list");
  await page.evaluate(() => {
    delete window.__pixelTest.minecraftVersions;
  });
  await resourceTabs
    .getByRole("tab", { name: "Minecraft", exact: true })
    .click();
  checks.push(
    "Minecraft uses version-type tabs and one view button in both themes; child-page fields, scrolling, dropdowns and return focus work down to 375×450; category changes reset pagination, newest versions appear first, and view preference is shared",
  );
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
    window.__pixelTest.failures.manifest = "测试版本清单获取失败";
  });
  await resourceTabs
    .getByRole("tab", { name: "Minecraft", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    resourceTabs.getByRole("tab", { name: "模组", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(
    resourceTabs.getByRole("tab", { name: "Minecraft", exact: true }),
  ).toBeFocused();
  await expect(installer.getByRole("alert")).toContainText(
    "测试版本清单获取失败",
  );
  await page.evaluate(() => {
    delete window.__pixelTest.failures.manifest;
    window.__pixelTest.delays.manifest = 800;
  });
  await page.getByRole("button", { name: "重新获取列表", exact: true }).click();
  await expect(
    page.getByText("正在获取官方版本清单…", { exact: true }),
  ).toHaveCount(0);
  await expect(installer.locator(".catalog-skeleton")).toHaveCount(6);
  await expect(installer.locator(".catalog-project")).toHaveCount(3);
  await expect(installer.getByRole("alert")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  checks.push(
    "Minecraft category keyboard navigation and version-manifest error retry work without reopening the installation page",
  );
  await page.getByRole("tab", { name: "模组", exact: true }).click();
  await expect(page.locator(".catalog-project")).toHaveCount(20);
  await expect(
    page.getByRole("button", { name: "切换为卡片视图", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "本地资源", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator(".catalog-project")).toHaveCount(7);
  const pageRequest = await last("resources.search");
  const beforeView = await page.evaluate(
    () =>
      window.__pixelTest.requests.filter(
        (r) => r.operation === "resources.search",
      ).length,
  );
  await setCatalogView("grid");
  await expect(page.locator(".catalog-projects")).toHaveClass(/grid/);
  expect(await last("resources.search")).toEqual(pageRequest);
  expect(
    await page.evaluate(
      () =>
        window.__pixelTest.requests.filter(
          (r) => r.operation === "resources.search",
        ).length,
    ),
  ).toBe(beforeView);
  await page.setViewportSize({ width: 1440, height: 600 });
  await verifyCatalogReturn(
    "模组",
    page.locator(".catalog-project-info").last(),
  );
  expect(
    await page.locator(".page").evaluate((element) => element.scrollTop),
  ).toBeGreaterThan(0);
  await expect(page.locator(".catalog-projects")).toHaveClass(/grid/);
  await expect(page.locator(".catalog-page-indicator")).toContainText(
    "第 2 / 2 页",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await settled();
  checks.push(
    "Default popular results, pagination and list/card switching preserve the query and page without extra requests",
  );

  await showFilters();
  await select("加载器", "Fabric");
  await select("分类", "性能优化");
  await page
    .getByRole("textbox", { name: "游戏版本", exact: true })
    .fill("1.20.1");
  await search("Sodium");
  await settled();
  expect(await last("resources.search")).toMatchObject({
    query: "Sodium",
    gameVersion: "1.20.1",
    loader: "Fabric",
    category: "optimization",
    offset: 0,
  });
  await verifyCatalogReturn(
    "模组",
    page.getByRole("button", { name: "查看 Sodium 详情", exact: true }),
  );
  await expect(
    page.getByRole("searchbox", { name: "搜索资源", exact: true }),
  ).toHaveValue("Sodium");
  await expect(
    page.getByRole("textbox", { name: "游戏版本", exact: true }),
  ).toHaveValue("1.20.1");
  await expect(
    page.getByRole("combobox", { name: "加载器", exact: true }),
  ).toContainText("Fabric");
  await expect(
    page.getByRole("combobox", { name: "分类", exact: true }),
  ).toContainText("性能优化");
  checks.push(
    "Resource subpages preserve catalog query, filters, view and page, restore scroll and trigger focus, and do not refetch the catalog on return",
  );
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.getByRole("button", { name: /^筛选/ }).click();
  await expect(
    page.getByRole("textbox", { name: "游戏版本", exact: true }),
  ).toHaveValue("1.20.1");
  await page
    .getByRole("textbox", { name: "游戏版本", exact: true })
    .press("Escape");
  await expect(
    page.getByRole("textbox", { name: "游戏版本", exact: true }),
  ).not.toBeVisible();
  await expect(page.getByRole("button", { name: /^筛选/ })).toBeFocused();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(
    page.getByRole("textbox", { name: "游戏版本", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "切换为列表视图", exact: true }),
  ).toBeVisible();
  await select("资源来源", "CurseForge");
  await settled();
  expect(await last("resources.search")).toMatchObject({
    source: "curseforge",
    category: "",
  });
  await page.getByRole("tab", { name: "光影", exact: true }).click();
  await settled();
  expect(await last("resources.search")).toMatchObject({
    kind: "shader",
    loader: "",
    category: "",
  });
  await expect(
    page.getByRole("combobox", { name: "加载器", exact: true }),
  ).toHaveCount(0);
  await select("资源排序", "最近更新");
  await settled();
  expect(await last("resources.search")).toMatchObject({ sort: "updated" });
  await page
    .getByRole("button", { name: "查看 Sodium 详情", exact: true })
    .click();
  await page.getByRole("tab", { name: /^可下载版本/ }).click();
  await expect(
    page.getByRole("combobox", { name: "筛选加载器" }),
  ).toBeDisabled();
  expect(await last("resources.files")).toMatchObject({
    source: "curseforge",
    loader: "",
  });
  await backToList();
  await page.getByRole("button", { name: /^移除版本筛选/ }).click();
  await settled();
  expect(await last("resources.search")).toMatchObject({ gameVersion: "" });
  checks.push(
    "Filters survive narrow/wide transitions; Escape restores focus; source/category and resource-kind/loader reset together; sorting applies immediately",
  );

  await search("nothing-matches");
  await expect(
    page.getByRole("heading", { name: "没有找到匹配资源" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "浏览全部光影" }).click();
  await settled();
  await page.evaluate(() => {
    window.__pixelTest.resources.failNext = true;
  });
  await search("Sodium");
  await expect(
    page.getByRole("heading", { name: "暂时无法获取资源" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sodium", exact: true }),
  ).toBeVisible();
  await search("slow");
  await search("Lithium");
  await settled();
  await page.waitForTimeout(800);
  await expect(
    page.getByRole("heading", { name: "Lithium", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "旧请求结果" })).toHaveCount(
    0,
  );
  await page.keyboard.press("Control+k");
  await expect(
    page.getByRole("searchbox", { name: "搜索资源", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await settled();
  checks.push(
    "Empty state, clear filters, network retry, stale response protection, Ctrl+K and Escape verified",
  );

  await select("资源来源", "Modrinth");
  await page.getByRole("tab", { name: "模组", exact: true }).click();
  await select("资源排序", "推荐排序");
  await settled();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [375, 768, 1024, 1440, 1600]) {
      await page.setViewportSize({ width, height: 960 });
      for (const view of ["list", "grid"]) {
        await setCatalogView(view);
        const layout = await page.evaluate(() => {
          const center = document.querySelector(".resource-center");
          const main = document.querySelector("main.page");
          const filters = document.querySelector(".catalog-filters");
          const results = document.querySelector(".catalog-results");
          return {
            width: innerWidth,
            contentWidth: center.clientWidth,
            overflow:
              main.scrollWidth > main.clientWidth + 1 ||
              document.documentElement.scrollWidth > innerWidth,
            sidebar:
              getComputedStyle(filters).display !== "none" &&
              filters.getBoundingClientRect().right <
                results.getBoundingClientRect().left,
          };
        });
        expect(layout.overflow, `${theme} ${width} ${view}`).toBe(false);
        expect(layout.sidebar).toBe(layout.contentWidth >= 1100);
        layouts.push({ theme, view, ...layout });
        if ([375, 1024, 1440].includes(width))
          await screenshot(`${theme}-${width}-${view}`);
      }
    }
  }
  await page.setViewportSize({ width: 1300, height: 960 });
  await expect(page.getByRole("button", { name: /^筛选/ })).toBeVisible();
  await page.locator(".brand-logo").hover();
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await expect(page.getByRole("button", { name: /^筛选/ })).not.toBeVisible();
  await page.locator(".brand-logo").hover();
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  checks.push(
    "20 light/dark responsive layouts have no horizontal overflow; the 1100px content breakpoint responds to application sidebar collapse",
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", { name: "查看 Sodium 详情", exact: true })
    .click();
  await page.getByRole("tab", { name: /^可下载版本/ }).click();
  await expect(page.getByRole("tab", { name: /^可下载版本/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByRole("combobox", { name: "安装目标版本" }),
  ).toHaveCount(0);
  await page.getByRole("textbox", { name: "筛选游戏版本" }).fill("1.20.1");
  await select("筛选加载器", "Fabric");
  await expect(page.locator(".project-file")).toHaveCount(1);
  await expect(page.locator(".project-file")).toContainText("1.20.1");
  const fileResults = page.locator("#project-file-results");
  const fileView = page.getByRole("button", {
    name: /^切换为(列表|卡片)视图$/,
  });
  const fileRequestCount = () =>
    page.evaluate(
      () =>
        window.__pixelTest.requests.filter(
          (request) => request.operation === "resources.files",
        ).length,
    );
  const beforeViewChange = await fileRequestCount();
  await expect(fileResults).toHaveClass(/grid/);
  await expect(fileView).toHaveAttribute(
    "aria-controls",
    "project-file-results",
  );
  await expect(fileResults.locator(".button")).toHaveCount(0);
  await fileView.click();
  await expect(fileResults).toHaveClass(/list/);
  await fileView.press("Enter");
  await expect(fileResults).toHaveClass(/grid/);
  expect(await fileRequestCount()).toBe(beforeViewChange);
  expect(await last("resources.files")).toMatchObject({
    gameVersion: "1.20.1",
    loader: "Fabric",
  });
  await screenshot("file-filters");
  await select("筛选加载器", "NeoForge");
  await expect(
    page.getByRole("heading", { name: "未找到兼容文件" }),
  ).toBeVisible();
  await select("筛选加载器", "Fabric");
  const fileDownload = page.locator("button.project-file");
  const dialog = page.getByRole("dialog", { name: "下载 Sodium", exact: true });
  const submitDownload = dialog.getByRole("button", {
    name: "开始下载",
    exact: true,
  });
  const downloadCount = () =>
    page.evaluate(
      () =>
        window.__pixelTest.requests.filter(
          (request) => request.operation === "resources.download",
        ).length,
    );
  const beforeDownload = await downloadCount();
  await fileDownload.focus();
  await fileDownload.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "本地游戏版本" }),
  ).toContainText("1.20.1-Fabric");
  expect(await downloadCount()).toBe(beforeDownload);
  await dialog.getByRole("combobox", { name: "本地游戏版本" }).click();
  await expect(
    page.getByRole("option", { name: "1.21.4", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("option", { name: "选择兼容版本", exact: true }).click();
  await expect(submitDownload).toBeDisabled();
  await expect(dialog).toContainText("请选择一个兼容的本地游戏版本");
  await select("本地游戏版本", "1.20.1-Fabric");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await downloadCount()).toBe(beforeDownload);
  await expect(fileDownload).toBeFocused();

  await fileDownload.press("Space");
  await page.evaluate(() => {
    window.__pixelTest.failures["resources.download"] = "测试下载失败，请重试";
  });
  await submitDownload.click();
  await expect(dialog.getByRole("alert")).toContainText("测试下载失败，请重试");
  await expect(submitDownload).toBeEnabled();
  await page.evaluate(() => {
    delete window.__pixelTest.failures["resources.download"];
  });
  await screenshot("download-version");
  await submitDownload.click();
  await expect(dialog).toHaveCount(0);
  expect(await last("resources.download")).toMatchObject({
    versionId: "1.20.1-Fabric",
    kind: "mod",
  });
  expect(await last("resources.download")).not.toHaveProperty("directory");
  await fileDownload.click();
  await expect(
    dialog.getByRole("button", { name: "已加入队列" }),
  ).toBeDisabled();
  await dialog.getByRole("tab", { name: "下载到文件夹", exact: true }).click();
  await expect(submitDownload).toBeDisabled();
  await dialog.getByRole("button", { name: "选择文件夹", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "下载文件夹" })).toHaveValue(
    "",
  );
  await expect(submitDownload).toBeDisabled();
  await page.evaluate(() => {
    window.__pixelTest.resources.selectedDirectory = "C:/Pixel-Test/单独下载";
  });
  await dialog.getByRole("button", { name: "选择文件夹", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "下载文件夹" })).toHaveValue(
    "C:/Pixel-Test/单独下载",
  );
  expect(await last("plugin:dialog|open")).toMatchObject({
    options: { directory: true, multiple: false },
  });
  await expect(submitDownload).toBeEnabled();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(dialog).toBeInViewport();
      await expect(submitDownload).toBeInViewport();
      await expect
        .poll(() =>
          dialog.evaluate(
            (element) =>
              element.scrollWidth <= element.clientWidth + 1 &&
              document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
      await screenshot(`download-folder-${theme}-${width}`);
    }
  }
  await submitDownload.click();
  await expect(dialog).toHaveCount(0);
  expect(await last("resources.download")).toMatchObject({
    directory: "C:/Pixel-Test/单独下载",
    kind: "mod",
    file: { path: "test-0.jar" },
  });
  expect(await last("resources.download")).not.toHaveProperty("versionId");
  await fileDownload.click();
  await dialog.getByRole("tab", { name: "下载到文件夹", exact: true }).click();
  await dialog.getByRole("button", { name: "选择文件夹", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "已加入队列" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.getByRole("textbox", { name: "筛选游戏版本" }).fill("1.21.4");
  await select("筛选加载器", "NeoForge");
  await fileDownload.click();
  await expect(
    dialog.getByRole("tab", { name: "下载到文件夹", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await dialog.getByRole("tab", { name: "安装到游戏", exact: true }).click();
  await expect(
    dialog.getByRole("combobox", { name: "本地游戏版本" }),
  ).toBeDisabled();
  await expect(submitDownload).toBeDisabled();
  await expect(dialog).toContainText("没有兼容的本地游戏版本");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("textbox", { name: "筛选游戏版本" }).fill("");
  await select("筛选加载器", "全部加载器");
  await expect(page.locator(".project-file")).toHaveCount(3);
  expect(await last("resources.files")).toMatchObject({
    gameVersion: "",
    loader: "",
  });
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.activeVersion),
  ).toBe("1.21.4");
  await backToList();
  await expect(
    page.getByRole("button", { name: "查看 Sodium 详情", exact: true }),
  ).toBeFocused();
  await page.reload();
  await nav("资源中心");
  await page.getByRole("tab", { name: "模组", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "切换为列表视图", exact: true }),
  ).toBeVisible();
  checks.push(
    "Version/loader filters are independent of the launch version; download dialog supports compatible local installs and direct folder downloads, cancel, retry, duplicate prevention, no-compatible-version fallback and six responsive/theme layouts; view choice persists on reload",
  );

  await page.getByRole("tab", { name: "数据包", exact: true }).click();
  await settled();
  await expect(
    page.getByRole("searchbox", { name: "搜索资源" }),
  ).toHaveAttribute("placeholder", "搜索数据包…");
  await expect(
    page.getByRole("navigation", { name: "页面路径" }),
  ).toContainText("数据包资源");
  expect(await last("resources.search")).toMatchObject({
    kind: "datapack",
    loader: "",
  });
  expect(await last("resources.categories")).toMatchObject({
    kind: "datapack",
  });
  for (const source of ["CurseForge", "Modrinth"]) {
    await select("资源来源", source);
    await settled();
    expect(await last("resources.search")).toMatchObject({
      kind: "datapack",
      source: source.toLowerCase(),
    });
    await page
      .getByRole("button", { name: "查看 Sodium 详情", exact: true })
      .click();
    await page.getByRole("tab", { name: /^可下载版本/ }).click();
    await expect(page.locator(".project-file")).toHaveCount(3);
    expect(await last("resources.files")).toMatchObject({ loader: "datapack" });
    await expect(
      page.getByRole("combobox", { name: "筛选加载器" }),
    ).toHaveCount(0);
    await page.getByRole("textbox", { name: "筛选游戏版本" }).fill("1.20.1");
    await expect(page.locator(".project-file")).toHaveCount(1);
    expect(await last("resources.files")).toMatchObject({
      gameVersion: "1.20.1",
      loader: "datapack",
    });
    await page.locator("button.project-file").press("Enter");
    await expect(dialog.getByRole("tab")).toHaveText(["下载到文件夹"]);
    await expect(
      dialog.getByRole("combobox", { name: "本地游戏版本" }),
    ).toHaveCount(0);
    await expect(dialog).toContainText("存档的 datapacks 文件夹");
    await expect(submitDownload).toBeDisabled();
    await page.evaluate(() => {
      window.__pixelTest.resources.selectedDirectory = null;
    });
    await dialog
      .getByRole("button", { name: "选择文件夹", exact: true })
      .click();
    await expect(submitDownload).toBeDisabled();
    await page.evaluate(() => {
      window.__pixelTest.resources.selectedDirectory =
        "C:/Pixel-Test/世界/datapacks";
      window.__pixelTest.failures["resources.download"] = "测试数据包下载失败";
    });
    await dialog
      .getByRole("button", { name: "选择文件夹", exact: true })
      .click();
    await submitDownload.click();
    await expect(dialog.getByRole("alert")).toContainText("测试数据包下载失败");
    await expect(submitDownload).toBeEnabled();
    await page.evaluate(() => {
      delete window.__pixelTest.failures["resources.download"];
    });
    await dialog.getByRole("button", { name: "关闭错误提示" }).click();
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      await expect
        .poll(() =>
          dialog.evaluate(
            (element) =>
              element.scrollWidth <= element.clientWidth + 1 &&
              document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
      await screenshot(`datapack-download-${source}-${width}`);
    }
    await submitDownload.click();
    await expect(dialog).toHaveCount(0);
    expect(await last("resources.download")).toMatchObject({
      kind: "datapack",
      directory: "C:/Pixel-Test/世界/datapacks",
      file: { path: "test-0.zip" },
    });
    expect(await last("resources.download")).not.toHaveProperty("versionId");
    await page.locator("button.project-file").click();
    await dialog
      .getByRole("button", { name: "选择文件夹", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "已加入队列" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("button.project-file")).toBeFocused();
    await backToList();
    await settled();
  }
  checks.push(
    "Datapack browsing supports both sources and game-version filtering, requests only datapack files, downloads ZIPs to a chosen folder, explains the world directory, and handles cancel, failure/retry, duplicates and narrow layouts",
  );

  await page.evaluate(() => {
    window.__pixelTest.resources.datapackDependency = true;
  });
  await page.getByRole("tab", { name: "模组", exact: true }).click();
  await settled();
  await page
    .getByRole("button", { name: "查看 Sodium 详情", exact: true })
    .click();
  await page.getByRole("tab", { name: /^可下载版本/ }).click();
  await select("筛选加载器", "Fabric");
  await page.locator("button.project-file").first().click();
  await expect(dialog.getByRole("region", { name: "前置资源" })).toContainText(
    "前置数据包",
  );
  await dialog
    .getByRole("button", { name: "查看 Sodium 资源页面", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => last("resources.files"))
    .toMatchObject({ loader: "datapack" });
  await expect(page.getByRole("combobox", { name: "筛选加载器" })).toHaveCount(
    0,
  );
  await expect(page.locator("button.project-file")).toHaveCount(1);
  await page.locator("button.project-file").click();
  await expect(dialog.getByRole("tab")).toHaveText(["下载到文件夹"]);
  await page.keyboard.press("Escape");
  await backToList();
  await expect(
    page.getByRole("combobox", { name: "筛选加载器" }),
  ).toBeVisible();
  expect(await last("resources.files")).toMatchObject({ loader: "Fabric" });
  await backToList();
  checks.push(
    "Datapack dependencies open their resource page with datapack file filtering, including projects providing both mod and datapack formats; returning restores the parent mod file filters",
  );

  await nav("版本管理");
  await page
    .getByRole("button", { name: "查看 1.20.1-Fabric 本地资源", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "1.20.1-Fabric Sodium" }),
  ).toBeVisible();
  expect(await last("resources.local")).toMatchObject({
    versionId: "1.20.1-Fabric",
  });
  await page
    .getByRole("button", { name: "禁用 1.20.1-Fabric Sodium", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "启用 1.20.1-Fabric Sodium",
      exact: true,
    }),
  ).toBeVisible();
  expect(await last("resources.toggle")).toMatchObject({
    versionId: "1.20.1-Fabric",
    disabled: true,
  });
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.activeVersion),
  ).toBe("1.21.4");
  await page
    .getByRole("button", { name: "启用 1.20.1-Fabric Sodium", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "禁用 1.20.1-Fabric Sodium",
      exact: true,
    }),
  ).toBeVisible();
  await screenshot("local-resources");
  await page.getByRole("tab", { name: /^存档/ }).click();
  await page.getByRole("button", { name: /^1.20.1-Fabric 我的世界/ }).click();
  await expect(page.locator(".local-resource-page")).toContainText(
    "9223372036854775807",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await backToList();
  await page.getByRole("tab", { name: /^材质包/ }).click();
  await page
    .getByRole("button", { name: "删除 1.20.1-Fabric Faithful", exact: true })
    .click();
  await answerConfirmation(page, true);
  await expect(
    page.getByRole("heading", { name: "这里还没有资源" }),
  ).toBeVisible();
  expect(await last("resources.deletePack")).toMatchObject({
    versionId: "1.20.1-Fabric",
  });
  await select("查看资源的游戏版本", "1.21.4");
  await expect(
    page.getByRole("heading", { name: "1.21.4 Sodium" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "打开目录", exact: true }).click();
  expect(await last("path.open")).toMatchObject({
    path: "C:/Pixel-Test/Minecraft/.minecraft/versions/1.21.4/mods",
  });
  await page.setViewportSize({ width: 375, height: 960 });
  // The responsive sidebar and tab indicator settle after the viewport resize.
  await expect
    .poll(() =>
      page
        .locator("main.page")
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    )
    .toBe(true);
  await screenshot("local-mobile");
  const localTitle = await page.locator(".local-resource-title").boundingBox();
  const localActions = await page
    .locator(".resource-row .row-actions")
    .boundingBox();
  expect(localTitle.width).toBeGreaterThan(150);
  expect(localActions.y).toBeGreaterThanOrEqual(
    localTitle.y + localTitle.height,
  );
  checks.push(
    "Local resource migration covers per-version listing/counts, enable/disable, pack deletion, world detail, directories and mobile layout without changing the active launch version",
  );
  expect(errors).toEqual([]);
  const result = { checks, layouts, errors };
  await writeFile(`${evidence}/checks.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await screenshot("failure");
  throw error;
} finally {
  await browser.close();
}
