import { expect } from "@playwright/test";
import { answerConfirmation } from "./lib/confirmation.mjs";

export async function verifyPlayerSelection(page, check) {
  const ui = page.locator(".players-page");
  const title = ui.locator(".players-identity h2");
  const select = (name) =>
    ui.getByRole("button", { name: `选择角色 ${name}`, exact: true });
  const requests = (operation) =>
    page.evaluate(
      (op) => window.__pixelTest.requests.filter((r) => r.operation === op),
      operation,
    );

  for (const view of ["grove", "gallery"]) {
    if ((await ui.getAttribute("data-view")) !== view)
      await ui.locator(".players-view-switch").click();
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-player-view-transition",
    );
    const card = ui.locator(".players-card").filter({
      has: page.getByRole("button", { name: "选择角色 Alex", exact: true }),
    });
    const cardBox = await card.boundingBox();
    const actionsBox = await card.locator(".players-row-actions").boundingBox();
    const actionBox = await card
      .getByRole("button", { name: "刷新 Alex 登录", exact: true })
      .boundingBox();
    const gaps = [
      { x: cardBox.x + cardBox.width - 4, y: cardBox.y + 24 },
      view === "grove"
        ? { x: actionsBox.x + actionBox.width / 2, y: cardBox.y + 4 }
        : { x: cardBox.x + 24, y: actionsBox.y + actionsBox.height / 2 },
      {
        x: actionBox.x + actionBox.width + 3,
        y: actionsBox.y + actionsBox.height / 2,
      },
    ];
    for (const point of gaps) {
      await select("Steve").click();
      await expect(select("Steve")).toHaveAttribute("aria-pressed", "true");
      const before = (await requests("players.select")).length;
      await page.mouse.click(point.x, point.y);
      await expect(select("Alex")).toHaveAttribute("aria-pressed", "true");
      expect((await requests("players.select")).length).toBe(before + 1);
    }
    await select("Steve").click();
    await expect(select("Steve")).toHaveAttribute("aria-pressed", "true");
    const beforeActions = (await requests("players.select")).length;
    await card
      .getByRole("button", { name: "刷新 Alex 登录", exact: true })
      .click();
    await expect(select("Steve")).toBeEnabled();
    await card.getByRole("button", { name: "移除 Alex", exact: true }).click();
    await answerConfirmation(page, false);
    await expect(select("Steve")).toBeEnabled();
    expect((await requests("players.select")).length).toBe(beforeActions);
    await expect(select("Steve")).toHaveAttribute("aria-pressed", "true");
  }
  check(
    "Card padding, action-row/column blanks and button gaps select exactly once in both views; refresh and remove stay independent",
  );

  // Load a cached local skin as well as the default avatars before measuring.
  await page.evaluate(() => {
    window.__pixelTest.data.players[1].skin = "C:/Test/cached-alex.png";
  });
  await ui.getByRole("button", { name: "刷新 Alex 登录", exact: true }).click();
  // Finish the refresh's final rotation before measuring unrelated selection.
  await expect(
    ui.getByRole("button", { name: "刷新 Alex 登录", exact: true }),
  ).toBeEnabled();
  await expect
    .poll(async () => (await requests("image")).length)
    .toBeGreaterThan(0);

  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const view of ["grove", "gallery"]) {
      if ((await ui.getAttribute("data-view")) !== view)
        await ui.locator(".players-view-switch").click();
      await expect(page.locator("html")).not.toHaveAttribute(
        "data-player-view-transition",
      );
      await page.mouse.move(1, 1);
      await page.evaluate(() => document.activeElement?.blur());
      await page.waitForTimeout(400);
      const target =
        (await title.textContent()) === "Steve" ? "Builder_07" : "Steve";
      const originalTitle = await title.textContent();
      await ui.evaluate((root) => {
        const controls = [
          ...root.querySelectorAll(
            '.players-heading button, .players-row-actions button, .players-actions button, .players-model, .players-view-switch, .players-select[aria-label="选择角色 Alex"]',
          ),
        ];
        const cards = [...root.querySelectorAll(".players-card")];
        const avatars = [...root.querySelectorAll(".players-avatar canvas")];
        const style = (element, pseudo) => {
          const s = getComputedStyle(element, pseudo);
          return [s.opacity, s.color, s.backgroundColor, s.transform, s.inset];
        };
        const sample = () =>
          JSON.stringify({
            controls: controls.map((element) => ({
              connected: element.isConnected,
              disabled: element.disabled,
              style: style(element),
              frames: [...element.querySelectorAll(".surface-frame")].map(
                (frame) => [
                  style(frame),
                  style(frame, "::before"),
                  style(frame, "::after"),
                ],
              ),
            })),
            cards: cards.map((element) => {
              const r = element.getBoundingClientRect();
              return [r.x, r.y, r.width, r.height];
            }),
            avatars: avatars.map((canvas, index) => [
              canvas === root.querySelectorAll(".players-avatar canvas")[index],
              canvas.toDataURL(),
            ]),
          });
        const before = sample();
        let frames = 0,
          changes = 0,
          frame;
        const tick = () => {
          frames++;
          if (sample() !== before) changes++;
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        window.__stopSelectionFrames = () => {
          cancelAnimationFrame(frame);
          return { frames, changes };
        };
        window.__pixelTest.requests.length = 0;
        window.__pixelTest.delays["players.select"] = 700;
      });
      await select(target).click();
      await expect
        .poll(async () => (await requests("players.select")).length)
        .toBe(1);
      await expect(title).toHaveText(originalTitle);
      await expect(title).toHaveText(target);
      await expect(select(target)).toHaveAttribute("aria-pressed", "true");
      await page.waitForTimeout(400);
      const samples = await page.evaluate(() => window.__stopSelectionFrames());
      expect(samples.frames).toBeGreaterThan(10);
      expect(samples.changes).toBe(0);
      expect(await requests("bootstrap")).toEqual([]);
      expect(await requests("versions.list")).toEqual([]);
      expect(await requests("image")).toEqual([]);
      await expect(ui.locator(".players-selected")).toHaveCount(0);
      await expect(ui.locator(".players-cards")).not.toContainText("使用中");
    }
  }
  check(
    "Selection preserves unrelated button styles, card geometry and avatar pixels on every frame in both views/themes, without data/image reloads or the removed indicator",
  );

  await page.evaluate(() => {
    window.__pixelTest.delays["players.select"] = 350;
    window.__pixelTest.failures["players.select"] = "选择角色保存失败";
  });
  await select("Builder_07").click();
  await expect(page.getByRole("alert")).toContainText("选择角色保存失败");
  await expect(title).toHaveText("Steve");
  await expect(select("Steve")).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.activePlayer),
  ).toBe("steve");
  await page.evaluate(() => {
    delete window.__pixelTest.failures["players.select"];
    window.__pixelTest.delays["players.select"] = 0;
  });
  await select("Builder_07").click();
  await expect(title).toHaveText("Builder_07");
  await expect(page.getByRole("alert")).toHaveCount(0);
  check(
    "Failed selections retain the persisted character and report the error; the next selection still succeeds",
  );

  // Delay the first write only: parallel requests would persist in reverse order.
  await select("Steve").click();
  await expect(title).toHaveText("Steve");
  await page.evaluate(() => {
    window.__pixelTest.requests.length = 0;
    window.__pixelTest.delays["players.select"] = 700;
  });
  await select("Alex").click();
  await expect
    .poll(async () => (await requests("players.select")).length)
    .toBe(1);
  await page.evaluate(() => {
    window.__pixelTest.delays["players.select"] = 0;
  });
  await select("Steve").click();
  expect(await requests("players.select")).toHaveLength(1);
  await expect
    .poll(async () => (await requests("players.select")).length)
    .toBe(2);
  await expect(select("Steve")).toHaveAttribute("aria-pressed", "true");
  await expect(title).toHaveText("Steve");
  expect((await requests("players.select")).map((r) => r.payload.id)).toEqual([
    "alex",
    "steve",
  ]);
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.activePlayer),
  ).toBe("steve");
  check(
    "Rapid clicks persist in order, including returning to the previous character before the first response",
  );

  // Hold a completed-job refresh after it has captured the old active player.
  await page.evaluate(() => {
    window.__pixelTest.requests.length = 0;
    window.__pixelTest.delays["versions.list"] = 800;
    window.__pixelTest.tasks.jobs.push({
      id: "selection-refresh",
      title: "刷新数据",
      status: "completed",
      currentStep: 0,
      steps: [],
      log: [],
    });
  });
  await expect
    .poll(async () => (await requests("versions.list")).length)
    .toBe(1);
  await select("Builder_07").click();
  await expect(title).toHaveText("Builder_07");
  await page.evaluate(() => {
    window.__pixelTest.delays["versions.list"] = 0;
  });
  await expect.poll(async () => (await requests("bootstrap")).length).toBe(2);
  await expect(select("Builder_07")).toHaveAttribute("aria-pressed", "true");
  await expect(title).toHaveText("Builder_07");
  check(
    "A background refresh captured before selection cannot restore the previous active player",
  );

  // Starting a game immediately after selecting must use the new persisted ID.
  await page.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "request" && args.operation === "launch") {
        window.__launchPlayer = window.__pixelTest.data.settings.activePlayer;
        return "selection-launch";
      }
      return original(command, args);
    };
    window.__pixelTest.delays["players.select"] = 1000;
  });
  await select("Alex").click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "开始游戏", exact: true })
    .click();
  await page.locator(".launch-primary").click();
  await expect
    .poll(() => page.evaluate(() => window.__launchPlayer))
    .toBe("alex");
  check(
    "Launching immediately after a character click waits for the selection to persist",
  );
  await page.evaluate(() => {
    localStorage.setItem("sfmcl-t.players.view", "grove");
  });
}
