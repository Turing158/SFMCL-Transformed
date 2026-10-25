import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { runtimePath } from "./lib/paths.mjs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";

const evidence = runtimePath("evidence/resource-file-tags");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 960 },
  hasTouch: true,
});
page.setDefaultTimeout(8000);
const errors = [];
const layouts = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(resourceCenterFixture);
await page.addInitScript(() => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (
      command === "request" &&
      args.operation === "resources.detail" &&
      args.payload.id.startsWith("dep-")
    ) {
      const project = await invoke(command, {
        ...args,
        payload: { ...args.payload, id: "project-0" },
      });
      return {
        ...project,
        id: args.payload.id,
        title: {
          "dep-mod": "Fabric API",
          "dep-searchables": "Searchables",
          "dep-pack": "Faithful",
          "dep-shader": "Complementary",
          "dep-unknown": "未识别前置",
        }[args.payload.id],
        website: `https://example.com/${args.payload.id}`,
      };
    }
    if (command === "plugin:opener|open_url") {
      (window.__pixelTest.openedDependencyPages ??= []).push(args.url);
      return;
    }
    const result = await invoke(command, args);
    if (command !== "request" || args.operation !== "resources.files")
      return result;
    const first = result[0];
    return [
      {
        ...first,
        name: "Sodium · 通用兼容版本",
        dependencies: [
          {
            projectId: "dep-mod",
            versionId: null,
            name: "Fabric API",
            kind: "mod",
          },
          {
            projectId: "dep-pack",
            versionId: null,
            name: "Faithful",
            kind: "resourcepack",
          },
          {
            projectId: "dep-shader",
            versionId: null,
            name: "Complementary",
            kind: "shader",
          },
          {
            projectId: "dep-searchables",
            versionId: null,
            name: "Searchables",
            kind: "mod",
          },
        ],
        loaders: ["fabric", "quilt", "minecraft", "Fabric"],
        gameVersions: [
          ...Array.from({ length: 22 }, (_, index) => `1.21.${22 - index}`),
          "1.20.6",
          "1.20.4",
          "1.20.1",
          "1.20.1",
        ],
      },
      {
        ...first,
        id: "short",
        name: "Sodium · 精简兼容版本",
        loaders: ["minecraft"],
        gameVersions: ["1.21.4", "1.20.1"],
      },
      {
        ...first,
        id: "unavailable",
        name: "Sodium · 历史版本",
        dependencies: [
          {
            projectId: "private-project-id",
            versionId: null,
            name: null,
            kind: "unknown",
          },
        ],
        file: undefined,
        loaders: [],
        gameVersions: Array.from({ length: 150 }, (_, index) => `25w${index}a`),
      },
      {
        ...first,
        id: "long-tag",
        name: "Sodium · 超长快照版本",
        dependencies: [
          {
            projectId: "long-dependency",
            versionId: null,
            name: "VeryLongDependencyName".repeat(12),
            kind: "mod",
          },
        ],
        loaders: [],
        gameVersions: [
          "snapshot-with-an-extremely-long-version-name-".repeat(8),
        ],
      },
      {
        ...first,
        id: "empty",
        name: "Sodium · 未提供版本",
        dependencies: [
          {
            projectId: null,
            versionId: "unresolved-version",
            name: null,
            kind: "unknown",
          },
          {
            projectId: null,
            versionId: null,
            name: "local-library.jar",
            kind: "unknown",
          },
          {
            projectId: "dep-unknown",
            versionId: null,
            name: "未识别前置",
            kind: "unknown",
          },
        ],
        loaders: [],
        gameVersions: [],
      },
    ];
  };
});

const rows = page.locator(".project-file");
const first = rows.nth(0);
const tags = first.locator(".catalog-tags");
const tooltip = page.getByRole("tooltip");
const view = async (mode) => {
  const results = page.locator("#project-file-results");
  if (
    !(await results.evaluate((el, value) => el.classList.contains(value), mode))
  )
    await page.getByRole("button", { name: /^切换为(列表|卡片)视图$/ }).click();
};
const fileRequests = () =>
  page.evaluate(
    () =>
      window.__pixelTest.requests.filter(
        (request) => request.operation === "resources.files",
      ).length,
  );
