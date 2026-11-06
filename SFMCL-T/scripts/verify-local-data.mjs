import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { answerConfirmation } from "./lib/confirmation.mjs";
import { runtimePath } from "./lib/paths.mjs";

function localDataFixture() {
  const test = window.__pixelTest;
  const invoke = window.__TAURI_INTERNALS__.invoke;
  test.picks = [];
  const scenario = new URL(location.href).searchParams.get("local-data-test");
  if (scenario === "result" || scenario === "failure") {
    test.data.localDataResult = {
      kind: "restore",
      success: scenario === "result",
      path: "D:/Backups/data.zip",
      message:
        scenario === "result"
          ? "本地数据已还原，原数据副本已保留"
          : "本地数据操作未完成：备份校验失败",
      recoveryPath:
        scenario === "result"
          ? "D:/Launcher/SFMCL-T-before-restore-test"
          : null,
    };
  }
  if (scenario === "active")
    test.tasks.jobs.push({
      id: "running",
      status: "running",
      title: "启动 Minecraft",
      steps: [],
    });
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (["plugin:dialog|open", "plugin:dialog|save"].includes(command)) {
      test.requests.push({ operation: command, payload: args });
      return test.picks.shift() ?? null;
    }
    const operation = args?.operation;
    if (command === "request" && operation?.startsWith("local-data.")) {
      test.requests.push({ operation, payload: args.payload });
      if (test.failures[operation]) throw new Error(test.failures[operation]);
      if (operation === "local-data.prepare")
        return {
          id: "prepared-test-operation",
          ...args.payload,
          ...(args.payload.kind === "restore" && {
            backup: { createdAt: 1700000000, fileCount: 42, totalBytes: 2048 },
          }),
        };
      return { restarting: true };
    }
    return invoke(command, args);
  };
}

const evidence = runtimePath("evidence/local-data");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1120, height: 820 } });
page.setDefaultTimeout(10000);
const errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(localDataFixture);
const card = page.locator(".local-data-settings");
const nav = () =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
const count = (operation) =>
  page.evaluate(
    (operation) =>
      window.__pixelTest.requests.filter(
        (request) => request.operation === operation,
      ).length,
    operation,
  );
const ready = async (scenario = "") => {
  await page.goto(
    `${process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/"}?local-data-test=${scenario}`,
  );
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  if (!["result", "failure"].includes(scenario)) await nav();
  await expect(card).toBeVisible();
};
const choose = (path) =>
  page.evaluate((path) => window.__pixelTest.picks.push(path), path);
try {
  await ready();
  await expect(card.getByLabel("数据文件夹", { exact: true })).toHaveValue(
    "C:/Pixel-Test",
  );
  await expect(card.getByLabel("数据文件夹", { exact: true })).toHaveAttribute(
    "readonly",
    "",
  );
  const open = card.getByRole("button", {
    name: "打开本地数据文件夹",
    exact: true,
  });
  await expect(open).toHaveText("");
  await open.click();
  expect(await count("path.open")).toBe(1);
  await card.getByRole("button", { name: "更改路径", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "更改路径", exact: true }),
  ).toBeEnabled();
  expect(await count("local-data.prepare")).toBe(0);
  checks.push(
    "Directory opens from a labeled icon beside the path; cancelling the picker performs no transfer",
  );

  await choose("D:/New-Launcher-Data");
  await card.getByRole("button", { name: "更改路径", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "确认操作", exact: true }),
  ).toContainText("D:/New-Launcher-Data");
  await answerConfirmation(page, false);
  expect(await count("local-data.execute")).toBe(0);
  await expect(
    card.getByRole("button", { name: "更改路径", exact: true }),
  ).toBeEnabled();
  await choose("D:/New-Launcher-Data");
  await card.getByRole("button", { name: "更改路径", exact: true }).click();
  await answerConfirmation(page, true);
  await expect(card.getByRole("status")).toContainText("完成后自动重新打开");
  await expect(
    card.getByRole("button", { name: "备份数据", exact: true }),
  ).toBeDisabled();
  expect(await count("local-data.execute")).toBe(1);
  checks.push(
    "Migration previews the selected path, respects cancellation and locks controls during restart",
  );

  await ready();
  await page.evaluate(
    () =>
      (window.__pixelTest.failures["local-data.prepare"] = "请选择空文件夹"),
  );
  await choose("D:/Occupied");
  await card.getByRole("button", { name: "更改路径", exact: true }).click();
  await expect(page.locator(".toast.error")).toContainText("请选择空文件夹");
  await expect(
    card.getByRole("button", { name: "更改路径", exact: true }),
  ).toBeEnabled();
  expect(await count("local-data.execute")).toBe(0);
  checks.push(
    "Preflight failures preserve the current path and re-enable controls",
  );

  await ready();
  await choose("D:/Backups/launcher.zip");
  await card.getByRole("button", { name: "备份数据", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "确认操作", exact: true }),
  ).toContainText("D:/Backups/launcher.zip");
  expect(await count("plugin:dialog|save")).toBe(1);
  await answerConfirmation(page, true);
  expect(await count("local-data.execute")).toBe(1);
  checks.push(
    "Backup uses a ZIP save picker, confirms its destination and starts one operation",
  );

  await ready();
  await choose("D:/Backups/launcher.zip");
  await card.getByRole("button", { name: "还原数据", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "确认操作", exact: true }),
  ).toContainText("42 个文件");
  await expect(
    page.getByRole("dialog", { name: "确认操作", exact: true }),
  ).toContainText("当前数据会先保留为副本");
  await answerConfirmation(page, true);
  expect(await count("local-data.execute")).toBe(1);
  checks.push(
    "Restore shows verified backup details and explains the retained original-data copy",
  );

  await ready("result");
  await expect(card).toContainText("本地数据已还原");
  await card
    .getByRole("button", { name: "打开原数据副本", exact: true })
    .click();
  expect(await count("local-data.recovery.open")).toBe(1);
  await ready("failure");
  await expect(card.getByRole("alert")).toContainText("备份校验失败");
  checks.push(
    "Restart returns to launcher settings with success/failure feedback and access to the original copy",
  );

  await ready("active");
  await expect(
    card.getByRole("button", { name: "更改路径", exact: true }),
  ).toBeDisabled();
  await expect(card.getByRole("status")).toContainText("请先结束");
  checks.push("An active game or background job blocks data transfers");

  await ready("result");
  for (const width of [375, 768, 1120, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      await card.scrollIntoViewIfNeeded();
      const bounds = await card.boundingBox();
      const path = await card
        .getByLabel("数据文件夹", { exact: true })
        .boundingBox();
      expect(path.x).toBeGreaterThanOrEqual(bounds.x);
      expect(path.x + path.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(
        await page.evaluate(() => document.body.scrollWidth > innerWidth),
      ).toBe(false);
      await page.screenshot({ path: `${evidence}/${width}-${theme}.png` });
    }
  }
  checks.push(
    "Path, actions and retained-copy details fit 375/768/1120/1440px in both themes",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/verification.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` });
  throw error;
} finally {
  await browser.close();
}
