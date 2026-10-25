import { runtimePath } from "./lib/paths.mjs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

// UI regression checks run in a separate browser with an in-memory Tauri bridge.
// No real accounts, settings, game directories, downloads or desktop windows change.
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(8000);
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await mkdir(runtimePath("evidence/pixel-controls"), { recursive: true });

await page.addInitScript(pixelAppFixture);
await page.addInitScript(() => {
  const animate = Element.prototype.animate;
  window.__selectMotions = [];
  Element.prototype.animate = function (...args) {
    const motion = animate.apply(this, args);
    if (args[1]?.id === "sfmcl-t-select-popup") {
      window.__selectMotions.push(motion);
      if (window.__holdSelectMotion) motion.pause();
    }
    return motion;
  };
});

const nav = async (name) => {
  if (name === "角色管理") {
    await page.locator(".sidebar .profile-button").click();
    return;
  }
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
};
const select = async (name, option) => {
  const trigger = page.getByRole("combobox", { name, exact: true });
  await expect(trigger).toHaveCSS("border-image-slice", "8");
  await expect(trigger).toHaveCSS("border-image-width", "8px");
  await trigger.click();
  const choice =
    name === "Java 运行环境"
      ? page.locator(".pixel-select-option").filter({ hasText: option })
      : page.getByRole("option", { name: option, exact: true });
  await expect(choice).toHaveCSS("border-image-slice", "6");
  await expect(choice).toHaveCSS("border-image-width", "6px");
  await choice.click();
};
const screenshot = async (name) =>
  page.screenshot({
    path: runtimePath(`evidence/pixel-controls/${name}.png`),
    animations: "disabled",
  });

