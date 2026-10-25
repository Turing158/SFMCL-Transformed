import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { runtimePath } from "./lib/paths.mjs";

const browser = await chromium.connectOverCDP(
  process.env.SFMCL_T_CDP || "http://127.0.0.1:9445",
);
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15_000);
await page.reload();
await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
const evidence = runtimePath("evidence/datapack-desktop");
await mkdir(evidence, { recursive: true });
const errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
const invoke = (operation, payload = {}) =>
  page.evaluate(
    ({ operation, payload }) =>
      window.__TAURI_INTERNALS__.invoke("request", { operation, payload }),
    { operation, payload },
  );
const bootstrap = await invoke("bootstrap");
if (!path.resolve(bootstrap.dataDir).startsWith(runtimePath() + path.sep))
  throw new Error("Requires an isolated .runtime desktop");
const select = async (label, value) => {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
};
const retry = async (action) => {
  let failure;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await action();
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
};

try {
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "资源中心", exact: true })
    .click();
  await page.getByRole("tab", { name: "数据包", exact: true }).click();
  for (const source of ["Modrinth", "CurseForge"]) {
    if (source === "CurseForge") await select("资源来源", source);
    const search = page.getByRole("searchbox", {
      name: "搜索资源",
      exact: true,
    });
    await search.fill(source === "Modrinth" ? "Terralith" : "VanillaBackport");
    await retry(async () => {
      await search.press("Enter");
      await expect(page.locator(".catalog-results")).toHaveAttribute(
        "aria-busy",
        "false",
        { timeout: 40_000 },
      );
      await expect(page.locator(".catalog-project-info").first()).toBeVisible();
    });
    const project =
      source === "Modrinth"
        ? page.getByRole("button", { name: "查看 Terralith 详情", exact: true })
        : page.getByRole("button", {
            name: /查看 VanillaBackport: Mob Variants Compat Datapack 详情/,
          });
    await expect(project).toBeVisible();
    await page.screenshot({
      path: path.join(evidence, `${source}-catalog.png`),
      animations: "disabled",
    });
    await project.click();
    await page.getByRole("tab", { name: /^可下载版本/ }).click();
    await page.getByRole("textbox", { name: "筛选游戏版本" }).fill("1.20.1");
    await retry(async () => {
      const button = page.getByRole("button", { name: "重试", exact: true });
      if (await button.isVisible()) await button.click();
      await expect(page.locator("button.project-file").first()).toBeVisible({
        timeout: 40_000,
      });
    });
    const projectId = source === "Modrinth" ? "8oi3bsk5" : "1385619";
    const files = await retry(() =>
      invoke("resources.files", {
        source: source.toLowerCase(),
        id: projectId,
        gameVersion: "1.20.1",
        loader: "datapack",
      }),
    );
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => file.gameVersions.includes("1.20.1"))).toBe(
      true,
    );
    const selected = files[0];
    expect(selected.file.path).toMatch(/\.zip$/i);
    if (source === "Modrinth") expect(selected.loaders).toContain("datapack");
    await expect(
      page.getByRole("combobox", { name: "筛选加载器" }),
    ).toHaveCount(0);
    await page
      .getByRole("button", {
        name: `选择 ${selected.name} 的下载位置`,
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("tab")).toHaveText(["下载到文件夹"]);
    await expect(dialog).toContainText("存档的 datapacks 文件夹");
    await expect(
      dialog.getByRole("button", { name: "开始下载", exact: true }),
    ).toBeDisabled();
    const directory = path.join(evidence, source, "world", "datapacks");
    await mkdir(directory, { recursive: true });
    await page.screenshot({
      path: path.join(evidence, `${source}-download.png`),
      animations: "disabled",
    });
    const title = await page
      .locator(".resource-subpage-header h1")
      .textContent();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    const payload = { kind: "datapack", title, directory, file: selected.file };
    const existing = (await invoke("tasks")).downloads.find(
      (task) => task.title === title,
    );
    const taskId =
      existing?.id ??
      (await retry(() => invoke("resources.download", payload)));
    await expect
      .poll(
        async () => {
          const task = (await invoke("tasks")).downloads.find(
            (task) => task.id === taskId,
          );
          if (task?.status === "failed")
            await invoke("downloads.control", { id: taskId, action: "retry" });
          return task?.status;
        },
        { timeout: 120_000, intervals: [1000, 3000, 5000] },
      )
      .toBe("completed");
    expect(payload.kind).toBe("datapack");
    expect(payload.directory).toBe(directory);
    expect(payload).not.toHaveProperty("versionId");
    const bytes = await readFile(path.join(directory, payload.file.path));
    expect(bytes.length).toBe(payload.file.size);
    if (payload.file.sha1)
      expect(createHash("sha1").update(bytes).digest("hex")).toBe(
        payload.file.sha1,
      );
    if (payload.file.sha512)
      expect(createHash("sha512").update(bytes).digest("hex")).toBe(
        payload.file.sha512,
      );
    const rejection = await invoke("resources.download", {
      kind: "datapack",
      versionId: "missing",
      title: "Invalid datapack destination",
      file: payload.file,
    }).then(
      () => "unexpected success",
      (error) => String(error),
    );
    expect(rejection).toContain("请选择下载文件夹");
    checks.push({
      source,
      title,
      file: payload.file.path,
      bytes: bytes.length,
      completed: true,
      hashVerified: true,
      gameVersion: "1.20.1",
      directInstallRejected: true,
    });
    await page.getByRole("button", { name: "返回上一级", exact: true }).click();
  }
  await page.locator(".sidebar-task").click();
  await expect(
    page.getByRole("heading", { name: "下载中心", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(evidence, "completed-downloads.png"),
    animations: "disabled",
  });
  expect(errors).toEqual([]);
  const report = {
    checks,
    errors,
    nativeFolderChooser:
      "not exercised; queue submitted through real IPC after UI dialog checks",
    ipc: "real",
    localVersions: await invoke("versions.list"),
  };
  await writeFile(
    path.join(evidence, "checks.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page.screenshot({
    path: path.join(evidence, "failure.png"),
    animations: "disabled",
  });
  throw error;
} finally {
  await browser.close();
}
