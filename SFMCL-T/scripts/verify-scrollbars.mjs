import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("evidence/scrollbars");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
  // Playwright normally suppresses native scrollbar painting in headless mode.
  ignoreDefaultArgs: ["--hide-scrollbars"],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
page.setDefaultTimeout(8000);
const checks = [],
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(() => {
  const animate = Element.prototype.animate;
  window.__heldScrollbarMotions = new WeakMap();
  Element.prototype.animate = function (...args) {
    const motion = animate.apply(this, args);
    if (args[1]?.id === "sfmcl-t-scrollbar" && window.__holdScrollbarFade) {
      motion.pause();
      window.__heldScrollbarMotions.set(this, motion);
    }
    return motion;
  };
});

const opacity = (element) =>
  element.evaluate((node) =>
    Number(getComputedStyle(node).getPropertyValue("--scrollbar-opacity")),
  );
const visible = (element, value) =>
  expect.poll(() => opacity(element)).toBe(value);
const outside = () => page.mouse.move(4, 4);
const hoverTrack = async (element, horizontal = false) => {
  const box = await element.boundingBox();
  await page.mouse.move(
    horizontal ? box.x + box.width / 2 : box.x + box.width - 3,
    horizontal ? box.y + box.height - 3 : box.y + box.height / 2,
  );
};
async function fade(element, show, label = "page") {
  await page.evaluate(() => {
    window.__holdScrollbarFade = true;
  });
  if (show) await element.hover({ position: { x: 25, y: 25 } });
  else await outside();
  await expect
    .poll(() =>
      element.evaluate((node) =>
        node
          .getAnimations()
          .some((motion) => motion.id === "sfmcl-t-scrollbar"),
      ),
    )
    .toBe(true);
  expect(
    await element.evaluate(
      (node) =>
        window.__heldScrollbarMotions.get(node).effect.getTiming().duration,
    ),
  ).toBe(220);
  const values = [],
    images = [];
  const box = await element.boundingBox();
  for (const time of [0, 110, 220]) {
    await element.evaluate((node, time) => {
      window.__heldScrollbarMotions.get(node).currentTime = time;
    }, time);
    values.push(await opacity(element));
    images.push(
      await page.screenshot({
        path: `${evidence}/${label}-${show ? "in" : "out"}-${time}.png`,
        clip: {
          x: box.x + box.width - 7,
          y: box.y,
          width: 7,
          height: box.height,
        },
      }),
    );
  }
  expect(values[0]).toBe(show ? 0 : 1);
  expect(values[1]).toBeGreaterThan(0);
  expect(values[1]).toBeLessThan(1);
  expect(values[2]).toBe(show ? 1 : 0);
  // Confirm the actual native track is repainted, beyond the animated value.
  expect(images[0].equals(images[1])).toBe(false);
  expect(images[1].equals(images[2])).toBe(false);
  await page.evaluate(() => {
    window.__holdScrollbarFade = false;
  });
  await element.evaluate((node) =>
    window.__heldScrollbarMotions.get(node).finish(),
  );
  await visible(element, show ? 1 : 0);
}

