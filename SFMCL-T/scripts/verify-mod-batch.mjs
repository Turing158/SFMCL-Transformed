import { chromium, expect } from "@playwright/test";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { resourceCenterFixture } from "./fixtures/resource-center.mjs";

const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const version = "1.20.1-Fabric";
const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/";
const errors = [];

async function openMods(options) {
  const page = await browser.newPage({
    viewport: { width: 850, height: 600 },
    ...options,
  });
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(pixelAppFixture);
  await page.addInitScript(resourceCenterFixture);
  await page.addInitScript((id) => {
    const state = window.__pixelTest;
    const resources = state.resources.localItems[id];
    const original = resources.mod[0];
    const root = original.path.slice(0, original.path.lastIndexOf("/") + 1);
    resources.mod = Array.from({ length: 22 }, (_, index) => {
      const number = String(index + 1).padStart(2, "0");
      const disabled = index === 1;
      return {
        ...original,
        name: "Batch " + number,
        path: root + (disabled ? ".disabled/" : "") + number + ".jar",
        disabled,
      };
    });
    let failOnce = true;
    const base = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command !== "request" || args?.operation !== "resources.batchMods")
        return base(command, args);
      state.requests.push(structuredClone(args));
      const { action, paths, versionId } = args.payload;
      if (versionId !== id) throw Error("资源版本错误");
      return paths.map((path) => {
        const item = resources.mod.find((entry) => entry.path === path);
        if (!item) throw Error("模组文件不存在");
        if (action === "disable" && item.name === "Batch 21" && failOnce) {
          failOnce = false;
          return { path, renamedTo: null, error: "目标位置已有同名模组" };
        }
        if (action === "delete") {
          resources.mod = resources.mod.filter((entry) => entry !== item);
          return { path, renamedTo: null, error: null };
        }
        item.disabled = action === "disable";
        item.path =
          root + (item.disabled ? ".disabled/" : "") + path.split("/").at(-1);
        return { path, renamedTo: item.path, error: null };
      });
    };
  }, version);
  await page.goto(url);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "版本管理", exact: true })
    .click();
  await button(page, "查看 " + version + " 本地资源").click();
  await expect(button(page, "Batch 01 详情")).toBeVisible();
  return page;
}

const button = (root, name) => root.getByRole("button", { name, exact: true });
const toolbar = (page) => page.getByRole("group", { name: "模组批量操作" });
const calls = (page) =>
  page.evaluate(() =>
    window.__pixelTest.requests.filter(
      (entry) => entry.operation === "resources.batchMods",
    ),
  );

async function point(locator) {
  await locator.scrollIntoViewIfNeeded();
  const { x, y, width, height } = await locator.boundingBox();
  return { x: x + width / 2, y: y + height / 2 };
}

async function hold(page, locator) {
  const { x, y } = await point(locator);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(toolbar(page)).toBeVisible();
  await page.mouse.up();
  await expect(toolbar(page)).toContainText("已选 1 项");
}

async function sampleBatchMotion(page, open, change) {
  const observation = await page.evaluateHandle((open) => {
    const sample = new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const bar = document.querySelector(".local-mod-batch-toolbar");
        if (bar?.dataset.open !== String(open)) return;
        clearTimeout(timeout);
        observer.disconnect();
        const read = (element) => {
          const transitions = element.getAnimations();
          const fade = transitions.find(
            (animation) => animation.transitionProperty === "opacity",
          );
          return {
            opacity: fade?.effect
              .getKeyframes()
              .map((frame) => Number(frame.opacity)),
            slides: transitions.some(
              (animation) => animation.transitionProperty === "transform",
            ),
            inert: element.inert,
          };
        };
        const icons = document.querySelectorAll(
          ".local-mod-row:first-child .local-resource-actions > button",
        );
        resolve({
          toolbar: read(bar),
          icons: [...icons].map(read),
          count: bar.querySelector("[role=status]").textContent,
        });
      });
      const timeout = setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, 4000);
      observer.observe(document.querySelector(".local-resources"), {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-open"],
      });
    });
    return { sample };
  }, open);
  try {
    await change();
    return await observation.evaluate(({ sample }) => sample);
  } finally {
    await observation.dispose();
  }
}

