import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { runtimePath } from "./lib/paths.mjs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";

const evidence = runtimePath("evidence/resource-search");
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
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command !== "request" || args.operation !== "resources.search")
      return base(command, args);
    const payload = args.payload;
    state.requests.push(structuredClone(args));
    if (payload.query === "故障") throw new Error("搜索服务暂时不可用");
    await new Promise((resolve) =>
      setTimeout(resolve, payload.query === "旧搜索" ? 500 : 25),
    );
    const make = (id, title, name) => ({
      id,
      source: payload.source,
      title,
      slug: id,
      localizedName: name ? { name, aliases: [title] } : null,
      description: "搜索回归测试",
      author: payload.source,
      icon: "",
      downloads: 1000,
      categories: [],
      versions: ["1.20.1"],
      website: "https://example.com/",
      body: "",
    });
    let items;
    if (!payload.query) items = [make("popular", "推荐模组")];
    else if (payload.query === "旧搜索") items = [make("old", "旧搜索结果")];
    else if (payload.query === "高级")
      items = [make("advanced", "Advanced Machines", "高级机械")];
    else
      items = [
        make("create", "Create", "机械动力"),
        ...Array.from({ length: 22 }, (_, index) =>
          make(`addon-${index}`, `Addon ${index}`, `机械动力附属 ${index}`),
        ),
      ];
    return {
      total: items.length,
      offset: payload.offset,
      items: items.slice(payload.offset, payload.offset + payload.limit),
    };
  };
});
const selectSource = async (name) => {
  await page.getByRole("combobox", { name: "资源来源" }).click();
  await page.getByRole("option", { name, exact: true }).click();
};
const requests = () =>
  page.evaluate(() =>
    window.__pixelTest.requests.filter(
      (request) => request.operation === "resources.search",
    ),
  );
const last = async () => (await requests()).at(-1)?.payload;
const search = page.getByRole("searchbox", { name: "搜索资源", exact: true });
const submit = page.getByRole("button", { name: "搜索", exact: true });
const create = page.getByRole("heading", {
  name: "机械动力（Create）",
  exact: true,
});

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "资源中心", exact: true })
    .click();
  await page.getByRole("tab", { name: "模组", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "推荐模组", exact: true }),
  ).toBeVisible();
  await search.fill("机械");
  await selectSource("CurseForge");
  await expect(create).toBeVisible();
  expect(await last()).toMatchObject({
    source: "curseforge",
    query: "机械",
    offset: 0,
  });
  await expect(
    page.getByRole("heading", { name: "推荐模组", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: `${evidence}/chinese-curseforge.png` });
  checks.push(
    "Switching to CurseForge searches the current Chinese input instead of the empty or previously submitted query.",
  );

  let count = (await requests()).length;
  await submit.click();
  await expect
    .poll(async () => (await requests()).length)
    .toBeGreaterThan(count);
  expect(await last()).toMatchObject({ source: "curseforge", query: "机械" });
  await expect(create).toBeVisible();
  await search.fill("高级");
  await search.press("Enter");
  await expect(
    page.getByRole("heading", {
      name: "高级机械（Advanced Machines）",
      exact: true,
    }),
  ).toBeVisible();
  expect(await last()).toMatchObject({ source: "curseforge", query: "高级" });
  checks.push(
    "Both the search button and Enter submit Chinese queries on CurseForge and update the catalog.",
  );

  await search.fill("机械");
  await selectSource("Modrinth");
  await expect(create).toBeVisible();
  expect(await last()).toMatchObject({
    source: "modrinth",
    query: "机械",
    offset: 0,
  });
  await page
    .getByRole("navigation", { name: "资源分页" })
    .getByRole("button", { name: "下一页" })
    .click();
  await expect
    .poll(last)
    .toMatchObject({ source: "modrinth", query: "机械", offset: 20 });
  await search.fill("高级");
  await selectSource("CurseForge");
  await expect(
    page.getByRole("heading", {
      name: "高级机械（Advanced Machines）",
      exact: true,
    }),
  ).toBeVisible();
  expect(await last()).toMatchObject({
    source: "curseforge",
    query: "高级",
    offset: 0,
    category: "",
  });
  checks.push(
    "Switching platforms uses the edited input, resets pagination, and clears the previous platform category.",
  );

  await search.fill("旧搜索");
  await search.press("Enter");
  await search.fill("机械");
  await selectSource("Modrinth");
  await expect(create).toBeVisible();
  await page.waitForTimeout(600);
  await expect(
    page.getByRole("heading", { name: "旧搜索结果", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: `${evidence}/chinese-modrinth.png` });
  checks.push(
    "A slow response from the previous source cannot overwrite the current Chinese search results.",
  );

  await selectSource("CurseForge");
  await expect(create).toBeVisible();
  await search.fill("故障");
  await submit.click();
  await expect(
    page.getByRole("heading", { name: "暂时无法获取资源", exact: true }),
  ).toBeVisible();
  await search.fill("机械");
  await submit.click();
  await expect(create).toBeVisible();
  count = (await requests()).length;
  await search.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  expect((await requests()).length).toBe(count);
  await search.press("Enter");
  await expect
    .poll(async () => (await requests()).length)
    .toBeGreaterThan(count);
  expect(await last()).toMatchObject({ source: "curseforge", query: "机械" });
  checks.push(
    "Failed searches can recover, and Enter during IME composition waits for the committed Chinese query.",
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
      { checks, errors, message: String(error), requests: await requests() },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
