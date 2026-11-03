import { chromium, expect } from "@playwright/test";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { waitForAutoSave } from "./lib/auto-save.mjs";

const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(8000);
await page.addInitScript(pixelAppFixture, { persistJavaLists: true });
await page.addInitScript(() => {
  window.__pixelTest.availableMemoryMb = 3051;
  if (!sessionStorage.getItem("pixel-test-java-settings")) {
    window.__pixelTest.data.settings.memoryMb = 8192;
    window.__pixelTest.data.settings.autoMemory = false;
  }
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const nav = (name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const globalSettings = () =>
  page.evaluate(() => window.__pixelTest.data.settings);
const config = (id) =>
  page.evaluate((id) => window.__pixelTest.versionSettings[id], id);
const title = () =>
  page.getByRole("textbox", { name: "窗口标题", exact: true });
const width = () => page.getByRole("spinbutton", { name: "宽度", exact: true });
const memory = () =>
  page.getByRole("spinbutton", { name: "内存 MB", exact: true });
const scope = (name) =>
  page.getByRole("switch", { name: `${name}：独立设置`, exact: true });
const back = () =>
  page.getByRole("button", { name: "返回上一级", exact: true }).click();
const select = async (label, option) => {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
};
const open = async (id) => {
  await page
    .getByRole("button", { name: `游戏设置 ${id}`, exact: true })
    .click();
  await expect(scope("游戏窗口")).toBeVisible();
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await nav("设置");
  await waitForAutoSave(page);
  expect(
    await page.evaluate(() =>
      window.__pixelTest.requests.filter(
        (r) => r.operation === "settings.save",
      ),
    ),
  ).toHaveLength(0);
  await page.getByRole("button", { name: "深色", exact: true }).click();
  await select("3D 预览帧数", "45");
  await waitForAutoSave(page);
  expect(await globalSettings()).toMatchObject({
    theme: "dark",
    player3dFps: 45,
  });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("tab", { name: "全局设置", exact: true }).click();
  await expect(memory()).toHaveValue("8192");
  await waitForAutoSave(page);
  expect((await globalSettings()).memoryMb).toBe(8192);

  await page.evaluate(() => {
    window.__pixelTest.delays["settings.save"] = 350;
  });
  await title().fill("First");
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            window.__pixelTest.requests.filter(
              (r) => r.operation === "settings.save",
            ),
          )
        ).length,
    )
    .toBeGreaterThan(1);
  await title().fill("Latest global title");
  await width().fill("1600");
  await page.getByRole("spinbutton", { name: "高度", exact: true }).fill("900");
  await expect(width()).toBeEnabled();
  await nav("版本管理");
  await page
    .getByRole("button", { name: "选择 1.20.1-Fabric", exact: true })
    .click();
  await waitForAutoSave(page);
  await expect.poll(globalSettings).toMatchObject({
    windowTitle: "Latest global title",
    width: 1600,
    height: 900,
    activeVersion: "1.20.1-Fabric",
    memoryMb: 8192,
  });
  await page.evaluate(() => {
    delete window.__pixelTest.delays["settings.save"];
  });

  await nav("设置");
  await width().fill("");
  await page.waitForTimeout(300);
  expect((await globalSettings()).width).toBe(1600);
  await width().fill("1920");
  await title().fill("Global with Java");
  await page.getByRole("button", { name: "扫描", exact: true }).click();
  await waitForAutoSave(page);
  expect(await globalSettings()).toMatchObject({
    windowTitle: "Global with Java",
    width: 1920,
  });
  expect((await globalSettings()).javaPaths).toContain(
    "C:/Java/jdk-8/bin/java.exe",
  );

  await nav("版本管理");
  await open("1.21.4");
  await scope("游戏窗口").click();
  await scope("内存与游戏目录").click();
  await title().fill("Version A auto");
  await memory().fill("2048");
  await back();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await open("1.20.1-Fabric");
  await scope("游戏窗口").click();
  await title().fill("Version B auto");
  await back();
  await open("1.21.4");
  await expect(title()).toHaveValue("Version A auto");
  await expect(memory()).toHaveValue("2048");
  await waitForAutoSave(page);
  expect(await config("1.21.4")).toMatchObject({
    settings: { windowTitle: "Version A auto", memoryMb: 2048 },
  });
  await expect
    .poll(() => config("1.20.1-Fabric"))
    .toMatchObject({ settings: { windowTitle: "Version B auto" } });
  expect((await globalSettings()).windowTitle).toBe("Global with Java");
  await page.evaluate(() => {
    window.__pixelTest.delays["versions.settings.save"] = 350;
  });
  await title().fill("Version A first write");
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__pixelTest.requests.some(
          (request) =>
            request.operation === "versions.settings.save" &&
            request.payload.config.settings.windowTitle ===
              "Version A first write",
        ),
      ),
    )
    .toBe(true);
  await title().fill("Version A final write");
  await back();
  await open("1.21.4");
  await expect(title()).toHaveValue("Version A final write");
  await waitForAutoSave(page);
  await page.evaluate(() => {
    delete window.__pixelTest.delays["versions.settings.save"];
  });
  await back();

  await nav("设置");
  await page.evaluate(() => {
    window.__pixelTest.failures["settings.save"] = "Temporary write failure";
  });
  await title().fill("Retried automatically");
  await expect(
    page.getByRole("alert").filter({ hasText: "Temporary write failure" }),
  ).toBeVisible();
  expect((await globalSettings()).windowTitle).toBe("Global with Java");
  await expect(title()).toHaveValue("Retried automatically");
  await page.evaluate(() => {
    delete window.__pixelTest.failures["settings.save"];
  });
  await waitForAutoSave(page);
  expect((await globalSettings()).windowTitle).toBe("Retried automatically");
  await page.reload();
  await nav("设置");
  await page.getByRole("tab", { name: "全局设置", exact: true }).click();
  await expect(title()).toHaveValue("Retried automatically");
  await expect(width()).toHaveValue("1920");
  await waitForAutoSave(page);
  expect(errors).toEqual([]);
  console.log(
    "Automatic settings passed: no save/undo UI, no writes on entry, immediate theme/FPS updates, rapid edits and selections survive delayed writes, numeric drafts are safe, Java scans preserve settings, version changes survive immediate navigation, failures retry and reload persists.",
  );
} finally {
  await browser.close();
}
