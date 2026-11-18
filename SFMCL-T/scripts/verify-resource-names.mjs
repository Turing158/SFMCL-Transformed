import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { runtimePath } from "./lib/paths.mjs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";

const evidence = runtimePath("evidence/resource-names");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
page.setDefaultTimeout(10000);
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(resourceCenterFixture);
await page.addInitScript(() => {
  const base = window.__TAURI_INTERNALS__.invoke;
  const state = window.__pixelTest;
  const pack = {
    id: "localized-pack",
    source: "curseforge",
    slug: "gt-new-horizons",
    title: "GT: New Horizons",
    localizedName: {
      name: "格雷科技：新视野",
      aliases: ["GT: New Horizons", "GTNH"],
    },
    description: "Original pack description",
    author: "GTNH Team",
    icon: "",
    downloads: 1000,
    categories: [],
    versions: ["1.20.1"],
    website: "https://www.curseforge.com/minecraft/modpacks/gt-new-horizons",
    body: "Original pack introduction",
  };
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command !== "request") return base(command, args);
    const { operation, payload = {} } = args;
    if (operation === "modpacks.inspect") {
      state.requests.push(structuredClone(args));
      return {
        token: "translated-pack",
        format: "Modrinth",
        name: pack.title,
        localizedName: pack.localizedName,
        version: "2.7",
        minecraft: "1.20.1",
        loader: null,
        optionalFiles: [],
        fileCount: 0,
      };
    }
    if (operation === "modpacks.install" || operation === "modpacks.discard") {
      state.requests.push(structuredClone(args));
      return operation === "modpacks.install" ? "translated-job" : true;
    }
    const result = await base(command, args);
    if (operation === "resources.search") {
      if (payload.kind === "modpack") return { items: [pack], total: 1 };
      if (payload.kind === "mod")
        result.items[0].localizedName = { name: "钠", aliases: ["Sodium"] };
    }
    if (operation === "resources.detail") {
      if (payload.id === pack.id) return pack;
      if (result.title === "Sodium")
        result.localizedName = { name: "钠", aliases: ["Sodium"] };
    }
    if (operation === "resources.local" && payload.kind === "mod") {
      result[0].name = "Just Enough Items";
      result[0].localizedName = {
        name: "JEI物品管理器",
        aliases: ["Just Enough Items", "JEI"],
      };
    }
    return result;
  };
});
const nav = (name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const back = () =>
  page
    .getByRole("navigation", { name: "页面路径" })
    .getByRole("button", { name: "返回上一级", exact: true })
    .click();
const dialog = () => page.getByRole("dialog");
const last = (operation) =>
  page.evaluate(
    (op) =>
      window.__pixelTest.requests.findLast(
        (request) => request.operation === op,
      )?.payload,
    operation,
  );
const chooseFile = async () => {
  await page.getByRole("tab", { name: /^下载/ }).click();
  await page
    .getByRole("button", {
      name: "选择 兼容文件 1.20.1 的下载位置",
      exact: true,
    })
    .click();
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:4180/");
  await nav("资源中心");
  await page.getByRole("tab", { name: "模组", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "钠（Sodium）", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^切换为(列表|卡片)视图$/ }).click();
  await expect(
    page.getByRole("heading", { name: "钠（Sodium）", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "查看 钠（Sodium） 详情", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "页面路径" }),
  ).toContainText("钠（Sodium）");
  await expect(page.locator(".resource-subpage-header")).toContainText(
    "钠（Sodium）",
  );
  await chooseFile();
  await expect(dialog()).toHaveAccessibleName("下载 钠（Sodium）");
  await dialog().getByRole("button", { name: "开始下载" }).click();
  await expect(dialog()).toHaveCount(0);
  expect((await last("resources.download")).title).toBe("Sodium");
  checks.push(
    "Mod cards, lists, details and download headings display Chinese names while download requests retain the original name.",
  );
  await back();
  await page.getByRole("tab", { name: "整合包", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "格雷科技：新视野（GT: New Horizons）",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "查看 格雷科技：新视野（GT: New Horizons） 详情",
      exact: true,
    })
    .click();
  await expect(page.locator(".resource-subpage-header")).toContainText(
    "格雷科技：新视野（GT: New Horizons）",
  );
  await expect(page.locator(".project-heading")).toContainText(
    "Original pack description",
  );
  await chooseFile();
  await expect(dialog()).toHaveAccessibleName(
    "下载 格雷科技：新视野（GT: New Horizons）",
  );
  await expect(
    dialog().getByRole("textbox", { name: "整合包游戏名称" }),
  ).toHaveValue("GT_ New Horizons 1.0");
  await dialog()
    .getByRole("textbox", { name: "整合包游戏名称" })
    .fill("My GTNH");
  await dialog().getByRole("button", { name: "开始安装" }).click();
  await expect(dialog()).toHaveCount(0);
  expect((await last("modpacks.install")).name).toBe("My GTNH");
  checks.push(
    "Online packs have Chinese titles and preserve the original default instance name and the user's edited name.",
  );
  await nav("版本管理");
  await page.getByRole("button", { name: "导入整合包", exact: true }).click();
  await page.evaluate(() => {
    window.__pixelTest.resources.selectedDirectory = "C:/Packs/GTNH.mrpack";
  });
  await dialog().getByRole("button", { name: "选择压缩包" }).click();
  await expect(dialog().locator(".modpack-summary")).toContainText(
    "格雷科技：新视野（GT: New Horizons）",
  );
  await expect(
    dialog().getByRole("textbox", { name: "整合包游戏名称" }),
  ).toHaveValue("GT_ New Horizons 2.7");
  await page.screenshot({ path: `${evidence}/localized-import.png` });
  await dialog().getByRole("button", { name: "开始安装" }).click();
  await expect(dialog()).toHaveCount(0);
  expect((await last("modpacks.install")).name).toBe("GT_ New Horizons 2.7");
  checks.push(
    "Local pack import displays the translated package name without using it as the directory name.",
  );
  await page
    .getByRole("button", { name: "查看 1.20.1-Fabric 本地资源", exact: true })
    .click();
  await page.getByRole("tab", { name: /^模组/ }).click();
  const search = page.getByRole("searchbox", { name: "搜索本地资源" });
  for (const query of ["物品管理器", "Just Enough", "JEI"]) {
    await search.fill(query);
    await expect(
      page.getByRole("heading", {
        name: "JEI物品管理器（Just Enough Items）",
        exact: true,
      }),
    ).toBeVisible();
  }
  await page
    .getByRole("button", {
      name: "JEI物品管理器（Just Enough Items） 详情",
      exact: true,
    })
    .click();
  await expect(
    page.locator(".local-resource-page .resource-subpage-header"),
  ).toContainText("JEI物品管理器（Just Enough Items）");
  await expect(
    page.getByRole("navigation", { name: "页面路径" }),
  ).toContainText("JEI物品管理器（Just Enough Items）");
  await page.screenshot({ path: `${evidence}/localized-mod.png` });
  checks.push(
    "Local mods display Chinese titles in the list and detail view, and are searchable by Chinese name, English name and abbreviation.",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` });
  await writeFile(
    `${evidence}/failure.json`,
    JSON.stringify(
      {
        checks,
        errors,
        message: String(error),
        text: await page.locator("body").innerText(),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
