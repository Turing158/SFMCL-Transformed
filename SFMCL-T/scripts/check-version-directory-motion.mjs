import { expect } from "@playwright/test";

export async function verifyVersionDirectoryMotion(
  page,
  ready,
  choose,
  checks,
) {
  const first = "C:/Pixel-Test/Minecraft";
  const second = "D:/Other-Minecraft";
  const root = page.locator("#local-version-results");
  const settled = () =>
    expect(root).not.toHaveAttribute("data-version-directory-transition");

  for (const view of ["grid", "list"]) {
    await ready();
    if ((await page.locator(".version-list").count()) > 0 !== (view === "list"))
      await page
        .getByRole("button", {
          name: view === "list" ? "切换为列表视图" : "切换为卡片视图",
          exact: true,
        })
        .click();
    await expect(root).not.toHaveAttribute("data-version-view-transition");
    await page.evaluate((second) => {
      window.__pixelTest.heldDirectoryReads[second] = [];
      window.__directoryMotion = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (frames, options) {
        const motion = animate.call(this, frames, options);
        if (!options?.id?.startsWith("sfmcl-t-version-directory-"))
          return motion;
        const record = {
          id: options.id,
          blocked: this.inert && this.getAttribute("aria-hidden") === "true",
          cards: [...this.querySelectorAll(".version-card")].map(
            (card) => card.dataset.directory,
          ),
          loading: !!this.querySelector(".versions-loading"),
          empty: !!this.querySelector(".empty"),
          initialOpacity: Number(getComputedStyle(this).opacity),
          opacity: [],
        };
        window.__directoryMotion.push(record);
        if (window.__holdDirectoryExit && options.id.endsWith("-exit")) {
          motion.pause();
          window.__heldDirectoryExit = motion;
        }
        const sample = () => {
          if (!this.isConnected) return;
          record.opacity.push(Number(getComputedStyle(this).opacity));
          if (!["idle", "finished"].includes(motion.playState))
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        return motion;
      };
    }, second);

    await choose("全部");
    await expect(page.locator(".versions-loading-status")).toBeVisible();
    await settled();
    await page.evaluate((second) => {
      const held = window.__pixelTest.heldDirectoryReads[second];
      delete window.__pixelTest.heldDirectoryReads[second];
      held.forEach((resolve) => resolve());
    }, second);
    await expect(page.locator(".versions-skeleton")).toHaveCount(0);
    await expect(page.locator(".version-management .version-card")).toHaveCount(
      3,
    );
    await settled();
    const phases = await page.evaluate(() => window.__directoryMotion);
    expect(phases.map((phase) => phase.id.split("-").at(-1))).toEqual([
      "exit",
      "enter",
      "exit",
      "enter",
    ]);
    expect(phases[0].blocked).toBe(true);
    expect(phases[0].cards).toEqual([first, first]);
    expect(phases[1].loading).toBe(true);
    expect(phases[2].loading).toBe(true);
    expect(phases[3].cards).toEqual([first, first, second]);
    expect(
      phases.every((phase) =>
        phase.opacity.some((value) => value > 0 && value < 1),
      ),
    ).toBe(true);
    checks.push(
      `${view}: directory changes animate old content out and loading/new content in, retaining outgoing nodes while blocking stale actions.`,
    );

    await page.evaluate(() => {
      window.__directoryMotion = [];
      window.__holdDirectoryExit = true;
      window.__directoryNodes = [
        ...document.querySelectorAll("#local-version-results .version-card"),
      ];
    });
    await choose(`像素工坊 · ${first}`);
    await expect(root).toHaveAttribute(
      "data-version-directory-transition",
      "exit",
    );
    const interruptedOpacity = await page.evaluate(() => {
      window.__holdDirectoryExit = false;
      window.__heldDirectoryExit.currentTime = 80;
      return Number(
        getComputedStyle(document.querySelector(".version-directory-content"))
          .opacity,
      );
    });
    await choose("全部");
    await settled();
    const reversed = await page.evaluate(() => ({
      phases: window.__directoryMotion,
      retained: window.__directoryNodes.every((node) => node.isConnected),
    }));
    expect(reversed.phases.map((phase) => phase.id.split("-").at(-1))).toEqual([
      "exit",
      "enter",
    ]);
    expect(reversed.retained).toBe(true);
    expect(reversed.phases[1].initialOpacity).toBeCloseTo(
      interruptedOpacity,
      2,
    );
    await expect(
      page.getByRole("combobox", { name: "游戏目录", exact: true }),
    ).toHaveText("全部");

    await choose("空文件夹 · E:/Empty-Minecraft");
    await expect(
      page.getByRole("heading", { name: "你的世界，即将开始", exact: true }),
    ).toBeVisible();
    await settled();
    await choose(`像素工坊 · ${first}`);
    await expect(page.locator(".version-management .version-card")).toHaveCount(
      2,
    );
    await settled();
    const endings = await page.evaluate(() =>
      window.__directoryMotion.slice(-4),
    );
    expect(endings.map((phase) => phase.id.split("-").at(-1))).toEqual([
      "exit",
      "enter",
      "exit",
      "enter",
    ]);
    expect(endings[1].empty).toBe(true);
    expect(endings[2].empty).toBe(true);
    expect(endings[3].cards).toEqual([first, first]);
    const cleanup = await root.evaluate((element) => ({
      blocked: element.querySelector(".version-directory-content").inert,
      opacity: getComputedStyle(
        element.querySelector(".version-directory-content"),
      ).opacity,
      transform: getComputedStyle(
        element.querySelector(".version-directory-content"),
      ).transform,
      animations: element
        .getAnimations({ subtree: true })
        .filter((animation) =>
          animation.id.startsWith("sfmcl-t-version-directory-"),
        ).length,
    }));
    expect(cleanup).toEqual({
      blocked: false,
      opacity: "1",
      transform: "none",
      animations: 0,
    });
    await page.evaluate(() => {
      window.__holdDirectoryExit = true;
    });
    await choose("全部");
    await expect(root).toHaveAttribute(
      "data-version-directory-transition",
      "exit",
    );
    const nav = (name) =>
      page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name, exact: true })
        .click();
    await nav("开始游戏");
    await settled();
    await page.evaluate(() => {
      window.__holdDirectoryExit = false;
    });
    await nav("版本管理");
    await expect(page.locator(".version-management .version-card")).toHaveCount(
      3,
    );
    await settled();
    expect(
      await root.evaluate(
        (element) => element.querySelector(".version-directory-content").inert,
      ),
    ).toBe(false);
    expect(
      await root.evaluate(
        (element) =>
          element
            .getAnimations({ subtree: true })
            .filter((animation) =>
              animation.id.startsWith("sfmcl-t-version-directory-"),
            ).length,
      ),
    ).toBe(0);
    checks.push(
      `${view}: rapid reversals retain nodes; empty/nonempty directories animate; navigating away cancels motion and returns without stale content or blocked controls.`,
    );
  }
}