try {
  const page = await openMods();
  const bar = toolbar(page);
  const search = page.getByRole("searchbox", { name: "搜索本地资源" });
  const first = button(page, "Batch 01 详情");
  await first.click();
  await expect(page.locator(".local-resource-page")).toBeVisible();
  await page
    .getByRole("navigation", { name: "页面路径" })
    .getByRole("button", { name: "返回上一级" })
    .click();
  const { x, y } = await point(first);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 60);
  await page.waitForTimeout(550);
  await page.mouse.up();
  await expect(bar).toHaveCount(0);
  const opening = await sampleBatchMotion(page, true, () => hold(page, first));
  expect(opening).toEqual({
    toolbar: { opacity: [0, 1], slides: true, inert: false },
    icons: Array(2).fill({ opacity: [1, 0], slides: true, inert: true }),
    count: "已选 1 项",
  });
  await expect(button(page, "Batch 01")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await button(page, "Batch 02").click();
  await expect(bar).toContainText("已选 2 项");
  await expect(button(bar, "启用")).toBeEnabled();
  await expect(button(bar, "禁用")).toBeEnabled();
  await expect(
    button(bar, "启用").locator(".lucide-circle-pause"),
  ).toBeVisible();
  await expect(button(bar, "禁用").locator(".lucide-power")).toBeVisible();
  const rows = page.locator(".local-mod-row[data-selected]");
  const rowActions = rows.locator(".local-resource-actions > button");
  await expect(rowActions.first()).toBeHidden();
  await expect(
    rows.first().locator(".local-resource-actions").getByRole("button"),
  ).toHaveCount(0);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    const [selected, unselected] = await rows.evaluateAll((elements) =>
      ["true", "false"].map((state) => {
        const row = elements.find(
          (element) => element.dataset.selected === state,
        );
        const style = getComputedStyle(row);
        return {
          fill: style.getPropertyValue("--surface-fill"),
          edge: style.getPropertyValue("--surface-edge"),
        };
      }),
    );
    expect(selected.fill).not.toBe(unselected.fill);
    expect(selected.edge).not.toBe(unselected.edge);
    for (const width of [375, 850]) {
      await page.setViewportSize({ width, height: 600 });
      const layout = await bar.evaluate((element) => {
        const record = (node) => node.getBoundingClientRect().toJSON();
        return {
          toolbar: record(element),
          page: record(element.closest("main")),
          footer: record(document.querySelector(".workspace-footer")),
          scrollWidth: element.scrollWidth,
          width: element.clientWidth,
          buttons: [...element.querySelectorAll("button")].map((button) => {
            const style = getComputedStyle(button);
            return {
              width: record(button).width,
              height: record(button).height,
              iconWidth: record(button.querySelector("svg")).width,
              background: style.backgroundColor,
              border: style.borderTopWidth,
              hasFrame: !!button.querySelector(".surface-frame"),
              text: button.textContent.trim(),
            };
          }),
        };
      });
      expect(layout.toolbar.left).toBeGreaterThanOrEqual(layout.page.left);
      expect(layout.toolbar.right).toBeLessThan(layout.page.right);
      expect(layout.toolbar.bottom).toBeLessThan(layout.footer.top);
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
      expect(layout.toolbar.height).toBeLessThanOrEqual(40);
      expect(layout.toolbar.width).toBeLessThanOrEqual(220);
      expect(layout.buttons).toHaveLength(4);
      for (const control of layout.buttons) {
        expect(control).toEqual({
          width: 32,
          height: 32,
          iconWidth: 16,
          background: "rgba(0, 0, 0, 0)",
          border: "0px",
          hasFrame: false,
          text: "",
        });
      }
    }
  }
  await page.setViewportSize({ width: 850, height: 600 });
  await button(bar, "删除").click();
  const confirmation = page.getByRole("dialog", { name: "确认操作" });
  await expect(confirmation).toContainText("永久删除所选的 2 个模组");
  await button(confirmation, "取消").click();
  await expect(confirmation).toHaveCount(0);
  expect(await calls(page)).toHaveLength(0);
  const pagination = page.getByRole("navigation", { name: "本地模组分页" });
  await button(pagination, "下一页").click();
  await button(page, "Batch 21").click();
  await expect(bar).toContainText("已选 3 项");
  await search.fill("Batch 02");
  await expect(button(page, "Batch 02")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(bar).toContainText("已选 3 项");
  await button(bar, "禁用").click();
  await expect(bar).toContainText("已选 1 项");
  await expect(page.getByRole("region", { name: "通知" })).toContainText(
    "目标位置已有同名模组",
  );
  expect(
    (await calls(page))[0].payload.paths.map((path) => path.split("/").at(-1)),
  ).toEqual(["01.jar", "21.jar"]);
  await button(bar, "禁用").click();
  await expect(bar).toHaveCount(0);

  await search.fill("");
  await hold(page, button(page, "Batch 02 详情"));
  await button(page, "Batch 01").click();
  await expect(button(bar, "禁用")).toHaveCount(0);
  await button(bar, "启用").click();
  await expect(bar).toHaveCount(0);
  expect((await calls(page))[2].payload.action).toBe("enable");

  await button(page, "Batch 01 详情").focus();
  await page.keyboard.press("Shift+Space");
  await expect(bar).toHaveCSS("opacity", "1");
  const reversed = await page.evaluate(async () => {
    const bar = document.querySelector(".local-mod-batch-toolbar");
    const row = document.activeElement;
    row.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await Promise.resolve();
    if (bar.dataset.open !== "false") return false;
    row.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: " ",
        code: "Space",
        shiftKey: true,
        bubbles: true,
      }),
    );
    await Promise.resolve();
    return bar.isConnected && bar.dataset.open === "true";
  });
  expect(reversed).toBe(true);
  await expect(bar).toHaveCSS("opacity", "1");
  const closing = await sampleBatchMotion(page, false, () =>
    page.keyboard.press("Escape"),
  );
  expect(closing).toEqual({
    toolbar: { opacity: [1, 0], slides: true, inert: true },
    icons: Array(2).fill({ opacity: [0, 1], slides: true, inert: false }),
    count: "已选 1 项",
  });
  await expect(bar).toHaveCount(0);
  await expect(page.locator(".local-mod-batch-toolbar")).toHaveCount(0);
  await hold(page, button(page, "Batch 01 详情"));
  await button(page, "Batch 02").click();
  await button(bar, "删除").click();
  await expect(confirmation).toBeVisible();
  await button(confirmation, "确认").click();
  await expect(bar).toHaveCount(0);
  await expect(button(page, "Batch 01 详情")).toHaveCount(0);
  await expect(button(page, "Batch 02 详情")).toHaveCount(0);
  expect((await calls(page))[3].payload.action).toBe("delete");
  await page.close();

  const touchPage = await openMods({ hasTouch: true });
  await touchPage.emulateMedia({ reducedMotion: "reduce" });
  const touch = await touchPage.context().newCDPSession(touchPage);
  const touchPoint = await point(button(touchPage, "Batch 01 详情"));
  const reduced = await sampleBatchMotion(touchPage, true, () =>
    touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [touchPoint],
    }),
  );
  expect(reduced).toEqual({
    toolbar: { opacity: [0, 1], slides: false, inert: false },
    icons: Array(2).fill({ opacity: [1, 0], slides: false, inert: true }),
    count: "已选 1 项",
  });
  await expect(toolbar(touchPage)).toContainText("已选 1 项");
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(toolbar(touchPage)).toContainText("已选 1 项");
  await button(toolbar(touchPage), "退出多选").tap();
  await expect(toolbar(touchPage)).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(
    "Mod batch passed: motion and reversal, mouse and touch long press, keyboard, layouts, search, pagination, partial retry, enable, delete and cancel.",
  );
} finally {
  await browser.close();
}
