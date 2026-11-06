import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { playersFixture } from "./fixtures/players.mjs";
import { runtimePath } from "./lib/paths.mjs";

const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/";
const evidence = runtimePath("evidence/player-reorder");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const errors = [],
  checks = [];
const fixture = () => {
  const state = window.__pixelTest;
  const saved = sessionStorage.getItem("test-player-order");
  if (saved) {
    const value = JSON.parse(saved);
    state.data.players = value.players;
    state.data.settings.activePlayer = value.active;
  } else {
    state.data.players.push(
      ...Array.from({ length: 21 }, (_, i) => ({
        uuid: `extra-${i}`,
        name: `Player_${i}`,
        online: false,
        skin: "",
        slim: false,
      })),
    );
  }
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    const value = await invoke(command, args);
    if (command === "request" && args.operation.startsWith("players.")) {
      sessionStorage.setItem(
        "test-player-order",
        JSON.stringify({
          players: state.data.players,
          active: state.data.settings.activePlayer,
        }),
      );
    }
    return value;
  };
};
const createPage = async (touch = false) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    hasTouch: touch,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(pixelAppFixture);
  await page.addInitScript(playersFixture);
  await page.addInitScript(fixture);
  return page;
};
const list = (page) => page.locator(".players-cards");
const row = (page, id) => list(page).locator(`[data-player-key="${id}"]`);
const order = (page) =>
  list(page)
    .locator(".players-card")
    .evaluateAll((rows) => rows.map((row) => row.dataset.playerKey));
const count = (page, operation) =>
  page.evaluate(
    (op) =>
      window.__pixelTest.requests.filter((r) => r.operation === op).length,
    operation,
  );
