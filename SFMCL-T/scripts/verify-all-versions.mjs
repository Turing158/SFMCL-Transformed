import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { allVersionsFixture } from "./fixtures/all-versions.mjs";
import { runtimePath } from "./lib/paths.mjs";
import { verifyVersionSelection } from "./check-version-selection.mjs";

const first = "C:/Pixel-Test/Minecraft";
const second = "D:/Other-Minecraft";
const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/";
const evidence = runtimePath("evidence/all-versions");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
});
const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
page.setDefaultTimeout(8000);
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript({
  content: `(${pixelAppFixture.toString()})();(${allVersionsFixture.toString()})();`,
});
const directory = page.getByRole("combobox", { name: "游戏目录", exact: true });
const cards = page.locator(".version-management .version-card");
const card = (id, folder = first) =>
  cards
    .filter({ has: page.getByRole("heading", { name: id, exact: true }) })
    .and(page.locator(`[data-directory="${folder}"]`));
const requests = (operation) =>
  page.evaluate(
    (operation) =>
      window.__pixelTest.requests.filter(
        (item) => item.operation === operation,
      ),
    operation,
  );
const choose = async (name) => {
  await directory.click();
  await page.getByRole("option", { name, exact: true }).click();
};
const filterBy = async (label, value) => {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
};
const showAll = async () => {
  await choose("全部");
  await expect(page.locator("#local-version-results")).toHaveAttribute(
    "aria-busy",
    "false",
  );
};
const ready = async () => {
  await page.goto(url);
  await expect(page.locator("html")).not.toHaveAttribute("data-startup");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "版本管理", exact: true })
    .click();
  await expect(cards).toHaveCount(2);
};
const selection = () =>
  page.evaluate(() => ({
    directory: window.__pixelTest.data.settings.activeDir,
    version: window.__pixelTest.data.settings.activeVersion,
  }));

