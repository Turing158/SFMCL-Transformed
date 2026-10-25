import { runtimePath } from "./lib/paths.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";

const evidence = runtimePath("evidence/version-settings");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(8000);
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
const nav = (name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const save = () =>
  page.getByRole("button", { name: "保存设置", exact: true }).first();
const back = () =>
  page.getByRole("button", { name: "返回上一级", exact: true }).click();
const independent = (group = "内存与游戏目录") =>
  page.getByRole("switch", { name: `${group}：独立设置`, exact: true });
const memory = () =>
  page.getByRole("spinbutton", { name: "内存 MB", exact: true });
const title = () =>
  page.getByRole("textbox", { name: "窗口标题", exact: true });
const open = async (id) => {
  await page
    .getByRole("button", { name: `游戏设置 ${id}`, exact: true })
    .click();
  await expect(independent()).toBeVisible();
};
const commit = async () => {
  await save().click();
  await expect(save()).toHaveCount(0);
  await expect(page.locator(".save-bar")).toHaveCount(0);
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await nav("设置");
  await expect(
    page.getByRole("tablist", { name: "设置分类" }).getByRole("tab"),
  ).toHaveText(["启动器设置", "全局设置", "关于"]);
  await nav("版本管理");
  await open("1.21.4");
  await expect(independent()).not.toBeChecked();
  await expect(
    page.locator(".settings-card-heading .pixel-switch-labeled"),
  ).toHaveCount(4);
  const scopeLayout = () =>
    independent().evaluate((el) => {
      const track = el
        .querySelector(".pixel-switch-track")
        .getBoundingClientRect();
      const thumb = el
        .querySelector(".pixel-switch-thumb")
        .getBoundingClientRect();
      const state =
        el.getAttribute("aria-checked") === "true" ? "checked" : "unchecked";
      const label = el.querySelector(`[data-state="${state}"]`);
      const range = document.createRange();
      range.selectNodeContents(label);
      const text = range.getBoundingClientRect();
      return {
        label: label.textContent,
        width: track.width,
        inside: text.left >= track.left && text.right <= track.right,
        separated:
          state === "checked"
            ? text.right < thumb.left
            : text.left > thumb.right,
      };
    });
  const globalLayout = await scopeLayout();
  expect(globalLayout).toMatchObject({
    label: "全局",
    inside: true,
    separated: true,
  });
  await expect(title()).toBeDisabled();
  await independent().focus();
  await page.keyboard.press("Space");
  await expect(independent().locator('[data-state="checked"]')).toHaveCSS(
    "opacity",
    "1",
  );
  const localLayout = await scopeLayout();
  expect(localLayout).toEqual({
    label: "独立",
    width: globalLayout.width,
    inside: true,
    separated: true,
  });
  checks.push(
    "Scope switches show the active label inside the track, keep text clear of the thumb, preserve width and support keyboard switching.",
  );
  await expect(title()).toBeDisabled();
  await independent("游戏窗口").click();
  await independent("Java 运行环境").click();
  await independent("高级启动参数").click();
  await page.getByRole("switch", { name: "自动分配内存", exact: true }).click();
  await memory().fill("8192");
  await title().fill("Version A");
  await page.getByRole("switch", { name: "版本隔离", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Java 运行环境", exact: true })
    .click();
  await page
    .locator(".pixel-select-option")
    .filter({ hasText: /C:\/Java\/jdk-21/ })
    .click();
  await page
    .getByRole("switch", { name: "附加 JVM 参数", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "JVM 参数", exact: true })
    .fill("-Dprofile=A");
  await commit();
  const a = await page.evaluate(
    () => window.__pixelTest.versionSettings["1.21.4"],
  );
  expect(a).toMatchObject({
    useGlobal: false,
    settings: {
      autoMemory: false,
      memoryMb: 8192,
      windowTitle: "Version A",
      isolation: false,
      javaPath: "C:/Java/jdk-21/bin/javaw.exe",
      jvmArgsEnabled: true,
      jvmArgs: "-Dprofile=A",
    },
  });
  expect(a.settings).not.toHaveProperty("theme");
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.memoryMb),
  ).toBe(4096);
  await back();
  await expect(
    page.getByRole("button", { name: "游戏设置 1.21.4", exact: true }),
  ).toHaveAttribute("data-tooltip", "游戏设置 · 独立");
  await open("1.20.1-Fabric");
  await independent().click();
  await independent("游戏窗口").click();
  await page.getByRole("switch", { name: "自动分配内存", exact: true }).click();
  await memory().fill("2048");
  await title().fill("Version B");
  await commit();
  await back();
  await open("1.21.4");
  await expect(memory()).toHaveValue("8192");
  await expect(title()).toHaveValue("Version A");
  await back();
  await page
    .getByRole("button", { name: "查看 1.21.4 本地资源", exact: true })
    .click();
  await expect(
    page.getByRole("status", { name: "版本隔离未开启", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "打开目录", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        window.__pixelTest.requests
          .filter((entry) => entry.operation === "path.open")
          .at(-1).payload.path,
    ),
  ).toBe("C:/Pixel-Test/Minecraft/.minecraft/mods");
  checks.push(
    "Per-version Java, memory, arguments and titles save independently; resource directory uses that version's isolation setting",
  );

  await nav("设置");
  await page.getByRole("tab", { name: "全局设置", exact: true }).click();
  await page.getByRole("switch", { name: "自动分配内存", exact: true }).click();
  await memory().fill("6144");
  await title().fill("Global title");
  await commit();
  await nav("版本管理");
  await expect(
    page.getByRole("status", { name: "版本隔离未开启", exact: true }),
  ).toBeVisible();
  await back();
  await open("1.20.1-Fabric");
  await expect(memory()).toHaveValue("2048");
  await independent().click();
  await expect(memory()).toHaveValue("6144");
  await expect(title()).toHaveValue("Version B");
  await independent("游戏窗口").click();
  await expect(title()).toHaveValue("Global title");
  await expect(title()).toBeDisabled();
  await commit();
  await back();
  await open("1.20.1-Fabric");
  await independent().click();
  await independent("游戏窗口").click();
  await expect(memory()).toHaveValue("2048");
  await expect(title()).toHaveValue("Version B");
  await commit();
  checks.push(
    "Global edits do not overwrite independent versions; switching back follows current globals and preserves the previous independent configuration",
  );

  await page.evaluate(() => {
    window.__pixelTest.failures["versions.settings.save"] = "模拟保存失败";
  });
  await title().fill("Unsaved title");
  await save().click();
  await expect(page.getByRole("alert")).toContainText("模拟保存失败");
  await expect(save()).toBeEnabled();
  await expect(title()).toHaveValue("Unsaved title");
  await page.getByRole("button", { name: "撤销修改", exact: true }).click();
  await expect(title()).toHaveValue("Version B");
  await page.evaluate(() => {
    delete window.__pixelTest.failures["versions.settings.save"];
  });
  await back();
  await open("1.21.4");
  await expect(memory()).toHaveValue("8192");
  checks.push(
    "Failed saves preserve the draft; undo only affects the current version",
  );

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page
      .locator("main.page")
      .evaluate((element) => element.scrollTo(0, 0));
    const bounds = await page.locator("main.page").evaluate((element) => ({
      width: element.clientWidth,
      content: element.scrollWidth,
    }));
    expect(bounds.content).toBeLessThanOrEqual(bounds.width + 1);
    await page.screenshot({
      path: `${evidence}/settings-${width}.png`,
      animations: "disabled",
    });
  }
  await back();
  await page.evaluate(() => {
    window.__pixelTest.failures["versions.settings.get"] = "模拟读取失败";
  });
  await page
    .getByRole("button", { name: "游戏设置 1.21.4", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("模拟读取失败");
  await expect(save()).toHaveCount(0);
  await page.evaluate(() => {
    delete window.__pixelTest.failures["versions.settings.get"];
  });
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(memory()).toHaveValue("8192");
  checks.push(
    "Version settings fit mobile/tablet/desktop; read failures cannot save defaults and can be retried",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser.close();
}