const point = async (locator) => {
  const rect = await locator.boundingBox();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
};
const ready = async (page) => {
  await page.goto(url);
  await expect(page.locator("html")).not.toHaveAttribute("data-startup", {
    timeout: 30000,
  });
  await page.locator(".sidebar .profile-button").click();
  await expect(page.locator("html")).not.toHaveAttribute("data-startup");
  await expect(list(page).locator(".players-card")).toHaveCount(24);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450);
};
const start = async (page, id, wholeCard = false) => {
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-player-view-transition",
  );
  const card = row(page, id);
  await card.scrollIntoViewIfNeeded();
  const rect = await card.boundingBox();
  const from = wholeCard
    ? { x: rect.x + 4, y: rect.y + rect.height / 2 }
    : await point(card.locator(".players-select"));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y, { steps: 2 });
  try {
    await expect(card).toHaveAttribute("data-player-placeholder", "true");
  } catch (error) {
    await page.screenshot({ path: `${evidence}/failed-start.png` });
    console.log(
      await page.evaluate(
        ({ x, y }) => ({
          target: document.elementFromPoint(x, y)?.outerHTML.slice(0, 500),
          bounds: document
            .querySelector(".players-cards")
            ?.getBoundingClientRect()
            .toJSON(),
          busy: document.querySelector(".players-cards")?.dataset
            .playerSortable,
        }),
        from,
      ),
    );
    throw error;
  }
  await expect(page.locator(".players-drag-overlay")).toHaveCount(1);
  const overlay = await page.locator(".players-drag-overlay").boundingBox();
  expect(overlay.x + overlay.width / 2).toBeCloseTo(
    rect.x + rect.width / 2 + 10,
    0,
  );
  expect(overlay.y + overlay.height / 2).toBeCloseTo(
    rect.y + rect.height / 2,
    0,
  );
  const face = await card
    .locator("canvas")
    .evaluate((node) => node.toDataURL());
  expect(
    await page
      .locator(".players-drag-overlay canvas")
      .evaluate((node) => node.toDataURL()),
  ).toBe(face);
};
const release = async (page) => {
  await page.mouse.up();
  await expect(page.locator(".players-drag-overlay")).toHaveCount(0);
  await expect(list(page).locator("[data-player-placeholder]")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveAttribute(
    "data-player-dragging",
  );
};
const swap = async (page, id, to, wholeCard = false) => {
  await start(page, id, wholeCard);
  const destination = await point(row(page, to));
  await page.mouse.move(destination.x, destination.y);
  const preview = await order(page);
  await page.waitForTimeout(350);
  expect(await order(page)).toEqual(preview);
  const view = await page.locator(".players-page").getAttribute("data-view");
  await page.screenshot({ path: `${evidence}/drag-${view}.png` });
  await release(page);
};
const check = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
try {
  const page = await createPage();
  await ready(page);
  await row(page, "alex").locator(".players-select").click();
  await expect(row(page, "alex")).toHaveClass(/selected/);
  const selectedWrites = await count(page, "players.select");
  const before = await order(page);
  await swap(page, "steve", "builder");
  const reordered = [before[1], before[2], before[0], ...before.slice(3)];
  expect(await order(page)).toEqual(reordered);
  expect(
    await page.evaluate(() =>
      window.__pixelTest.data.players.map((p) => p.uuid),
    ),
  ).toEqual(reordered);
  expect(await count(page, "players.select")).toBe(selectedWrites);
  await expect(row(page, "alex")).toHaveClass(/selected/);
  check(
    "List dragging persists order, preserves avatar pixels and active selection, and suppresses release clicks.",
  );
  const unchangedWrites = await count(page, "players.reorder");
  await start(page, "builder");
  await release(page);
  expect(await count(page, "players.reorder")).toBe(unchangedWrites);

  await page.reload();
  await page.locator(".sidebar .profile-button").click();
  await expect.poll(() => order(page)).toEqual(reordered);
  await page.locator(".players-view-switch").click();
  await expect(page.locator(".players-page")).toHaveAttribute(
    "data-view",
    "gallery",
  );
  await page.waitForTimeout(500);
  const galleryBefore = await order(page);
  await swap(page, "alex", "extra-2", true);
  const galleryOrder = [
    ...galleryBefore.slice(1, 6),
    galleryBefore[0],
    ...galleryBefore.slice(6),
  ];
  expect(await order(page)).toEqual(galleryOrder);
  await expect(row(page, "alex")).toHaveClass(/selected/);
  await page.screenshot({ path: `${evidence}/cards.png` });
  await page.reload();
  await page.locator(".sidebar .profile-button").click();
  await expect.poll(() => order(page)).toEqual(galleryOrder);
  await page.locator(".players-view-switch").click();
  await page.waitForTimeout(500);
  expect(await order(page)).toEqual(galleryOrder);
  check(
    "Whole cards reorder across grid rows; both layouts and reload share the stored order.",
  );

  const writes = await count(page, "players.reorder");
  await start(page, "builder");
  let destination = await point(row(page, "steve"));
  await page.mouse.move(destination.x, destination.y);
  await page.keyboard.press("Escape");
  await release(page);
  expect(await order(page)).toEqual(galleryOrder);
  expect(await count(page, "players.reorder")).toBe(writes);
  expect(await count(page, "players.select")).toBe(0);

  await start(page, "builder");
  await page.locator(".players-view-switch").evaluate((node) => node.click());
  await release(page);
  await page.waitForTimeout(500);
  expect(await order(page)).toEqual(galleryOrder);
  await start(page, "builder");
  await page
    .locator("#sidebar-navigation button")
    .first()
    .evaluate((node) => node.click());
  await page.mouse.up();
  await expect(page.locator(".players-drag-overlay")).toHaveCount(0);
  await page.locator(".sidebar .profile-button").click();
  expect(await order(page)).toEqual(galleryOrder);
  check(
    "Escape, switching layout and leaving the page cancel dragging without saving or changing selection.",
  );

  await page.locator(".players-view-switch").click();
  await page.waitForTimeout(500);
  await start(page, "builder");
  const bounds = await list(page).boundingBox();
  const scrollBefore = await list(page).evaluate((node) => node.scrollTop);
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height - 10,
  );
  await expect
    .poll(() => list(page).evaluate((node) => node.scrollTop))
    .toBeGreaterThan(scrollBefore + 150);
  await page.keyboard.press("Escape");
  await release(page);
  expect(await order(page)).toEqual(galleryOrder);
  await list(page).evaluate((node) => (node.scrollTop = 0));
  await page.screenshot({ path: `${evidence}/list.png` });
  check(
    "Dragging near the list edge scrolls long lists and cancellation restores their original order.",
  );

  // A slow save must not overwrite a newer drag; a failed save must restore server order.
  await page.evaluate(
    () => (window.__pixelTest.delays["players.reorder"] = 600),
  );
  await swap(page, "builder", "steve");
  await swap(page, "builder", "extra-0");
  const rapidOrder = await order(page);
  await expect
    .poll(() =>
      page.evaluate(() => window.__pixelTest.data.players.map((p) => p.uuid)),
    )
    .toEqual(rapidOrder);
  await page.evaluate(() => {
    delete window.__pixelTest.delays["players.reorder"];
    window.__pixelTest.failures["players.reorder"] = "测试排序保存失败";
  });
  await swap(page, rapidOrder[0], rapidOrder[2]);
  await expect.poll(() => order(page)).toEqual(rapidOrder);
  await expect(page.getByText(/测试排序保存失败/).first()).toBeVisible();
  await page.evaluate(
    () => delete window.__pixelTest.failures["players.reorder"],
  );
  check(
    "Consecutive drags serialize persistence without stale rollback; failed saves restore server order and report the error.",
  );

  const control = row(page, rapidOrder[0]).locator(".players-select");
  await control.focus();
  await page.keyboard.press("Alt+ArrowDown");
  const keyboardOrder = [rapidOrder[1], rapidOrder[0], ...rapidOrder.slice(2)];
  await expect.poll(() => order(page)).toEqual(keyboardOrder);
  await expect(control).toBeFocused();
  const noAction = await count(page, "players.remove");
  const remove = row(page, rapidOrder[0]).locator(".players-remove");
  const removePoint = await point(remove);
  await page.mouse.move(removePoint.x, removePoint.y);
  await page.mouse.down();
  await page.mouse.move(removePoint.x - 22, removePoint.y);
  await page.waitForTimeout(450);
  await expect(page.locator(".players-drag-overlay")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await page.mouse.up();
  expect(await count(page, "players.remove")).toBe(noAction);
  check(
    "Keyboard reordering retains focus and action buttons do not initiate a drag.",
  );

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__pixelTest.data.players.map((player) => player.uuid),
      ),
    )
    .toEqual(keyboardOrder);
  const membershipWrites = await count(page, "players.reorder");
  await row(page, "steve").locator(".players-select").click();
  await expect(row(page, "steve")).toHaveClass(/selected/);
  await start(page, keyboardOrder[0]);
  await page.evaluate((removed) => {
    const state = window.__pixelTest;
    state.data.players = state.data.players.filter(
      (player) => player.uuid !== removed,
    );
    state.data.players.push({
      uuid: "new-player",
      name: "New_Player",
      online: false,
      skin: "",
      slim: false,
    });
    document.querySelector(".players-model").click();
  }, keyboardOrder[0]);
  await expect(page.locator(".players-drag-overlay")).toHaveCount(0);
  await release(page);
  await expect
    .poll(() => order(page))
    .toEqual([...keyboardOrder.slice(1), "new-player"]);
  expect(await count(page, "players.reorder")).toBe(membershipWrites);
  await expect(row(page, "steve")).toHaveClass(/selected/);
  check(
    "Account membership changes and refresh cancel a drag and preserve new accounts without saving the stale order.",
  );

  const touch = await createPage(true);
  await ready(touch);
  const client = await touch.context().newCDPSession(touch);
  const from = await point(row(touch, "steve").locator(".players-select"));
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [from],
  });
  await touch.waitForTimeout(470);
  await expect(row(touch, "steve")).toHaveAttribute(
    "data-player-placeholder",
    "true",
  );
  destination = await point(row(touch, "builder"));
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [destination],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(touch.locator(".players-drag-overlay")).toHaveCount(0);
  await expect
    .poll(() => order(touch))
    .toEqual(["alex", "builder", "steve", ...before.slice(3)]);
  expect(await count(touch, "players.select")).toBe(0);
  check(
    "Touch long-press reorders without selecting the dragged player on release.",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
} finally {
  await browser.close();
}
