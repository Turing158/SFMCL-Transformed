import { runtimePath } from "./lib/paths.mjs";
import { answerConfirmation } from "./lib/confirmation.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { playersFixture } from "./fixtures/players.mjs";
import { verifyPlayerSelection } from "./check-player-selection.mjs";

const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/";
const evidence = runtimePath("players-implementation");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
});
page.setDefaultTimeout(8000);
await page.addInitScript({
  content: `(${pixelAppFixture.toString()})(); (${playersFixture.toString()})();`,
});
const errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
const ui = page.locator(".players-page");
const go = async () => {
  await page.goto(url);
  await page.locator(".sidebar .profile-button").click();
  await expect(ui.locator(".players-identity h2")).toHaveText("Steve");
  await expect(
    ui.getByRole("button", { name: "离线登录", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => document.fonts.ready);
};
const shot = (name) =>
  page.screenshot({ path: `${evidence}/${name}.png`, animations: "disabled" });
const returnToPlayers = () =>
  page
    .getByRole("navigation", { name: "页面路径" })
    .getByRole("button", { name: "返回上一级", exact: true })
    .click();
const last = (operation) =>
  page.evaluate(
    (op) =>
      window.__pixelTest.requests.filter((r) => r.operation === op).at(-1)
        ?.payload,
    operation,
  );
const count = (operation) =>
  page.evaluate(
    (op) =>
      window.__pixelTest.requests.filter((r) => r.operation === op).length,
    operation,
  );
const refresh = async () => {
  await ui.getByRole("button", { name: /刷新 Alex 登录/ }).click();
};
const check = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
try {
  await go();
  await expect(ui).toHaveAttribute("data-view", "grove");
  await expect(
    ui.getByRole("button", { name: "离线登录", exact: true }),
  ).toHaveCount(1);
  await expect(ui).not.toContainText("选择的角色将用于下一次启动");
  await shot("grove-desktop");
  const selectedBefore = await count("players.select");
  await ui.getByRole("button", { name: "切换为方块展台", exact: true }).click();
  await expect(ui).toHaveAttribute("data-view", "gallery");
  await expect(
    ui.getByRole("button", { name: "切换为林间营地", exact: true }),
  ).toBeVisible();
  expect(await count("players.select")).toBe(selectedBefore);
  await shot("gallery-desktop");
  await go();
  await expect(ui).toHaveAttribute("data-view", "gallery");
  await ui.getByRole("button", { name: "切换为林间营地", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(ui).toHaveAttribute("data-view", "grove");
  check(
    "Single view toggle, keyboard activation, shared selection and persistence",
  );

  await verifyPlayerSelection(page, check);
  await go();

  const canvas = ui.locator(".skin-body");
  const front = await canvas.evaluate((c) => c.toDataURL());
  await ui.getByRole("button", { name: "切换预览朝向，当前正面" }).click();
  await expect(canvas).toHaveAttribute("aria-label", "Steve 的背面皮肤预览");
  await expect
    .poll(() => canvas.evaluate((c) => c.toDataURL()))
    .not.toBe(front);
  await ui.getByRole("button", { name: "切换为方块展台", exact: true }).click();
  await expect(canvas).toHaveAttribute("aria-label", "Steve 的背面皮肤预览");
  await ui.getByRole("button", { name: "切换预览朝向，当前背面" }).click();
  await expect(ui.locator(".players-figure")).toHaveAttribute("data-preview-mode", "3d");
  await ui.getByRole("button", { name: "切换预览朝向，当前3D" }).click();
  await expect.poll(() => canvas.evaluate((c) => c.toDataURL())).toBe(front);
  await ui.getByRole("button", { name: "切换模型，当前经典模型" }).click();
  await expect(
    ui.getByRole("button", { name: "切换模型，当前纤细模型" }),
  ).toBeEnabled();
  expect(await last("players.skin")).toEqual({
    id: "steve",
    path: null,
    slim: true,
  });
  check(
    "Front/back renders different skin pixels and model updates reach the account API",
  );

  await ui.getByRole("button", { name: "更换皮肤", exact: true }).click();
  await expect
    .poll(() => last("players.skin"))
    .toEqual({ id: "steve", path: "C:/Test/skin.png", slim: true });
  await expect(
    ui.getByRole("button", { name: "重置皮肤", exact: true }),
  ).toBeEnabled();
  const picks = await count("plugin:dialog|open");
  const square = await ui.locator(".players-skin-reset").boundingBox();
  expect(square.width).toBe(28);
  expect(square.height).toBe(28);
  await ui.getByRole("button", { name: "重置皮肤", exact: true }).click();
  await expect
    .poll(() => last("players.skin"))
    .toEqual({ id: "steve", path: null, slim: false });
  expect(await count("plugin:dialog|open")).toBe(picks);
  await page.evaluate(() => {
    window.__pixelTest.pick = null;
  });
  await expect(
    ui.getByRole("button", { name: "更换皮肤", exact: true }),
  ).toBeEnabled();
  const skinRequests = await count("players.skin");
  await ui.getByRole("button", { name: "更换皮肤", exact: true }).click();
  await expect(
    ui.getByRole("button", { name: "更换皮肤", exact: true }),
  ).toBeEnabled();
  expect(await count("players.skin")).toBe(skinRequests);
  check("Skin import, cancelled picker and isolated square reset action");

  await ui.getByRole("button", { name: "更改名称", exact: true }).click();
  await page.getByLabel("新的名称", { exact: true }).fill("Steve_New");
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(ui.locator(".players-identity h2")).toHaveText("Steve_New");
  await ui.getByRole("button", { name: "离线登录", exact: true }).click();
  await page.getByLabel("角色名称", { exact: true }).fill("NewPlayer");
  await page.getByRole("button", { name: "创建角色", exact: true }).click();
  await expect(ui.locator(".players-identity h2")).toHaveText("NewPlayer");
  await expect(ui).not.toHaveAttribute("data-login");
  await ui.getByRole("button", { name: "切换为林间营地", exact: true }).click();
  await expect(
    ui.getByRole("button", { name: "选择角色 NewPlayer", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await ui.getByRole("button", { name: "移除 NewPlayer", exact: true }).click();
  await answerConfirmation(page, false);
  await expect(
    ui.getByRole("button", { name: "选择角色 NewPlayer", exact: true }),
  ).toBeVisible();
  await ui.getByRole("button", { name: "移除 NewPlayer", exact: true }).click();
  await answerConfirmation(page, true);
  await expect(
    ui.getByRole("button", { name: "选择角色 NewPlayer", exact: true }),
  ).toHaveCount(0);
  check(
    "Add, rename with updated UUID, active player and confirmed/cancelled removal",
  );

  await ui.getByRole("button", { name: "选择角色 Alex", exact: true }).click();
  await expect(ui.locator(".players-identity h2")).toHaveText("Alex");
  await expect(ui.getByRole("button", { name: /切换模型/ })).toBeDisabled();
  await expect(
    ui.getByRole("button", { name: "重置皮肤", exact: true }),
  ).toBeDisabled();
  await ui.getByRole("button", { name: "更换皮肤", exact: true }).click();
  expect((await last("plugin:opener|open_url")).url).toContain("/editskin");
  await ui.getByRole("button", { name: "更改名称", exact: true }).click();
  expect((await last("plugin:opener|open_url")).url).toContain("/editprofile");
  await refresh();
  expect(await last("players.refresh")).toEqual({ id: "alex" });
  check(
    "Microsoft profile links, refresh and remote-only model/skin permissions",
  );

  const remoteRequests = [];
  await page.route("**/textures.minecraft.net/**", (route) => {
    remoteRequests.push(route.request().url());
    return route.abort();
  });
  const facePixel = () =>
    ui
      .locator(".skin-body")
      .evaluate((canvas) => [
        ...canvas.getContext("2d").getImageData(5, 2, 1, 1).data,
      ]);
  for (const [scheme, color, expected] of [
    ["http", "#ff0000", [255, 0, 0, 255]],
    ["https", "#00ff00", [0, 255, 0, 255]],
    ["https", "#0000ff", [0, 0, 255, 255]],
  ]) {
    await page.evaluate(
      ({ scheme, color }) => {
        const atlas = document.createElement("canvas");
        atlas.width = atlas.height = 64;
        const context = atlas.getContext("2d");
        context.fillStyle = color;
        context.fillRect(8, 8, 8, 8);
        window.__pixelTest.image = atlas.toDataURL();
        window.__pixelTest.data.players.find((p) => p.uuid === "alex").skin =
          `${scheme}://textures.minecraft.net/texture/${"ab".repeat(32)}`;
      },
      { scheme, color },
    );
    await refresh();
    await expect.poll(facePixel).toEqual(expected);
    expect((await last("image")).path).toMatch(
      /^https?:\/\/textures\.minecraft\.net/,
    );
    await expect
      .poll(() =>
        page
          .locator(".profile-button .skin-face")
          .evaluate((canvas) => [
            ...canvas.getContext("2d").getImageData(1, 1, 1, 1).data,
          ]),
      )
      .toEqual(expected);
  }
  expect(remoteRequests).toEqual([]);
  await page.evaluate(() => {
    window.__pixelTest.failures.image = "Texture unavailable";
  });
  await refresh();
  await expect.poll(facePixel).not.toEqual([0, 0, 255, 255]);
  expect((await facePixel())[3]).toBe(255);
  await page.evaluate(() => {
    delete window.__pixelTest.failures.image;
    window.__pixelTest.image = "/assets/steve.png";
    window.__pixelTest.data.players.find((p) => p.uuid === "alex").skin = "";
  });
  await refresh();
  check(
    "Microsoft HTTP/HTTPS skins use native image loading for preview and avatar, refresh cached pixels, and fall back after failure",
  );

  await ui.getByRole("button", { name: "离线登录", exact: true }).click();
  await page
    .getByRole("button", { name: "Microsoft 登录", exact: true })
    .click();
  await expect(ui).toHaveAttribute("data-login", "microsoft");
  await expect(ui.locator(".device-code")).toBeVisible();
  await page
    .getByRole("button", { name: "复制设备代码 TEST-CODE", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "TEST-CODE",
  );
  await page.getByRole("button", { name: "打开授权页面", exact: true }).click();
  expect((await last("plugin:opener|open_url")).url).toBe(
    "https://www.microsoft.com/link",
  );
  await page.evaluate(() => {
    const j = window.__pixelTest.tasks.jobs.at(-1);
    j.status = "failed";
    j.error = "授权已过期";
  });
  await expect(page.getByRole("alert")).toContainText("授权已过期");
  await page.getByRole("button", { name: "重新登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "重新登录", exact: true }),
  ).toHaveCount(0);
  await returnToPlayers();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => count("jobs.cancel")).toBe(1);
  await ui.getByRole("button", { name: "离线登录", exact: true }).click();
  await page
    .getByRole("button", { name: "Microsoft 登录", exact: true })
    .click();
  await expect(ui).toHaveAttribute("data-login", "microsoft");
  await expect(ui.locator(".device-code")).toBeVisible();
  await page.evaluate(() => {
    const f = window.__pixelTest;
    f.tasks.jobs.at(-1).status = "completed";
    f.data.players.push({
      uuid: "ms-new",
      name: "MS_Player",
      online: true,
      skin: "",
      slim: false,
    });
    f.data.settings.activePlayer = "ms-new";
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(ui).not.toHaveAttribute("data-login");
  await expect(ui.locator(".players-identity h2")).toHaveText("MS_Player");
  check(
    "Device code, clipboard, external auth, failure/retry, cancellation and completed login",
  );

  await page.evaluate(() => {
    window.__pixelTest.delays["players.login"] = 700;
  });
  await ui.getByRole("button", { name: "离线登录", exact: true }).click();
  await page
    .getByRole("button", { name: "Microsoft 登录", exact: true })
    .click();
  await returnToPlayers();
  await expect.poll(() => count("jobs.cancel")).toBe(2);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  check(
    "Returning during device-code loading cancels the request without reopening the login page",
  );

  await go();
  // Color landmarks in the Minecraft atlas verify back-face UVs, limb placement,
  // slim widths, legacy mirroring and the second layer independently of the UI.
  for (const [height, slim] of [
    [64, false],
    [64, true],
    [32, false],
  ]) {
    await page.evaluate(
      ({ height, slim }) => {
        const atlas = document.createElement("canvas");
        atlas.width = 64;
        atlas.height = height;
        const ctx = atlas.getContext("2d");
        const fill = (color, x, y, w, h) => {
          ctx.fillStyle = color;
          ctx.fillRect(x, y, w, h);
        };
        fill("#ff0000", 8, 8, 8, 8);
        fill("#0000ff", 24, 8, 8, 8);
        fill("#00ff00", 20, 20, 8, 12);
        fill("#ffff00", 32, 20, 8, 12);
        fill("#ffffff", 56, 8, 1, 1); // Back hat overlay.
        if (height === 64) {
          fill("#ff8000", slim ? 51 : 52, 20, slim ? 3 : 4, 12);
          fill("#8000ff", slim ? 43 : 44, 52, slim ? 3 : 4, 12);
          fill("#ff00ff", 12, 20, 4, 12);
          fill("#00ffff", 28, 52, 4, 12);
          fill("#ffffff", 32, 36, 1, 1); // Jacket overlay.
        } else {
          fill("#ff8000", 52, 20, 4, 12);
          fill("#8000ff", 55, 20, 1, 12);
          fill("#00ffff", 12, 20, 4, 12);
        }
        const f = window.__pixelTest;
        f.image = atlas.toDataURL();
        f.data.players[0].skin = `C:/Test/atlas-${height}-${slim}.png`;
        f.data.players[0].slim = slim;
      },
      { height, slim },
    );
    await refresh();
    if (
      await ui
        .getByRole("button", { name: "切换预览朝向，当前正面", exact: true })
        .count()
    )
      await ui
        .getByRole("button", { name: "切换预览朝向，当前正面", exact: true })
        .click();
    const sample = (x, y) =>
      canvas.evaluate(
        (c, { x, y }) => [...c.getContext("2d").getImageData(x, y, 1, 1).data],
        { x, y },
      );
    await expect.poll(() => sample(5, 2)).toEqual([0, 0, 255, 255]);
    expect(await sample(4, 1)).toEqual([255, 255, 255, 255]);
    expect(await sample(5, 10)).toEqual([255, 255, 0, 255]);
    expect(await sample(slim ? 1 : 0, 10)).toEqual([128, 0, 255, 255]);
    expect(await sample(12, 10)).toEqual([255, 128, 0, 255]);
    expect(await sample(5, 22)).toEqual([0, 255, 255, 255]);
    if (slim) {
      expect((await sample(0, 10))[3]).toBe(0);
      expect((await sample(15, 10))[3]).toBe(0);
    }
    if (height === 64) {
      expect(await sample(4, 9)).toEqual([255, 255, 255, 255]);
      expect(await sample(9, 22)).toEqual([255, 0, 255, 255]);
    } else {
      expect(await sample(3, 10)).toEqual([255, 128, 0, 255]);
      expect(await sample(15, 10)).toEqual([128, 0, 255, 255]);
    }
  }
  check(
    "64×64 classic/slim and 64×32 legacy back-face atlas, mirrored limbs and overlays",
  );
  await go();
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 1024, 768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      for (const view of ["grove", "gallery"]) {
        if ((await ui.getAttribute("data-view")) !== view)
          await ui.locator(".players-view-switch").click();
        await expect(page.locator("html")).not.toHaveAttribute(
          "data-player-view-transition",
        );
        const corners = await ui
          .locator(".players-scenery")
          .evaluate((scene) => {
            const rect = scene.getBoundingClientRect();
            const identity = document
              .querySelector(".players-identity")
              .getBoundingClientRect();
            const contains = (x, y) =>
              document
                .elementsFromPoint(x, y)
                .some((element) => scene.contains(element));
            return {
              beside: identity.left >= rect.right - 1,
              points: [
                contains(rect.left + 1, rect.top + 1),
                contains(rect.right - 1, rect.top + 1),
                contains(rect.left + 1, rect.bottom - 1),
                contains(rect.right - 1, rect.bottom - 1),
              ],
            };
          });
        expect(corners.points).toEqual(
          corners.beside
            ? [false, true, false, true]
            : [false, false, true, true],
        );
        const overflow = await ui.evaluate((el) => ({
          width: el.clientWidth,
          scroll: el.scrollWidth,
          cards: [...el.querySelectorAll(".players-card")].map(
            (c) => c.scrollWidth - c.clientWidth,
          ),
        }));
        expect(overflow.scroll).toBeLessThanOrEqual(overflow.width + 1);
        expect(overflow.cards.every((n) => n <= 1)).toBeTruthy();
        await shot(`${view}-${theme}-${width}`);
      }
    }
  }
  check("Both scenes fit 1440/1024/768/375px windows in light and dark themes");

  await go();
  await page.evaluate(() => {
    window.__pixelTest.data.players.push(
      ...Array.from({ length: 37 }, (_, i) => ({
        uuid: `scroll-player-${i}`,
        name: `ScrollPlayer_${i}`,
        online: false,
        skin: "",
        slim: false,
      })),
    );
  });
  await refresh();
  await expect(ui.locator(".players-card")).toHaveCount(40);
  for (const [width, height] of [
    [1440, 900],
    [1440, 600],
    [1024, 768],
    [850, 600],
    [768, 600],
    [375, 600],
    [375, 450],
  ]) {
    await page.setViewportSize({ width, height });
    for (const view of ["grove", "gallery"]) {
      if ((await ui.getAttribute("data-view")) !== view)
        await ui.locator(".players-view-switch").click();
      await expect(page.locator("html")).not.toHaveAttribute(
        "data-player-view-transition",
      );
      const list = ui.getByRole("region", { name: "角色列表", exact: true });
      const fixedRects = () =>
        ui.evaluate((el) =>
          [
            ".players-heading",
            ".player-preview",
            ".players-collection-heading",
          ].map((selector) => {
            const r = el.querySelector(selector).getBoundingClientRect();
            return [r.x, r.y, r.width, r.height];
          }),
        );
      const before = await fixedRects();
      const fit = await ui.evaluate((el) => {
        const page = el.closest(".page"),
          box = el.getBoundingClientRect(),
          list = el.querySelector(".players-cards");
        const controls = [
          ...el.querySelectorAll(
            ".player-preview button, .players-heading button, .players-collection-heading button",
          ),
        ];
        return {
          pageOverflow: page.scrollHeight - page.clientHeight,
          bodyOverflow: document.documentElement.scrollHeight - innerHeight,
          scrollable: list.scrollHeight > list.clientHeight,
          outside: controls
            .filter((control) => {
              const r = control.getBoundingClientRect();
              return (
                r.x < box.x - 1 ||
                r.right > box.right + 1 ||
                r.y < box.y - 1 ||
                r.bottom > box.bottom + 1
              );
            })
            .map((control) => control.className),
        };
      });
      expect(fit.pageOverflow).toBeLessThanOrEqual(1);
      expect(fit.bodyOverflow).toBeLessThanOrEqual(1);
      expect(fit.scrollable).toBe(true);
      expect(fit.outside).toEqual([]);
      await list.evaluate((el) => {
        el.scrollTop = 0;
      });
      await list.hover();
      await page.mouse.wheel(0, 250);
      await expect
        .poll(() => list.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(0);
      expect(await fixedRects()).toEqual(before);
      await list.locator(".players-card").last().scrollIntoViewIfNeeded();
      await list.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      const lastVisible = await list.evaluate((el) => {
        const box = el.getBoundingClientRect(),
          last = el.lastElementChild.getBoundingClientRect();
        return (
          last.bottom <= box.bottom + 1 &&
          (last.top >= box.top - 1 || last.height > el.clientHeight)
        );
      });
      expect(lastVisible).toBe(true);
      expect(await page.locator(".page").evaluate((el) => el.scrollTop)).toBe(
        0,
      );
      await shot(`${view}-fit-${width}-${height}`);
    }
  }
  check(
    "Fixed page at short and narrow sizes; only the 40-player list scrolls, with stable headings/preview and a reachable last item",
  );

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.evaluate(() => {
    window.__pixelTest.data.players = [];
    window.__pixelTest.data.settings.activePlayer = "";
    window.__pixelTest.tasks.jobs.push({
      id: "empty-refresh",
      title: "Refresh",
      status: "completed",
      steps: [],
      log: [],
    });
  });
  await expect(
    ui.getByRole("heading", { name: "暂无角色", exact: true }),
  ).toBeVisible();
  for (const view of ["grove", "gallery"]) {
    if ((await ui.getAttribute("data-view")) !== view)
      await ui.locator(".players-view-switch").click();
    await expect(
      ui.getByRole("button", { name: "离线登录", exact: true }),
    ).toHaveCount(1);
    await expect(
      ui.getByRole("button", { name: "更换皮肤", exact: true }),
    ).toBeDisabled();
    await expect(
      ui.getByRole("button", { name: "更改名称", exact: true }),
    ).toBeDisabled();
  }
  await shot("empty");
  await ui.getByRole("button", { name: "离线登录", exact: true }).click();
  await page.getByLabel("角色名称", { exact: true }).fill("FirstPlayer");
  await page.getByRole("button", { name: "创建角色", exact: true }).click();
  await expect(ui.locator(".players-identity h2")).toHaveText("FirstPlayer");
  check(
    "Empty states expose one Add entry and recover after the first account is created",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/report.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
} catch (error) {
  await shot("failure");
  throw error;
} finally {
  await browser.close();
}
