import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { playersFixture } from "./fixtures/players.mjs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { answerConfirmation } from "./lib/confirmation.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("players-implementation/profile");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1120, height: 640 } });
page.setDefaultTimeout(8000);
await page.addInitScript({
  content: `(${pixelAppFixture.toString()})(); (${playersFixture.toString()})();`,
});
const errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
const ui = page.locator(".players-page");
const dialog = (name) => page.getByRole("dialog", { name, exact: true });
const count = (operation) =>
  page.evaluate(
    (op) =>
      window.__pixelTest.requests.filter((r) => r.operation === op).length,
    operation,
  );
const last = (operation) =>
  page.evaluate(
    (op) =>
      window.__pixelTest.requests.filter((r) => r.operation === op).at(-1)
        ?.payload,
    operation,
  );
const check = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
const cancel = async (name) => {
  await dialog(name).getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog(name)).toHaveCount(0);
};
const choose = async (label, option) => {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
};
const shot = (name) =>
  page.screenshot({ path: `${evidence}/${name}.png`, animations: "disabled" });

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page.locator(".sidebar .profile-button").click();
  await ui.getByRole("button", { name: "选择角色 Alex", exact: true }).click();
  await expect(ui.locator(".players-identity h2")).toHaveText("Alex");
  await ui.getByRole("button", { name: "更换皮肤", exact: true }).click();
  await expect(dialog("更换正版皮肤")).toBeVisible();
  const skinPreview = dialog("更换正版皮肤").locator(".player-skin-preview");
  const previewPixels = () =>
    skinPreview.locator(".skin-body").evaluate((canvas) => canvas.toDataURL());
  const mainPixels = () =>
    ui
      .locator(".player-preview .skin-body")
      .evaluate((canvas) => canvas.toDataURL());
  await expect.poll(previewPixels).toBe(await mainPixels());
  await expect(dialog("更换正版皮肤")).not.toContainText("正在管理");
  await expect(dialog("更换正版皮肤")).not.toContainText("上传后会同步");
  const originalPixels = await mainPixels();
  const modelSwitch = dialog("更换正版皮肤").getByRole("switch", {
    name: "纤细模型",
    exact: true,
  });
  const armEdges = () =>
    skinPreview.locator(".skin-body").evaluate((canvas) => {
      const context = canvas.getContext("2d");
      return [
        context.getImageData(0, 13, 1, 1).data[3],
        context.getImageData(15, 13, 1, 1).data[3],
      ];
    });
  await expect(modelSwitch).toHaveAttribute("aria-checked", "true");
  await expect.poll(armEdges).toEqual([0, 0]);
  await modelSwitch.click();
  await expect(modelSwitch).toHaveAttribute("aria-checked", "false");
  await expect.poll(armEdges).toEqual([255, 255]);
  check(
    "The slim switch changes the actual arm width of the legacy default skin",
  );
  await page.evaluate(() => {
    const atlas = document.createElement("canvas");
    atlas.width = atlas.height = 64;
    const context = atlas.getContext("2d");
    context.fillStyle = "#208040";
    context.fillRect(0, 0, 64, 64);
    context.fillStyle = "#ff0000";
    context.fillRect(8, 8, 8, 8);
    context.fillStyle = "#0000ff";
    context.fillRect(24, 8, 8, 8);
    context.clearRect(32, 0, 32, 16);
    context.clearRect(0, 32, 64, 16);
    context.clearRect(0, 48, 16, 16);
    context.clearRect(48, 48, 16, 16);
    window.__pixelTest.images = { "C:/Test/skin.png": atlas.toDataURL() };
  });
  await expect(
    dialog("更换正版皮肤").getByRole("button", {
      name: "上传皮肤",
      exact: true,
    }),
  ).toBeDisabled();
  await dialog("更换正版皮肤")
    .getByRole("button", { name: "选择皮肤文件", exact: true })
    .click();
  await expect(dialog("更换正版皮肤")).toContainText("skin.png");
  const facePixel = () =>
    skinPreview
      .locator(".skin-body")
      .evaluate((canvas) => [
        ...canvas.getContext("2d").getImageData(5, 2, 1, 1).data,
      ]);
  await expect.poll(facePixel).toEqual([255, 0, 0, 255]);
  await expect(skinPreview).toHaveAttribute("data-model", "classic");
  await modelSwitch.click();
  await expect.poll(armEdges).toEqual([0, 0]);
  await modelSwitch.click();
  await expect.poll(armEdges).toEqual([255, 255]);
  expect(await mainPixels()).toBe(originalPixels);
  await dialog("更换正版皮肤")
    .getByRole("button", { name: "切换皮肤预览，当前正面", exact: true })
    .click();
  await expect.poll(facePixel).toEqual([0, 0, 255, 255]);
  await modelSwitch.click();
  await expect.poll(armEdges).toEqual([0, 0]);
  await modelSwitch.click();
  await expect.poll(armEdges).toEqual([255, 255]);
  await dialog("更换正版皮肤")
    .getByRole("button", { name: "切换皮肤预览，当前背面", exact: true })
    .click();
  await expect(skinPreview.locator(".players-figure")).toHaveAttribute(
    "data-preview-mode",
    "3d",
  );
  await expect(skinPreview.locator(".players-figure")).toHaveAttribute(
    "data-preview-status",
    "ready",
  );
  const modelWidth = () =>
    skinPreview.locator(".players-3d-surface").evaluate((canvas) => {
      const data = canvas
        .getContext("2d")
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let widest = 0;
      for (let y = 0; y < canvas.height; y++) {
        let left = canvas.width,
          right = -1;
        for (let x = 0; x < canvas.width; x++) {
          if (data[(y * canvas.width + x) * 4 + 3] > 32) {
            left = Math.min(left, x);
            right = x;
          }
        }
        widest = Math.max(widest, right - left + 1);
      }
      return widest;
    });
  await expect.poll(modelWidth).toBeGreaterThan(0);
  const classicWidth = await modelWidth();
  // Model changes must not wait for the browser to decode the same textures again.
  await page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode;
    window.__modelDecodeCalls = 0;
    window.__restoreModelDecode = () => {
      HTMLImageElement.prototype.decode = decode;
    };
    HTMLImageElement.prototype.decode = function () {
      window.__modelDecodeCalls++;
      return new Promise(() => {});
    };
  });
  await modelSwitch.click();
  await expect.poll(modelWidth).toBeLessThan(classicWidth);
  await modelSwitch.click();
  await expect.poll(modelWidth).toBe(classicWidth);
  expect(await page.evaluate(() => window.__modelDecodeCalls)).toBe(0);
  await page.evaluate(() => {
    window.__restoreModelDecode();
    delete window.__restoreModelDecode;
  });
  check(
    "The slim switch updates front/back arm pixels and 3D geometry without waiting for texture decoding, and toggles back to classic",
  );
  await shot("skin-3d-draft");
  await dialog("更换正版皮肤")
    .getByRole("button", { name: "切换皮肤预览，当前3D", exact: true })
    .click();
  await expect.poll(facePixel).toEqual([255, 0, 0, 255]);
  check(
    "Skin dialog shares the current preview, renders chosen skin in front/back/3D, and preserves the saved appearance before upload",
  );
  const chosenPixels = await previewPixels();
  await page.evaluate(() => {
    window.__pixelTest.failures["players.skin.preview"] = "皮肤读取失败";
  });
  await dialog("更换正版皮肤")
    .getByRole("button", { name: "选择皮肤文件", exact: true })
    .click();
  await expect(dialog("更换正版皮肤").getByRole("alert")).toContainText(
    "皮肤读取失败",
  );
  expect(await previewPixels()).toBe(chosenPixels);
  await expect(dialog("更换正版皮肤")).toContainText("skin.png");
  await page.evaluate(() => {
    delete window.__pixelTest.failures["players.skin.preview"];
  });
  expect(await count("players.skin")).toBe(0);
  await page.evaluate(() => {
    window.__pixelTest.pick = null;
  });
  await dialog("更换正版皮肤")
    .getByRole("button", { name: "选择皮肤文件", exact: true })
    .click();
  await expect(dialog("更换正版皮肤")).toContainText("skin.png");
  expect(await previewPixels()).toBe(chosenPixels);
  await shot("skin-light");
  await page.evaluate(() => {
    window.__pixelTest.failures["players.skin"] = "皮肤上传失败";
  });
  await dialog("更换正版皮肤")
    .getByRole("button", { name: "上传皮肤", exact: true })
    .click();
  await expect(dialog("更换正版皮肤").getByRole("alert")).toContainText(
    "皮肤上传失败",
  );
  expect(
    await page.evaluate(() => window.__pixelTest.data.players[1].skin),
  ).toBe("");
  await page.evaluate(() => {
    delete window.__pixelTest.failures["players.skin"];
    window.__pixelTest.delays["players.skin"] = 700;
  });
  await dialog("更换正版皮肤")
    .getByRole("button", { name: "上传皮肤", exact: true })
    .click();
  await expect(
    dialog("更换正版皮肤").getByRole("button", {
      name: "正在保存…",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    dialog("更换正版皮肤").getByRole("button", {
      name: "关闭对话框",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(dialog("更换正版皮肤")).toHaveCount(0);
  expect(await last("players.skin")).toEqual({
    id: "alex",
    path: "C:/Test/skin.png",
    slim: false,
  });
  await expect(
    ui.getByRole("button", { name: "切换模型，当前经典模型" }),
  ).toBeVisible();
  expect(await count("plugin:opener|open_url")).toBe(0);
  check(
    "Skin uploads the chosen file and model, cancelled pickers retain the file, failures stay editable, and saving cannot double-submit",
  );

  const beforeReset = await count("players.skin");
  await ui.getByRole("button", { name: "重置皮肤", exact: true }).click();
  await answerConfirmation(page, false);
  expect(await count("players.skin")).toBe(beforeReset);
  await ui.getByRole("button", { name: "重置皮肤", exact: true }).click();
  await answerConfirmation(page, true);
  await expect.poll(() => count("players.skin")).toBe(beforeReset + 1);
  await expect(
    ui.getByRole("button", { name: "更换皮肤", exact: true }),
  ).toBeEnabled();
  expect(await last("players.skin")).toEqual({
    id: "alex",
    path: null,
    slim: false,
  });
  check("Online skin reset requires confirmation and uses the account API");

  await page.evaluate(() => {
    window.__pixelTest.failures["players.capes"] = "披风列表加载失败";
    const atlas = (outside, inside) => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 32;
      const context = canvas.getContext("2d");
      context.fillStyle = outside;
      context.fillRect(0, 0, 64, 32);
      context.fillStyle = inside;
      context.fillRect(12, 1, 10, 16);
      return canvas.toDataURL();
    };
    Object.assign(window.__pixelTest.images, {
      "https://textures.minecraft.net/texture/cd": atlas("#ff00ff", "#0044ff"),
      "https://textures.minecraft.net/texture/ef": atlas("#00ff00", "#ff8800"),
    });
  });
  const capePreview = dialog("更换披风").locator(".player-cape-preview");
  const capePixel = (x = 5, y = 13) =>
    capePreview
      .locator(".skin-body")
      .evaluate(
        (canvas, { x, y }) => [
          ...canvas.getContext("2d").getImageData(x, y, 1, 1).data,
        ],
        { x, y },
      );
  const cape3dPixels = () =>
    capePreview.locator(".players-3d-surface").evaluate((canvas) => {
      const data = canvas
        .getContext("2d")
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let pink = 0,
        green = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] !== 255) continue;
        if (data[i] > 100 && data[i + 1] < 60 && data[i + 2] > 100) pink++;
        if (data[i] < 60 && data[i + 1] > 100 && data[i + 2] < 60) green++;
      }
      return { pink, green };
    });
  const savedCapePixels = await mainPixels();
  const beforeCapes = await count("players.capes");
  await ui.getByRole("button", { name: "更换披风", exact: true }).click();
  await expect(capePreview.locator(".players-figure")).toHaveAttribute(
    "data-preview-mode",
    "back",
  );
  await choose("账号披风", "Migrator");
  await expect.poll(() => capePixel()).toEqual([255, 0, 255, 255]);
  await dialog("更换披风")
    .getByRole("button", { name: "切换披风预览，当前背面", exact: true })
    .click();
  await expect
    .poll(async () => (await cape3dPixels()).pink)
    .toBeGreaterThan(50);
  await choose("账号披风", "不佩戴披风");
  await expect.poll(async () => (await cape3dPixels()).pink).toBe(0);
  await choose("账号披风", "Migrator");
  await expect
    .poll(async () => (await cape3dPixels()).pink)
    .toBeGreaterThan(50);
  await shot("cape-3d-draft");
  await dialog("更换披风")
    .getByRole("button", { name: "切换披风预览，当前3D", exact: true })
    .click();
  await expect.poll(() => capePixel(3, 23)).toEqual([0, 68, 255, 255]);
  expect(await capePixel()).not.toEqual([255, 0, 255, 255]);
  await dialog("更换披风")
    .getByRole("button", { name: "切换披风预览，当前正面", exact: true })
    .click();
  await expect.poll(() => capePixel()).toEqual([255, 0, 255, 255]);
  expect(await mainPixels()).toBe(savedCapePixels);
  expect(await count("players.cape")).toBe(0);
  expect(
    await page.evaluate(() => window.__pixelTest.data.players[1].cape || ""),
  ).toBe("");
  check(
    "Cape drafts render the outside in back view, behind the skin in front view, and in 3D; removal previews immediately without changing the saved account",
  );
  await expect(dialog("更换披风").getByRole("status")).toHaveCount(0);
  expect(await count("players.capes")).toBe(beforeCapes);
  await cancel("更换披风");
  await ui.getByRole("button", { name: "更换披风", exact: true }).click();
  expect(await count("players.capes")).toBe(beforeCapes);
  await dialog("更换披风")
    .getByRole("button", { name: "刷新披风", exact: true })
    .click();
  await expect(dialog("更换披风").getByRole("alert")).toContainText(
    "披风列表加载失败",
  );
  await expect(
    dialog("更换披风").getByRole("button", { name: "保存披风", exact: true }),
  ).toBeEnabled();
  await choose("账号披风", "Migrator");
  expect(await last("players.capes")).toEqual({ id: "alex", refresh: true });
  await page.evaluate(() => {
    delete window.__pixelTest.failures["players.capes"];
    window.__pixelTest.delays["players.capes"] = 500;
    window.__pixelTest.capes.push({
      id: "vanilla-cape",
      name: "Vanilla",
      url: "https://textures.minecraft.net/texture/ef",
      active: false,
    });
  });
  await choose("账号披风", "Migrator");
  await dialog("更换披风")
    .getByRole("button", { name: "刷新披风", exact: true })
    .click();
  await expect(
    dialog("更换披风").getByRole("button", { name: "刷新披风", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog("更换披风").getByRole("combobox", { name: "账号披风" }),
  ).toBeEnabled();
  await dialog("更换披风").getByRole("combobox", { name: "账号披风" }).click();
  await expect(
    page.getByRole("option", { name: "Vanilla", exact: true }),
  ).toBeVisible();
  await dialog("更换披风").getByRole("combobox", { name: "账号披风" }).click();
  await expect(
    dialog("更换披风").getByRole("combobox", { name: "账号披风" }),
  ).toHaveText("Migrator");
  await choose("账号披风", "Vanilla");
  await expect.poll(() => capePixel()).toEqual([0, 255, 0, 255]);
  await choose("账号披风", "Migrator");
  await expect.poll(() => capePixel()).toEqual([255, 0, 255, 255]);
  expect(await count("players.capes")).toBe(beforeCapes + 2);
  await page.evaluate(() => {
    delete window.__pixelTest.delays["players.capes"];
  });
  await shot("cape-light");
  await dialog("更换披风")
    .getByRole("button", { name: "保存披风", exact: true })
    .click();
  await expect(dialog("更换披风")).toHaveCount(0);
  expect(await last("players.cape")).toEqual({
    id: "alex",
    capeId: "migrator-cape",
  });
  await ui.getByRole("button", { name: "更换披风", exact: true }).click();
  expect(await count("players.capes")).toBe(beforeCapes + 2);
  await expect(
    page.getByRole("combobox", { name: "账号披风", exact: true }),
  ).toContainText("Migrator（当前佩戴）");
  await choose("账号披风", "不佩戴披风");
  await dialog("更换披风")
    .getByRole("button", { name: "保存披风", exact: true })
    .click();
  await expect(dialog("更换披风")).toHaveCount(0);
  expect(await last("players.cape")).toEqual({ id: "alex", capeId: null });
  await page.evaluate(() => {
    window.__pixelTest.capes = [];
  });
  await ui.getByRole("button", { name: "更换披风", exact: true }).click();
  await expect(dialog("更换披风")).toContainText(
    "只能使用此账号已获得的官方披风",
  );
  await dialog("更换披风")
    .getByRole("button", { name: "刷新披风", exact: true })
    .click();
  await expect(dialog("更换披风")).toContainText("此账号尚未获得官方披风");
  await cancel("更换披风");
  const emptyCacheRequests = await count("players.capes");
  await ui.getByRole("button", { name: "更换披风", exact: true }).click();
  await expect(dialog("更换披风")).toContainText("此账号尚未获得官方披风");
  expect(await count("players.capes")).toBe(emptyCacheRequests);
  await cancel("更换披风");
  check(
    "Cape dialogs reuse login and empty caches; explicit refresh loads new ownership, preserves draft selection, and failures retain usable cached capes",
  );

  await page.evaluate(() => {
    window.__pixelTest.nameChange.nameChangeAllowed = false;
  });
  await ui.getByRole("button", { name: "更改名称", exact: true }).click();
  await expect(dialog("更改角色名称")).toContainText("此账号暂时不能改名");
  await dialog("更改角色名称")
    .getByLabel("新的名称", { exact: true })
    .fill("Alex_New");
  await expect(
    dialog("更改角色名称").getByRole("button", {
      name: "保存名称",
      exact: true,
    }),
  ).toBeDisabled();
  expect(await count("players.rename")).toBe(0);
  await cancel("更改角色名称");
  await page.evaluate(() => {
    window.__pixelTest.nameChange.nameChangeAllowed = true;
    window.__pixelTest.failures["players.namechange"] = "资格查询失败";
  });
  await ui.getByRole("button", { name: "更改名称", exact: true }).click();
  await expect(dialog("更改角色名称").getByRole("alert")).toContainText(
    "资格查询失败",
  );
  await page.evaluate(() => {
    delete window.__pixelTest.failures["players.namechange"];
  });
  await dialog("更改角色名称")
    .getByRole("button", { name: "重新获取", exact: true })
    .click();
  const newName = dialog("更改角色名称").getByLabel("新的名称", {
    exact: true,
  });
  await newName.fill("ab");
  await expect(
    dialog("更改角色名称").getByRole("button", {
      name: "保存名称",
      exact: true,
    }),
  ).toBeDisabled();
  await newName.fill("Alex_New");
  await expect(
    dialog("更改角色名称").getByRole("button", {
      name: "保存名称",
      exact: true,
    }),
  ).toBeEnabled();
  await page.evaluate(() => {
    window.__pixelTest.failures["players.rename"] = "此游戏名已被占用";
  });
  await dialog("更改角色名称")
    .getByRole("button", { name: "保存名称", exact: true })
    .click();
  await expect(dialog("更改角色名称").getByRole("alert")).toContainText(
    "此游戏名已被占用",
  );
  await expect(ui.locator(".players-identity h2")).toHaveText("Alex");
  await page.evaluate(() => {
    delete window.__pixelTest.failures["players.rename"];
  });
  await dialog("更改角色名称")
    .getByRole("button", { name: "保存名称", exact: true })
    .click();
  await expect(dialog("更改角色名称")).toHaveCount(0);
  await expect(ui.locator(".players-identity h2")).toHaveText("Alex_New");
  expect(await last("players.rename")).toEqual({
    id: "alex",
    name: "Alex_New",
  });
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.activePlayer),
  ).toBe("alex");
  expect(
    await page.evaluate(() => window.__pixelTest.data.players[1].uuid),
  ).toBe("alex");
  check(
    "Online rename checks eligibility and minimum length, preserves UUID and selection, and leaves failures open for correction",
  );

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    window.__pixelTest.delays["players.capes"] = 900;
  });
  await ui.getByRole("button", { name: "更换披风", exact: true }).click();
  await dialog("更换披风")
    .getByRole("button", { name: "刷新披风", exact: true })
    .click();
  await expect(dialog("更换披风")).toContainText("正在获取账号拥有的披风");
  await cancel("更换披风");
  await ui.getByRole("button", { name: "更改名称", exact: true }).click();
  await expect(
    dialog("更改角色名称").getByLabel("新的名称", { exact: true }),
  ).toHaveValue("Alex_New");
  await shot("rename-dark");
  await cancel("更改角色名称");
  await page.setViewportSize({ width: 375, height: 700 });
  await ui.getByRole("button", { name: "更换皮肤", exact: true }).click();
  await expect(dialog("更换正版皮肤")).toBeVisible();
  const bounds = await dialog("更换正版皮肤").boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(375);
  await shot("skin-mobile-dark");
  await cancel("更换正版皮肤");
  await ui.getByRole("button", { name: "更换披风", exact: true }).click();
  const capeBounds = await dialog("更换披风").boundingBox();
  expect(capeBounds.x).toBeGreaterThanOrEqual(0);
  expect(capeBounds.x + capeBounds.width).toBeLessThanOrEqual(375);
  await expect(capePreview).toBeVisible();
  await shot("cape-mobile-dark");
  await cancel("更换披风");
  expect(errors).toEqual([]);
  check(
    "Late loads cannot replace another dialog; dialogs fit narrow windows and both themes without browser errors",
  );
  const legacyPage = await browser.newPage();
  legacyPage.on("pageerror", (error) => errors.push(error.message));
  await legacyPage.addInitScript(pixelAppFixture);
  await legacyPage.addInitScript(playersFixture);
  await legacyPage.addInitScript(() => {
    delete window.__pixelTest.data.players[1].capes;
  });
  await legacyPage.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await legacyPage.locator(".sidebar .profile-button").click();
  const legacyUi = legacyPage.locator(".players-page");
  await legacyUi
    .getByRole("button", { name: "选择角色 Alex", exact: true })
    .click();
  for (let attempt = 0; attempt < 2; attempt++) {
    await legacyUi
      .getByRole("button", { name: "更换披风", exact: true })
      .click();
    const capeDialog = legacyPage.getByRole("dialog", {
      name: "更换披风",
      exact: true,
    });
    await expect(
      capeDialog.getByRole("combobox", { name: "账号披风" }),
    ).toBeVisible();
    expect(
      await legacyPage.evaluate(
        () =>
          window.__pixelTest.requests.filter(
            (request) => request.operation === "players.capes",
          ).length,
      ),
    ).toBe(1);
    await capeDialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(capeDialog).toHaveCount(0);
  }
  await legacyPage.close();
  expect(errors).toEqual([]);
  check(
    "An older account with no cape cache fetches once, persists the result, and reopens without another request",
  );
  await writeFile(
    `${evidence}/result.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
} catch (error) {
  await shot("failure");
  throw error;
} finally {
  await browser.close();
}