const checkLayout = async () => {
  const result = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".project-file-tag-row")];
    return {
      overflow:
        document.querySelector("main.page").scrollWidth >
        document.querySelector("main.page").clientWidth + 1,
      rows: rows.map((row) => {
        const line = row.querySelector(".catalog-tags");
        const badges = [...line.children].map((badge) =>
          badge.getBoundingClientRect(),
        );
        const bounds = row.getBoundingClientRect();
        return {
          singleLine: badges.every(
            (rect) => Math.abs(rect.top - badges[0].top) < 1,
          ),
          complete: badges.every(
            (rect) =>
              rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1,
          ),
          last: line.lastElementChild?.textContent,
          overflow: row.dataset.overflow === "true",
        };
      }),
    };
  });
  expect(result.overflow).toBe(false);
  for (const row of result.rows) {
    expect(row.singleLine).toBe(true);
    expect(row.complete).toBe(true);
    if (row.overflow) expect(row.last).toBe("+");
  }
  return result;
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "资源中心", exact: true })
    .click();
  await page.getByRole("tab", { name: "模组", exact: true }).click();
  await page
    .getByRole("button", { name: "查看 Sodium 详情", exact: true })
    .click();
  await page.getByRole("tab", { name: /^可下载版本/ }).click();
  await expect(rows).toHaveCount(5);
  const before = await fileRequests();
  await expect(page.locator(".project-file-title .badge")).toHaveCount(0);
  expect(
    (await rows.locator(".catalog-tags").allTextContents()).every(
      (text) => !text.includes("Minecraft"),
    ),
  ).toBe(true);
  await expect(rows.nth(4).locator(".project-file-tag-row")).toHaveCount(0);
  await expect(first).toHaveAccessibleDescription(/1\.20\.1/);
  await expect(first.locator(".project-file-dependencies")).toHaveText(
    "前置模组：Fabric API；前置材质包：Faithful；前置光影：Complementary；前置模组：Searchables",
  );
  await expect(first).toHaveAccessibleDescription(/前置模组：Fabric API/);
  await expect(rows.nth(1).locator(".project-file-dependencies")).toHaveCount(
    0,
  );
  await expect(rows.nth(2).locator(".project-file-dependencies")).toHaveText(
    "前置未知类型：名称暂不可用",
  );
  expect(
    await rows.locator(".project-file-dependencies").allTextContents(),
  ).not.toEqual(
    expect.arrayContaining([
      expect.stringMatching(/dep-mod|dep-pack|private-project-id|[（）]/),
    ]),
  );

  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => (document.documentElement.dataset.theme = value),
      theme,
    );
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      for (const mode of ["list", "grid"]) {
        await view(mode);
        await expect(tags.locator(".project-file-more")).toBeVisible();
        await expect
          .poll(async () => {
            try {
              await checkLayout();
              return true;
            } catch {
              return false;
            }
          })
          .toBe(true);
        layouts.push({ theme, width, mode, ...(await checkLayout()) });
        await tags.hover();
        await expect(tooltip).toBeVisible();
        await expect(tooltip.locator(".badge")).toHaveCount(27);
        await expect(tooltip).toContainText("1.20.1");
        const box = await tooltip.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(11);
        expect(box.x + box.width).toBeLessThanOrEqual(width - 11);
        expect(box.y).toBeGreaterThanOrEqual(11);
        expect(box.y + box.height).toBeLessThanOrEqual(949);
        if ([375, 1440].includes(width))
          await page.screenshot({
            path: `${evidence}/${theme}-${width}-${mode}.png`,
            animations: "disabled",
          });
        await tooltip.hover();
        await expect(tooltip).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(tooltip).toHaveCount(0);
      }
    }
  }
  await view("list");
  await expect(
    rows.nth(1).locator(".project-file-more").filter({ visible: true }),
  ).toHaveCount(0);
  // A forced narrow item followed by expansion must restore all short tags.
  await rows.nth(1).evaluate((el) => (el.style.width = "150px"));
  await expect(
    rows.nth(1).locator(".catalog-tags .project-file-more"),
  ).toBeVisible();
  await rows.nth(1).evaluate((el) => (el.style.width = ""));
  await expect(
    rows.nth(1).locator(".catalog-tags .project-file-more"),
  ).toHaveCount(0);
  expect(await fileRequests()).toBe(before);

  await page.locator(".project-heading").hover();
  await first.focus();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await first.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "下载 Sodium", exact: true }),
  ).toBeVisible();
  await expect(tooltip).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(first).toBeFocused();

  await rows.nth(2).locator(".catalog-tags").hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator(".badge")).toHaveCount(150);
  await expect(rows.nth(2)).toBeDisabled();
  const allVersions = tooltip.locator(".project-file-tooltip-tags");
  expect(
    await allVersions.evaluate((el) => el.scrollHeight > el.clientHeight),
  ).toBe(true);
  await allVersions.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(tooltip.getByText("25w149a", { exact: true })).toBeInViewport();
  await page.keyboard.press("Escape");

  await rows.nth(3).locator(".catalog-tags").hover();
  await expect(tooltip).toBeVisible();
  expect(await tooltip.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.keyboard.press("Escape");
  await first.locator(".catalog-tags").tap();
  await expect(tooltip).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await first.locator(".project-file-title").tap();
  await expect(
    page.getByRole("dialog", { name: "下载 Sodium", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await first.evaluate((el) => el.blur());
  await page.locator(".project-heading").hover();
  await expect(tooltip).toHaveCount(0);

  const dialog = page.getByRole("dialog");
  const dependencies = dialog.getByRole("region", { name: "前置资源" });
  const downloads = () =>
    page.evaluate(
      () =>
        window.__pixelTest.requests.filter(
          (request) => request.operation === "resources.download",
        ).length,
    );
  const beforeDependencies = await downloads();
  const openSodium = async (source = "Modrinth") => {
    const tab = page.getByRole("tab", { name: "模组", exact: true });
    if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
    await page.getByRole("combobox", { name: "资源来源" }).click();
    await page.getByRole("option", { name: source, exact: true }).click();
    await page
      .getByRole("button", { name: "查看 Sodium 详情", exact: true })
      .click();
    await page.getByRole("tab", { name: /^可下载版本/ }).click();
    await expect(rows).toHaveCount(5);
  };
  const backToCatalog = () =>
    page
      .getByRole("navigation", { name: "页面路径" })
      .getByRole("button", { name: "返回上一级", exact: true })
      .click();
  const returnToSodium = async () => {
    const back = page.getByRole("button", {
      name: "返回上一级",
      exact: true,
    });
    await expect(back).toHaveAttribute("data-tooltip", "返回Sodium");
    await back.click();
    await expect(page.locator(".resource-subpage-header h1")).toHaveText(
      "Sodium",
    );
    await expect(
      page.getByRole("tab", { name: /^可下载版本/ }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("textbox", { name: "筛选游戏版本" }),
    ).toHaveValue("");
    await expect(
      page.getByRole("combobox", { name: "筛选加载器" }),
    ).toContainText("全部加载器");
    await expect(back).toHaveAttribute("data-tooltip", "返回模组资源");
    await expect(rows).toHaveCount(5);
  };
  await first.click();
  await expect(dependencies.getByRole("listitem")).toHaveCount(4);
  await expect(dependencies.getByRole("list")).toHaveCount(3);
  const modDependencies = dependencies.getByRole("list", { name: "前置模组" });
  await expect(modDependencies.getByRole("listitem")).toHaveCount(2);
  await expect(dependencies.getByText("前置模组", { exact: true })).toHaveCount(
    1,
  );
  await expect(
    modDependencies.locator(".resource-dependency-label"),
  ).toHaveText(["Fabric API", "Searchables"]);
  await expect(dependencies.getByText("查看资源", { exact: true })).toHaveCount(
    0,
  );
  await expect(modDependencies.getByRole("button")).toHaveCount(2);
  await dialog.screenshot({
    path: `${evidence}/grouped-dependencies.png`,
    animations: "disabled",
  });
  await modDependencies
    .getByRole("button", { name: "查看 Searchables 资源页面", exact: true })
    .click();
  await expect(page.locator(".resource-subpage-header h1")).toHaveText(
    "Searchables",
  );
  await returnToSodium();
  await first.click();
  await expect(dependencies).toContainText("Fabric API");
  await expect(dependencies).toContainText("前置材质包");
  await expect(dependencies).toContainText("前置光影");
  await page.evaluate(() => {
    window.__pixelTest.failures["resources.detail"] = "测试前置页面加载失败";
    window.__pixelTest.delays["resources.detail"] = 400;
  });
  const openMod = dependencies.getByRole("button", {
    name: "查看 Fabric API 资源页面",
    exact: true,
  });
  await openMod.click();
  await expect(openMod).toBeDisabled();
  await expect(openMod).toHaveText("Fabric API");
  await expect(openMod).toHaveAttribute("aria-busy", "true");
  await expect(openMod.locator(".resource-dependency-loading > svg")).toHaveCSS(
    "animation-name",
    "spin",
  );
  await expect(dialog.getByRole("alert")).toContainText("测试前置页面加载失败");
  await expect(openMod).toBeEnabled();
  await page.evaluate(() => {
    delete window.__pixelTest.failures["resources.detail"];
    delete window.__pixelTest.delays["resources.detail"];
  });
  await openMod.focus();
  await openMod.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".resource-subpage-header h1")).toHaveText(
    "Fabric API",
  );
  await expect(page.locator(".resource-subpage-header h1")).toBeFocused();
  await expect(page.getByRole("tab", { name: /^可下载版本/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("textbox", { name: "筛选游戏版本" })).toHaveValue(
    "1.20.1",
  );
  await expect(
    page.getByRole("combobox", { name: "筛选加载器" }),
  ).toContainText("Fabric");
  await first.click();
  await dependencies
    .getByRole("button", { name: "查看 Faithful 资源页面", exact: true })
    .click();
  await expect(page.locator(".resource-subpage-header h1")).toHaveText(
    "Faithful",
  );
  await expect(
    page.getByRole("button", { name: "返回上一级", exact: true }),
  ).toHaveAttribute("data-tooltip", "返回Fabric API");
  await backToCatalog();
  await expect(page.locator(".resource-subpage-header h1")).toHaveText(
    "Fabric API",
  );
  await expect(page.getByRole("textbox", { name: "筛选游戏版本" })).toHaveValue(
    "1.20.1",
  );
  await expect(
    page.getByRole("combobox", { name: "筛选加载器" }),
  ).toContainText("Fabric");
  await returnToSodium();

  for (const name of ["Faithful", "Complementary"]) {
    await first.click();
    await dependencies
      .getByRole("button", { name: `查看 ${name} 资源页面`, exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".resource-subpage-header h1")).toHaveText(name);
    await expect(
      page.getByRole("button", { name: "返回上一级", exact: true }),
    ).toHaveAttribute("data-tooltip", "返回Sodium");
    await expect(
      page.getByRole("combobox", { name: "筛选加载器" }),
    ).toContainText("全部加载器");
    await returnToSodium();
  }

  await backToCatalog();
  await openSodium("CurseForge");
  await first.click();
  await dependencies
    .getByRole("button", { name: "查看 Fabric API 资源页面", exact: true })
    .click();
  await expect(page.locator(".resource-subpage-header h1")).toHaveText(
    "Fabric API",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__pixelTest.requests
            .filter((request) => request.operation === "resources.files")
            .at(-1)?.payload,
      ),
    )
    .toMatchObject({
      source: "curseforge",
      id: "dep-mod",
      loader: "Fabric",
      gameVersion: "1.20.1",
    });
  await returnToSodium();

  await backToCatalog();
  await openSodium();
  await rows.nth(1).click();
  await expect(dependencies).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await rows.nth(4).click();
  await expect(dependencies.getByRole("button")).toHaveCount(3);
  await expect(dependencies.locator("button:disabled")).toHaveCount(2);
  await expect(
    dependencies.locator('button:disabled[data-tooltip="暂时无法获取对应资源页面"]'),
  ).toHaveCount(2);
  await dependencies
    .getByRole("button", { name: "查看 未识别前置 资源页面", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__pixelTest.openedDependencyPages))
    .toEqual(["https://example.com/dep-unknown"]);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await rows.nth(3).click();
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => (document.documentElement.dataset.theme = value),
      theme,
    );
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      await expect
        .poll(() =>
          dialog.evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
        )
        .toBe(true);
      await expect(dependencies.getByRole("button")).toBeInViewport();
      await page.screenshot({
        path: `${evidence}/dependency-dialog-${theme}-${width}.png`,
        animations: "disabled",
      });
    }
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await downloads()).toBe(beforeDependencies);
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ layouts, errors }, null, 2),
  );
  console.log(
    `Passed ${layouts.length} theme/viewport/view layouts, complete-tag overflow, tooltip contents and bounds, resizing, keyboard, downloads, unavailable files, long tags, scrolling, dependency navigation across resource types and sources, retry, unresolved dependencies and dialog layouts.`,
  );
} catch (error) {
  await page.screenshot({
    path: `${evidence}/failure.png`,
    animations: "disabled",
  });
  throw error;
} finally {
  await browser.close();
}