try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  const scrollport = page.locator(".page:visible");
  await expect(scrollport).toBeVisible();
  await expect
    .poll(() =>
      scrollport.evaluate((node) => node.scrollHeight > node.clientHeight),
    )
    .toBe(true);
  await outside();
  await visible(scrollport, 0);
  const width = await scrollport.evaluate((node) => node.clientWidth);
  await fade(scrollport, true);
  await hoverTrack(scrollport);
  await page.waitForTimeout(1100);
  await visible(scrollport, 1);
  await fade(scrollport, false);
  expect(await scrollport.evaluate((node) => node.clientWidth)).toBe(width);
  checks.push(
    "Page scrollbar paints intermediate fade frames, stays visible on track hover and reserves the same content width.",
  );

  await scrollport.evaluate((node) => {
    node.scrollTop = 180;
  });
  await visible(scrollport, 1);
  await visible(scrollport, 0);
  await scrollport.hover({ position: { x: 25, y: 25 } });
  await page.mouse.wheel(0, 80);
  await page.waitForTimeout(1200);
  await visible(scrollport, 1);
  await outside();
  await visible(scrollport, 0);
  checks.push(
    "Scrolling reveals the bar for 900ms; hover keeps it visible after scrolling stops.",
  );

  await scrollport.evaluate((node) => {
    node.scrollTop = 0;
  });
  await visible(scrollport, 0);
  const box = await scrollport.boundingBox();
  const initialTop = await scrollport.evaluate((node) => node.scrollTop);
  await page.mouse.move(box.x + box.width - 3, box.y + 30);
  await visible(scrollport, 1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 3, box.y + 100, { steps: 5 });
  await expect
    .poll(() => scrollport.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(initialTop);
  await outside();
  await page.waitForTimeout(1200);
  await visible(scrollport, 1);
  await page.mouse.up();
  await visible(scrollport, 0);
  checks.push(
    "Native thumb dragging works and keeps the bar visible outside its scrollport until release.",
  );

  await page.evaluate(() => {
    const harness = document.createElement("section");
    harness.id = "scrollbar-test";
    harness.style.cssText =
      "position:fixed;z-index:500;left:260px;top:100px;width:560px;padding:16px;background:var(--panel);display:grid;grid-template-columns:250px 250px;gap:18px";
    harness.innerHTML = `
      <div id="vertical-card" class="panel" style="width:250px;height:170px;overflow:auto;padding:0"><div style="height:600px;background:var(--soft)">卡片内容</div></div>
      <div id="horizontal-card" class="panel" style="width:250px;height:170px;overflow:auto;padding:0"><div style="width:750px;height:150px;background:var(--soft)">横向内容</div></div>
      <div id="outer-card" class="panel" style="width:250px;height:170px;overflow:auto;padding:0"><div style="height:600px;padding:20px;background:var(--soft)"><div id="inner-card" style="width:150px;height:80px;overflow:auto;background:var(--panel)"><div style="height:300px">嵌套卡片</div></div></div></div>
      <div id="dynamic-card" class="panel" style="width:250px;height:170px;overflow:auto;padding:0"><div style="height:60px;background:var(--soft)">动态内容</div></div>
      <textarea id="native-input" style="width:250px;height:100px">${"输入内容\n".repeat(40)}</textarea>
      <div id="native-select" class="pixel-select-list" style="width:250px;height:100px"><div style="height:400px">选择列表</div></div>`;
    document.body.append(harness);
  });
  const vertical = page.locator("#vertical-card");
  const horizontal = page.locator("#horizontal-card");
  const outer = page.locator("#outer-card");
  const inner = page.locator("#inner-card");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await outside();
    await visible(vertical, 0);
    await visible(horizontal, 0);
    await vertical.hover({ position: { x: 20, y: 20 } });
    await visible(vertical, 1);
    await visible(horizontal, 0);
    await hoverTrack(vertical);
    await visible(vertical, 1);
    await page.screenshot({ path: `${evidence}/cards-${theme}-vertical.png` });
    await horizontal.hover({ position: { x: 20, y: 20 } });
    await visible(horizontal, 1);
    await visible(vertical, 0);
    await hoverTrack(horizontal, true);
    await page.mouse.wheel(150, 0);
    await expect
      .poll(() => horizontal.evaluate((node) => node.scrollLeft))
      .toBeGreaterThan(0);
    await page.screenshot({
      path: `${evidence}/cards-${theme}-horizontal.png`,
    });
    await outside();
    await visible(horizontal, 0);
  }
  checks.push(
    "Vertical and horizontal cards reveal independently, including the entire track, in both themes.",
  );

  await outer.hover({ position: { x: 210, y: 130 } });
  await visible(outer, 1);
  await visible(inner, 0);
  await inner.hover({ position: { x: 20, y: 20 } });
  await visible(outer, 1);
  await visible(inner, 1);
  await outside();
  await visible(outer, 0);
  await visible(inner, 0);
  await inner.evaluate((node) => {
    node.scrollTop = 40;
  });
  await visible(inner, 1);
  await visible(outer, 0);
  await visible(inner, 0);
  checks.push(
    "Nested scrollports do not inherit each other's visibility; scrolling the inner card leaves the outer bar hidden.",
  );

  const dynamic = page.locator("#dynamic-card");
  await dynamic.hover({ position: { x: 20, y: 20 } });
  await visible(dynamic, 0);
  await dynamic.evaluate((node) => {
    node.firstElementChild.style.height = "600px";
  });
  await visible(dynamic, 1);
  await dynamic.evaluate((node) => {
    node.firstElementChild.style.height = "60px";
  });
  await visible(dynamic, 0);
  checks.push(
    "Overflow appearing or disappearing under a stationary pointer updates visibility automatically.",
  );

  for (const selector of ["#native-input", "#native-select"]) {
    const field = page.locator(selector);
    const before = await field.evaluate((node) => ({
      color: getComputedStyle(node).scrollbarColor,
      width: getComputedStyle(node).scrollbarWidth,
      thumb: getComputedStyle(node, "::-webkit-scrollbar-thumb")
        .backgroundColor,
    }));
    await field.hover({ position: { x: 20, y: 20 } });
    await field.evaluate((node) => {
      node.scrollTop = 40;
    });
    await page.waitForTimeout(250);
    expect(
      await field.evaluate((node) =>
        node.style.getPropertyValue("--scrollbar-opacity"),
      ),
    ).toBe("");
    expect(
      await field.evaluate((node) => ({
        color: getComputedStyle(node).scrollbarColor,
        width: getComputedStyle(node).scrollbarWidth,
        thumb: getComputedStyle(node, "::-webkit-scrollbar-thumb")
          .backgroundColor,
      })),
    ).toEqual(before);
  }
  checks.push(
    "Input fields and select lists retain their existing native scrollbar styles and behavior.",
  );

  await outside();
  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    dialog.id = "scrollbar-dialog";
    dialog.innerHTML =
      '<div class="modal-body" style="height:180px;width:350px"><div style="height:600px;background:var(--soft)">弹窗内容</div></div>';
    document.body.append(dialog);
    dialog.showModal();
  });
  const modal = page.locator("#scrollbar-dialog .modal-body");
  await visible(modal, 0);
  await modal.hover({ position: { x: 20, y: 20 } });
  await visible(modal, 1);
  await hoverTrack(modal);
  await visible(modal, 1);
  await page.locator("#scrollbar-dialog").evaluate((node) => node.remove());
  await outside();
  checks.push(
    "New top-layer dialogs receive the same behavior and can be removed safely while a scrollbar is active.",
  );

  await visible(vertical, 0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fade(vertical, true, "reduced-motion");
  await fade(vertical, false, "reduced-motion");
  checks.push(
    "System reduced-motion preference preserves the complete 220ms scrollbar fade-in and fade-out with intermediate painted frames.",
  );

  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/checks.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(
    `PASS ${checks.length} scrollbar behavior groups; no page errors.`,
  );
} finally {
  await browser.close();
}