try {
  await verifyVersionSelection(page, ready, showAll, checks);
  await ready();
  await showAll();
  await expect(cards).toHaveCount(3);
  await expect(page.locator(".versions-heading .count")).toHaveText("3");
  await expect(card("1.21.4", first)).toHaveClass(/selected/);
  await expect(card("1.21.4", second)).not.toHaveClass(/selected/);
  await expect(card("1.21.4", second).locator(".version-directory")).toHaveText(
    "另一游戏目录",
  );
  expect(await selection()).toEqual({ directory: first, version: "1.21.4" });
  expect(await requests("settings.save")).toHaveLength(0);
  expect(await requests("versions.select")).toHaveLength(0);
  await expect(
    page.getByRole("button", { name: "打开游戏目录", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "移除目录记录", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "添加游戏目录", exact: true }),
  ).toBeEnabled();
  checks.push(
    "All directories, empty folders and legacy aliases aggregate without duplicate paths or selection changes.",
  );

  const search = page.getByRole("searchbox", {
    name: "搜索版本名称",
    exact: true,
  });
  await search.fill("fabric");
  await expect(cards).toHaveCount(1);
  await search.fill("1.21.4");
  await expect(cards).toHaveCount(2);
  await search.fill("");
  await card("1.21.4", second)
    .getByRole("button", { name: "选择 1.21.4", exact: true })
    .focus();
  await page.keyboard.press("Space");
  await expect(card("1.21.4", second)).toHaveClass(/selected/);
  await expect(card("1.21.4", first)).not.toHaveClass(/selected/);
  expect((await requests("versions.select")).at(-1).payload).toEqual({
    id: "1.21.4",
    directory: second,
  });
  await expect(directory).toHaveText("全部");
  await card("1.21.4", first)
    .getByRole("button", { name: "收藏 1.21.4", exact: true })
    .click();
  await expect(
    card("1.21.4", first).getByRole("button", {
      name: "取消收藏 1.21.4",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    card("1.21.4", second).getByRole("button", {
      name: "收藏 1.21.4",
      exact: true,
    }),
  ).toBeVisible();
  expect((await requests("versions.favorite")).at(-1).payload).toEqual({
    id: "1.21.4",
    directory: first,
    favorite: true,
  });
  expect(await selection()).toEqual({ directory: second, version: "1.21.4" });
  checks.push(
    "Search, keyboard selection and favorites keep same-name versions in separate directories.",
  );

  for (const [label, operation] of [
    ["查看 1.21.4 本地资源", "resources.local"],
    ["游戏设置 1.21.4", "versions.settings.get"],
  ]) {
    await card("1.21.4", first)
      .getByRole("button", { name: label, exact: true })
      .click();
    await expect
      .poll(async () => (await requests(operation)).length)
      .toBeGreaterThan(0);
    expect((await requests(operation)).at(-1).payload.directory).toBe(first);
    expect(await selection()).toEqual({ directory: second, version: "1.21.4" });
    await page.getByRole("button", { name: "返回上一级", exact: true }).click();
    await expect(directory).toHaveText("全部");
    await expect(cards).toHaveCount(3);
  }
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "开始游戏", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "版本管理", exact: true })
    .click();
  await expect(directory).toHaveText("全部");
  checks.push(
    "Resources and settings use the source directory; returning from details and other pages retains the All filter.",
  );

  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [375, 1024]) {
      await page.setViewportSize({ width, height: 800 });
      for (const view of ["grid", "list"]) {
        if (
          (await page.locator(".version-list").count()) > 0 !==
          (view === "list")
        )
          await page
            .getByRole("button", {
              name: view === "list" ? "切换为列表视图" : "切换为卡片视图",
              exact: true,
            })
            .click();
        await expect(cards).toHaveCount(3);
        const bounds = await page.locator("main.page").evaluate((element) => ({
          width: element.clientWidth,
          content: element.scrollWidth,
        }));
        expect(bounds.content, `${theme}/${width}/${view}`).toBeLessThanOrEqual(
          bounds.width + 1,
        );
        await page.screenshot({
          path: `${evidence}/${theme}-${width}-${view}.png`,
          animations: "disabled",
        });
      }
    }
  }
  checks.push(
    "All results fit grid/list layouts at desktop and mobile widths in both themes.",
  );

  await ready();
  await showAll();
  await page.evaluate(
    ({ second }) => window.__pixelTest.addDirectoryVersion("new-world", second),
    { second },
  );
  await page.getByRole("button", { name: "刷新版本", exact: true }).click();
  await expect(card("new-world", second)).toBeVisible();
  await expect(cards).toHaveCount(4);
  await choose(`像素工坊 · ${first}`);
  await expect(cards).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "打开游戏目录", exact: true }),
  ).toBeEnabled();
  await showAll();
  await expect(cards).toHaveCount(4);
  checks.push(
    "Refresh rescans every directory, and switching back to one folder restores its own list.",
  );

  await card("1.21.4", second)
    .getByRole("button", { name: "管理 1.21.4", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "管理 1.21.4", exact: true });
  await dialog
    .getByRole("button", { name: "打开版本目录", exact: true })
    .click();
  expect((await requests("path.open")).at(-1).payload.path).toBe(
    `${second}/.minecraft/versions/1.21.4`,
  );
  await dialog.getByRole("textbox").fill("renamed-world");
  await dialog.getByRole("button", { name: "重命名", exact: true }).click();
  await expect(card("renamed-world", second)).toBeVisible();
  await expect(card("1.21.4", first)).toBeVisible();
  await card("renamed-world", second)
    .getByRole("button", { name: "管理 renamed-world", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "管理 renamed-world", exact: true })
    .getByRole("button", { name: "删除版本", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "确认操作",
    exact: true,
  });
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  expect(await requests("versions.delete")).toHaveLength(0);
  await page
    .getByRole("dialog", { name: "管理 renamed-world", exact: true })
    .getByRole("button", { name: "删除版本", exact: true })
    .click();
  await confirmation.getByRole("button", { name: "确认", exact: true }).click();
  await expect(card("renamed-world", second)).toHaveCount(0);
  await expect(card("1.21.4", first)).toBeVisible();
  expect((await requests("versions.delete")).at(-1).payload).toEqual({
    id: "renamed-world",
    directory: second,
  });
  checks.push(
    "Opening, renaming and confirmed deletion target the source directory and refresh aggregate results.",
  );

  await ready();
  await page.evaluate(
    ({ second }) => {
      window.__pixelTest.directoryFailures[second] = "测试目录暂不可读";
    },
    { second },
  );
  await showAll();
  await expect(cards).toHaveCount(2);
  await expect(page.getByRole("alert")).toContainText("测试目录暂不可读");
  await page.evaluate(
    ({ second }) => {
      delete window.__pixelTest.directoryFailures[second];
    },
    { second },
  );
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await expect(cards).toHaveCount(3);
  await expect(page.locator(".versions-directory-errors")).toHaveCount(0);
  checks.push(
    "A failed folder preserves other results and can be retried without changing the active selection.",
  );

  await ready();
  await page.evaluate(
    ({ second }) => {
      window.__pixelTest.heldDirectoryReads[second] = [];
    },
    { second },
  );
  await choose("全部");
  await expect(page.locator("#local-version-results")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect
    .poll(() =>
      page.evaluate(
        ({ second }) => window.__pixelTest.heldDirectoryReads[second].length,
        { second },
      ),
    )
    .toBe(1);
  await choose(`像素工坊 · ${first}`);
  await expect(cards).toHaveCount(2);
  await page.evaluate(
    ({ second }) => {
      const held = window.__pixelTest.heldDirectoryReads[second];
      delete window.__pixelTest.heldDirectoryReads[second];
      held.forEach((resolve) => resolve());
    },
    { second },
  );
  await showAll();
  await expect(cards).toHaveCount(3);
  checks.push(
    "Switching folders during an in-flight aggregate scan cancels stale results and keeps subsequent scans usable.",
  );

  await ready();
  await page.evaluate(
    ({ first, second }) => {
      const test = window.__pixelTest;
      for (const [id, directory, kind, base, loader] of [
        ["25w01a", second, "snapshot", "25w01a", "Fabric"],
        ["a1.2.6", first, "old_alpha", "a1.2.6", "Vanilla"],
        ["b1.7.3", second, "old_beta", "b1.7.3", "Vanilla"],
        ["土豆世界", second, "snapshot", "24w14potato", "Vanilla"],
      ]) {
        test.addDirectoryVersion(id, directory);
        Object.assign(test.directoryVersions.at(-1), {
          kind,
          version: base,
          loader,
        });
      }
      test.directoryVersions.find(
        (version) => version.id === "1.20.1-Fabric",
      ).favorite = true;
    },
    { first, second },
  );
  await showAll();
  await expect(cards).toHaveCount(7);
  await filterBy("筛选版本类型", "快照版");
  await expect(cards).toHaveCount(1);
  await expect(card("25w01a", second)).toBeVisible();
  await filterBy("筛选版本类型", "历史版");
  await expect(cards).toHaveCount(2);
  await filterBy("筛选版本类型", "愚人节");
  await expect(card("土豆世界", second)).toBeVisible();
  await expect(cards).toHaveCount(1);
  checks.push(
    "Type filters distinguish snapshots, both historical types, and renamed April Fools versions by their base version.",
  );

  await filterBy("筛选版本类型", "正式版");
  await expect(cards).toHaveCount(3);
  await filterBy("筛选加载器", "Fabric");
  await expect(cards).toHaveCount(1);
  const favoritesOnly = page.getByRole("button", {
    name: "仅显示收藏版本",
    exact: true,
  });
  await favoritesOnly.click();
  await expect(favoritesOnly).toHaveAttribute("aria-pressed", "true");
  await expect(cards).toHaveCount(1);
  await expect(page.locator(".versions-heading .count")).toHaveText("1");
  await search.fill("1.21.4");
  await expect(cards).toHaveCount(0);
  await expect(page.locator(".versions-heading .count")).toHaveText("0");
  await expect(
    page.getByRole("heading", { name: "没有符合条件的版本", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "清空搜索与筛选", exact: true })
    .click();
  await expect(cards).toHaveCount(7);
  await expect(search).toHaveValue("");
  await expect(favoritesOnly).toHaveAttribute("aria-pressed", "false");
  expect(await selection()).toEqual({ directory: first, version: "1.21.4" });
  checks.push(
    "Type, loader, favorite and search conditions combine immediately; counts and reset reflect the results without changing selection.",
  );

  await filterBy("筛选加载器", "Fabric");
  await favoritesOnly.click();
  await expect(cards).toHaveCount(1);
  await card("1.20.1-Fabric")
    .getByRole("button", { name: "取消收藏 1.20.1-Fabric", exact: true })
    .click();
  await expect(cards).toHaveCount(0);
  await favoritesOnly.click();
  await expect(cards).toHaveCount(2);
  await choose(`另一游戏目录 · ${second}`);
  await expect(cards).toHaveCount(1);
  await expect(card("25w01a", second)).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "筛选加载器", exact: true }),
  ).toHaveText("Fabric");
  await page
    .getByRole("button", { name: "切换为卡片视图", exact: true })
    .click();
  await expect(cards).toHaveCount(1);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "开始游戏", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "版本管理", exact: true })
    .click();
  await expect(cards).toHaveCount(1);
  await expect(
    page.getByRole("combobox", { name: "筛选加载器", exact: true }),
  ).toHaveText("Fabric");
  checks.push(
    "Favorite changes update filtered results, and filters persist across directories, grid/list views and navigation.",
  );

  await ready();
  await page.evaluate(() => {
    window.__pixelTest.data.settings.gameDirs = [];
    window.__pixelTest.data.settings.activeDir = "";
    window.__pixelTest.data.settings.activeVersion = "";
  });
  await page.getByRole("button", { name: "刷新版本", exact: true }).click();
  await expect(cards).toHaveCount(0);
  await showAll();
  await expect(cards).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "你的世界，即将开始", exact: true }),
  ).toBeVisible();
  checks.push(
    "All is usable with no registered folders and displays the existing empty state.",
  );

  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(
    `PASS ${checks.length} all-directory behavior groups; no page errors.`,
  );
} catch (error) {
  await page
    .screenshot({ path: `${evidence}/failure.png`, animations: "disabled" })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
}