const checkHover = async (control, disabled = false) => {
  await control.evaluate((el) => document.activeElement?.blur());
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  // Measure after navigation/tab motion settles, not during its final subpixel frame.
  await control.evaluate(async (element) => {
    const animations = [];
    for (let parent = element; parent; parent = parent.parentElement)
      animations.push(...parent.getAnimations());
    await Promise.allSettled(
      animations
        .filter(
          (animation) => animation.effect.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished),
    );
  });
  const before = await control.boundingBox();
  const resting = await control.evaluate((el) =>
    getComputedStyle(el).getPropertyValue("--pixel-field-border"),
  );
  await control.hover();
  if (disabled) {
    await page.waitForTimeout(200);
    expect(
      await control.evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--pixel-field-border"),
      ),
    ).toBe(resting);
    return;
  }
  const samples = await control.evaluate((el) => {
    const animation = el
      .getAnimations()
      .find((motion) => motion.transitionProperty === "--pixel-field-border");
    if (!animation) throw new Error("Missing pixel border hover transition");
    animation.pause();
    const samples = [0, 90, 180].map((time) => {
      animation.currentTime = time;
      const style = getComputedStyle(el);
      return {
        color: style.getPropertyValue("--pixel-field-border"),
        image: style.backgroundImage,
      };
    });
    animation.finish();
    return samples;
  });
  expect(samples[0].color).toBe(resting);
  expect(samples[1].color).not.toBe(samples[0].color);
  expect(samples[1].color).not.toBe(samples[2].color);
  expect(samples[1].image).not.toBe(samples[0].image);
  expect(samples[1].image).not.toBe(samples[2].image);
  const after = await control.boundingBox();
  // Animated ancestors can leave subpixel rounding in otherwise stable bounds.
  expect(after.width).toBeCloseTo(before.width, 2);
  expect(after.height).toBeCloseTo(before.height, 2);
  expect(after.x).toBeCloseTo(before.x, 2);
  await page.mouse.move(0, 0);
  await expect
    .poll(() =>
      control.evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--pixel-field-border"),
      ),
    )
    .toBe(resting);
};

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await nav("资源中心");
  await page.getByRole("tab", { name: "模组", exact: true }).click();
  const source = page.getByRole("combobox", { name: "资源来源", exact: true });
  for (const theme of ["light", "dark"]) {
    for (const accent of ["forest", "puce", "ebony"]) {
      await page.evaluate(
        ({ theme, accent }) => {
          Object.assign(document.documentElement.dataset, { theme, accent });
        },
        { theme, accent },
      );
      await checkHover(source);
    }
  }
  await page.evaluate(() =>
    Object.assign(document.documentElement.dataset, {
      theme: "light",
      accent: "forest",
    }),
  );
  await page.evaluate(() => {
    window.__holdSelectMotion = true;
  });
  await source.press("Enter");
  const sampleMotion = (fraction) =>
    page.evaluate((fraction) => {
      const motion = window.__selectMotions.at(-1);
      motion.currentTime = motion.effect.getTiming().duration * fraction;
      const style = getComputedStyle(motion.effect.target);
      return {
        opacity: Number(style.opacity),
        clip: style.clipPath,
        transform: style.transform,
      };
    }, fraction);
  const start = await sampleMotion(0);
  const middle = await sampleMotion(0.5);
  expect(start.opacity).toBe(0);
  expect(middle.opacity).toBeGreaterThan(0);
  expect(middle.opacity).toBeLessThan(1);
  expect(middle.clip).not.toBe(start.clip);
  await source.press("Escape");
  const reverse = await sampleMotion(0);
  expect(reverse.opacity).toBeCloseTo(middle.opacity, 4);
  expect(reverse.clip).toBe(middle.clip);
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page.locator(".pixel-select-popup")).toHaveAttribute(
    "inert",
    "",
  );
  const closing = await sampleMotion(0.5);
  expect(closing.opacity).toBeLessThan(reverse.opacity);
  await source.press("Enter");
  const reopened = await sampleMotion(0);
  expect(reopened.opacity).toBeCloseTo(closing.opacity, 4);
  expect(reopened.clip).toBe(closing.clip);
  await page.evaluate(() => window.__selectMotions.at(-1).finish());
  await expect(page.getByRole("listbox")).toBeVisible();
  await source.press("Escape");
  expect((await sampleMotion(0)).opacity).toBe(1);
  expect((await sampleMotion(0.999)).opacity).toBeLessThan(0.01);
  await page.evaluate(() => {
    window.__selectMotions.at(-1).finish();
    window.__holdSelectMotion = false;
  });
  await expect(page.locator(".pixel-select-popup")).toHaveCount(0);
  checks.push(
    "Dropdown unfolds and folds, reverses from its current frame during rapid toggles, and remains inert until the closing animation removes it",
  );
  await select("加载器", "Fabric");
  await page
    .getByRole("combobox", { name: "资源来源", exact: true })
    .press("Enter");
  await page.keyboard.press("End");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("combobox", { name: "资源来源", exact: true }),
  ).toHaveText(/Modrinth/);
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "资源来源", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("searchbox", { name: "搜索资源", exact: true })
    .fill("sodium");
  await page
    .getByRole("textbox", { name: "游戏版本", exact: true })
    .fill("1.20.1");
  await page
    .getByRole("searchbox", { name: "搜索资源", exact: true })
    .press("Enter");
  await expect(page.getByRole("heading", { name: /^Sodium/ })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.__pixelTest.requests.findLast(
          (r) => r.operation === "resources.search",
        ).payload,
    ),
  ).toMatchObject({ query: "sodium", loader: "Fabric", gameVersion: "1.20.1" });
  await page.getByRole("button", { name: "清空搜索资源", exact: true }).click();
  await expect(
    page.getByRole("searchbox", { name: "搜索资源", exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("searchbox", { name: "搜索资源", exact: true }),
  ).toBeFocused();
  await screenshot("resources-light");
  checks.push(
    "Resource selectors preserve query payload; Enter submits; clear restores search focus; Escape cancels selection",
  );

  await nav("版本管理");
  const localSearch = page.getByRole("searchbox", {
    name: "搜索版本名称",
    exact: true,
  });
  await checkHover(page.locator(".version-management .pixel-search"));
  await localSearch.fill("1.20");
  await expect(page.locator(".version-card")).toHaveCount(1);
  await page
    .getByRole("button", { name: "清空搜索版本名称", exact: true })
    .click();
  await expect(page.locator(".version-card")).toHaveCount(2);
  await expect(localSearch).toBeFocused();
  await localSearch.fill("no-match");
  await localSearch.press("Escape");
  await expect(localSearch).toHaveValue("");
  checks.push(
    "Local version search updates immediately; button and Escape clear the filter",
  );

  await page
    .getByRole("button", { name: "安装新版本", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", {
      name: "查看 Minecraft 1.20.1 安装配置",
      exact: true,
    })
    .click();
  await page.getByRole("combobox", { name: "安装目录", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "安装 Minecraft 1.20.1", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("listbox")).toBeVisible();
  expect(
    await page
      .locator(".pixel-select-popup")
      .evaluate((el) => el.matches(":popover-open")),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "选择 Fabric", exact: true }).click();
  await page
    .getByRole("radio", { name: "Fabric 0.16.10", exact: true })
    .click();
  await expect(
    page.getByRole("radio", { name: "Fabric 0.16.10", exact: true }),
  ).toBeChecked();
  await page.getByRole("combobox", { name: "安装目录", exact: true }).click();
  await screenshot("install-tab-list");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("region", { name: "安装 Minecraft 1.20.1", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "安装 Minecraft 1.20.1", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "页面路径" })
    .getByRole("button", { name: "返回上一级", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "查看 Minecraft 1.20.1 安装配置",
      exact: true,
    }),
  ).toBeFocused();
  const installSearch = page.getByRole("searchbox", { name: "搜索可安装版本" });
  await installSearch.fill("1.19");
  await installSearch.press("Escape");
  await expect(installSearch).toHaveValue("");
  await expect(
    page.getByRole("region", { name: "安装 Minecraft", exact: true }),
  ).toBeVisible();
  await installSearch.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  checks.push(
    "Installer cards select async loader options; child-page dropdown Escape closes only the popup, the return action restores catalog focus, and catalog search clears independently",
  );

  await nav("设置");
  await page.getByRole("tab", { name: "全局设置", exact: true }).click();
  await checkHover(
    page.getByRole("textbox", { name: "窗口标题", exact: true }),
  );
  await checkHover(
    page.getByRole("textbox", { name: "游戏尾部参数", exact: true }),
  );
  await checkHover(
    page.getByRole("spinbutton", { name: "内存 MB", exact: true }),
    true,
  );
  await expect(page.getByRole("slider", { name: "游戏内存" })).toBeDisabled();
  for (const selector of [
    ".pixel-switch-track",
    ".pixel-switch-thumb",
    ".pixel-range-track",
  ]) {
    await expect(page.locator(selector).first()).toHaveCSS(
      "border-image-slice",
      "4",
    );
    await expect(page.locator(selector).first()).toHaveCSS(
      "border-image-width",
      "4px",
    );
  }
  await page.getByRole("switch", { name: "自动分配内存", exact: true }).click();
  await expect(page.getByRole("slider", { name: "游戏内存" })).toBeEnabled();
  await checkHover(
    page.getByRole("spinbutton", { name: "内存 MB", exact: true }),
  );
  checks.push(
    "Search, text, multiline, number and select fields animate their pixel border without layout changes; all six palettes and disabled fields are covered",
  );
  await page.getByRole("slider", { name: "游戏内存" }).fill("8192");
  await expect(page.getByRole("spinbutton", { name: "内存 MB" })).toHaveValue(
    "8192",
  );
  await page.getByRole("slider", { name: "游戏内存" }).press("ArrowRight");
  await expect(page.getByRole("spinbutton", { name: "内存 MB" })).toHaveValue(
    "8320",
  );
  await select("Java 运行环境", /C:\/Java\/jdk-21/);
  await page
    .getByRole("textbox", { name: "窗口标题", exact: true })
    .fill("Pixel controls");
  await page
    .getByRole("button", { name: "保存设置", exact: true })
    .first()
    .click();
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings),
  ).toMatchObject({
    memoryMb: 8320,
    autoMemory: false,
    javaPath: "C:/Java/jdk-21/bin/javaw.exe",
    windowTitle: "Pixel controls",
  });
  await page.locator("main.page").evaluate((el) => el.scrollTo(0, 0));
  await screenshot("settings-light");
  checks.push(
    "Switch enables memory slider; numeric input and keyboard steps stay synchronized; settings payload stays intact",
  );

  await page.getByRole("tab", { name: "启动器设置", exact: true }).click();
  await select("主题配色", "原版 · Puce");
  await page.getByRole("button", { name: "深色", exact: true }).click();
  await page
    .getByRole("button", { name: "保存设置", exact: true })
    .first()
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "puce");
  await page.getByRole("combobox", { name: "主题配色", exact: true }).click();
  await screenshot("settings-dark-puce");
  await page.keyboard.press("Escape");
  checks.push("Theme and accent selectors persist and recolor custom controls");

  await nav("角色管理");
  await page.getByRole("button", { name: "切换模型，当前经典模型" }).click();
  await expect(
    page.getByRole("button", { name: "切换模型，当前纤细模型" }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(() => window.__pixelTest.data.players[0].slim),
  ).toBe(true);
  await page.getByRole("button", { name: "离线登录", exact: true }).click();
  await page
    .getByRole("textbox", { name: "角色名称", exact: true })
    .fill("invalid name");
  await page.getByRole("button", { name: "创建角色", exact: true }).click();
  expect(
    await page.evaluate(() =>
      window.__pixelTest.requests.some((r) => r.operation === "players.add"),
    ),
  ).toBe(false);
  await page
    .getByRole("textbox", { name: "角色名称", exact: true })
    .fill("Pixel_Alex");
  await page.getByRole("button", { name: "创建角色", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".players-page")).not.toHaveAttribute("data-login");
  await expect(
    page.getByRole("button", { name: "选择角色 Pixel_Alex", exact: true }),
  ).toBeVisible();
  checks.push(
    "Model button retains account action; offline child page retains required/pattern rules and form submission",
  );

  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ["版本管理", "资源中心", "设置", "角色管理"]) {
      await nav(name);
      expect(
        await page.evaluate(() => {
          const content = document.querySelector("main.page");
          return (
            document.documentElement.scrollWidth <= innerWidth &&
            content.scrollWidth <= content.clientWidth + 1
          );
        }),
        `${name} at ${width}px`,
      ).toBe(true);
    }
    await nav("资源中心");
    await page.getByRole("tab", { name: "模组", exact: true }).click();
    if (
      !(await page
        .getByRole("combobox", { name: "加载器", exact: true })
        .isVisible())
    )
      await page.getByRole("button", { name: /^筛选/ }).click();
    await page.getByRole("combobox", { name: "加载器", exact: true }).click();
    const rect = await page.locator(".pixel-select-popup").boundingBox();
    expect(
      rect.x >= 0 &&
        rect.x + rect.width <= width &&
        rect.y >= 0 &&
        rect.y + rect.height <= 900,
    ).toBe(true);
    if (width === 375) await screenshot("resources-mobile-list");
    await page.keyboard.press("Escape");
  }
  checks.push(
    "Four pages and dropdown bounds verified at 375, 768, 1024 and 1440 pixels",
  );
  await expect(page.locator("select")).toHaveCount(0);
  expect(errors).toEqual([]);
  const result = { checks, errors };
  await writeFile(
    runtimePath("evidence/pixel-controls/checks.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
