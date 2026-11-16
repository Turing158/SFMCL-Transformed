import { chromium, expect } from "@playwright/test";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";

const url = process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/";
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(pixelAppFixture);
  await page.addInitScript(() => {
    const test = window.__pixelTest;
    test.data.players[0].skin = "C:/Pixel-Test/skin.png";
    test.data.backgroundPath = "C:/Pixel-Test/background.png";
    test.imageReads = {};
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "request" && args.operation === "image") {
        const path = args.payload.path;
        test.imageReads[path] = (test.imageReads[path] ?? 0) + 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
      }
      if (command === "request" && args.operation === "players.skin")
        return structuredClone(test.data.players[0]);
      return invoke(command, args);
    };
  });
  await page.goto(new URL("scripts/fixtures/state-isolation.html", url).href);
  await expect(page.locator("span[data-ready]")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await expect(page.locator("img[data-ready=true]")).toHaveCount(3);
  const reads = () => page.evaluate(() => window.__pixelTest.imageReads);
  expect(await reads()).toEqual({
    "C:/Pixel-Test/skin.png": 1,
    "C:/Pixel-Test/background.png": 1,
  });
  await page.evaluate(() => {
    window.__pixelTest.tasks.downloads = [
      {
        id: "download",
        title: "file",
        status: "running",
        downloaded: 1,
        total: 100,
        unknownSize: false,
        completed: 0,
        failed: 0,
        fileCount: 1,
        speed: 1,
        workers: 1,
        steps: [],
      },
    ];
  });
  await expect(page.locator("[data-bytes]")).toHaveAttribute("data-bytes", "1");
  const before = await page.evaluate(() => ({
    ...window.__stateIsolation.renders,
  }));
  await page.evaluate(() => {
    window.__pixelTest.tasks.downloads[0].downloaded = 2;
  });
  await expect(page.locator("[data-bytes]")).toHaveAttribute("data-bytes", "2");
  const after = await page.evaluate(() => ({
    ...window.__stateIsolation.renders,
  }));
  expect(after.tasks).toBeGreaterThan(before.tasks);
  for (const key of ["data", "retained", "status", "notifications"])
    expect(after[key]).toBe(before[key]);
  // Observe another completed poll rather than relying on a fixed delay.
  const polls = await page.evaluate(
    () =>
      window.__pixelTest.requests.filter((item) => item.operation === "tasks")
        .length,
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__pixelTest.requests.filter(
            (item) => item.operation === "tasks",
          ).length,
      ),
    )
    .toBeGreaterThan(polls);
  expect(await page.evaluate(() => window.__stateIsolation.renders.tasks)).toBe(
    after.tasks,
  );
  await page.evaluate(() => window.__stateIsolation.app.notify("saved"));
  await expect
    .poll(() =>
      page.evaluate(() => window.__stateIsolation.renders.notifications),
    )
    .toBeGreaterThan(after.notifications);
  expect(await page.evaluate(() => window.__stateIsolation.renders.data)).toBe(
    after.data,
  );
  expect(
    await page.evaluate(() => window.__stateIsolation.renders.retained),
  ).toBe(after.retained);
  await page.evaluate(() => window.__stateIsolation.app.refresh());
  await page.evaluate(() => {
    const app = window.__stateIsolation.app;
    return app.autoSaveSettings(app.data.settings, {
      ...app.data.settings,
      memoryMb: 8192,
    });
  });
  expect(await reads()).toEqual({
    "C:/Pixel-Test/skin.png": 1,
    "C:/Pixel-Test/background.png": 1,
  });
  await page.evaluate(() =>
    window.__stateIsolation.app.update("players.skin", { id: "pixel-player" }),
  );
  await expect.poll(reads).toEqual({
    "C:/Pixel-Test/skin.png": 2,
    "C:/Pixel-Test/background.png": 1,
  });
  await page.evaluate(() => window.__stateIsolation.app.refresh("backgrounds"));
  await expect.poll(reads).toEqual({
    "C:/Pixel-Test/skin.png": 2,
    "C:/Pixel-Test/background.png": 2,
  });
  expect(errors).toEqual([]);
  console.log(
    "Verified task and notification render isolation, unchanged polls, shared image reads, scoped invalidation and settings refresh.",
  );
} finally {
  await browser.close();
}
