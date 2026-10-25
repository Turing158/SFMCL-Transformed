import { expect } from "@playwright/test";

export async function verifyVersionSelection(page, ready, showAll, checks) {
  const first = "C:/Pixel-Test/Minecraft";
  const second = "D:/Other-Minecraft";
  const card = (id, directory = first) =>
    page
      .locator(`.version-card[data-directory="${directory}"]`)
      .filter({ has: page.getByRole("heading", { name: id, exact: true }) });
  const select = (id, directory = first) =>
    card(id, directory).getByRole("button", {
      name: `选择 ${id}`,
      exact: true,
    });
  const arm = () =>
    page.evaluate(() => {
      const root = document.querySelector("#local-version-results");
      window.__selectionCheck = {
        root,
        grid: root.querySelector(".version-grid"),
        cards: [...root.querySelectorAll(".version-card")],
        images: [...root.querySelectorAll("img")],
        start: window.__pixelTest.requests.length,
      };
    });
  const stable = async (listReads) => {
    expect(
      await page.evaluate(() => {
        const { root, grid, cards, images, start } = window.__selectionCheck;
        const operations = window.__pixelTest.requests
          .slice(start)
          .map((request) => request.operation);
        return {
          retained: [grid, ...cards, ...images].every(
            (node) => node.isConnected,
          ),
          loading: root.getAttribute("aria-busy"),
          reloads: operations.filter((operation) =>
            ["bootstrap", "versions.favorites", "image"].includes(operation),
          ),
          listReads: operations.filter(
            (operation) => operation === "versions.list",
          ).length,
        };
      }),
    ).toEqual({ retained: true, loading: "false", reloads: [], listReads });
  };

  for (const view of ["grid", "list"]) {
    await ready();
    await page.evaluate((view) => {
      document.documentElement.dataset.theme =
        view === "grid" ? "light" : "dark";
      window.__pixelTest.delays["versions.select"] = 150;
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === "request" && args.operation === "image") {
          window.__pixelTest.requests.push(args);
          return "/assets/DefaultGameIcon/Minecraft.png?custom-icon";
        }
        return invoke(command, args);
      };
      window.__pixelTest.directoryVersions.forEach((version) => {
        version.icon = `${version.path}/icon.png`;
      });
    }, view);
    await page.getByRole("button", { name: "刷新版本", exact: true }).click();
    await expect(card("1.21.4").locator("img")).toHaveAttribute(
      "src",
      /custom-icon/,
    );
    if ((await page.locator(".version-list").count()) > 0 !== (view === "list"))
      await page
        .getByRole("button", {
          name: view === "list" ? "切换为列表视图" : "切换为卡片视图",
          exact: true,
        })
        .click();

    // A single-directory selection must not reload shared data or disable the UI.
    await arm();
    await select("1.20.1-Fabric").click();
    await expect(select("1.21.4")).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "收藏 1.21.4", exact: true }),
    ).toBeEnabled();
    await expect(card("1.20.1-Fabric")).toHaveClass(/selected/);
    await stable(0);

    await showAll();
    await arm();
    await select("1.21.4", second).focus();
    await page.keyboard.press("Space");
    await expect(card("1.21.4", second)).toHaveClass(/selected/);
    await expect(card("1.21.4", first)).not.toHaveClass(/selected/);
    await expect(select("1.21.4", second)).toBeFocused();
    await stable(1);

    // Include clicking the still-selected item while another write is pending.
    await arm();
    await page.evaluate(
      ({ first, second }) => {
        for (const directory of [first, second, first])
          document
            .querySelector(
              `.version-card[data-directory="${directory}"] .version-select[aria-label="选择 1.21.4"]`,
            )
            .click();
      },
      { first, second },
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__pixelTest.requests
              .slice(window.__selectionCheck.start)
              .filter((request) => request.operation === "versions.select")
              .length,
        ),
      )
      .toBe(3);
    await expect(card("1.21.4", first)).toHaveClass(/selected/);
    await expect(card("1.21.4", second)).not.toHaveClass(/selected/);
    await stable(3);
    checks.push(
      `${view}: selection preserves cards, images, focus and controls across directories and rapid clicks.`,
    );
  }

  await page.evaluate(() => {
    window.__pixelTest.failures["versions.select"] = "测试版本选择失败";
  });
  await arm();
  await select("1.20.1-Fabric").click();
  await expect(
    page.getByRole("region", { name: "通知", exact: true }),
  ).toContainText("测试版本选择失败");
  await expect(card("1.21.4", first)).toHaveClass(/selected/);
  await stable(0);
  await page.evaluate(() => {
    delete window.__pixelTest.failures["versions.select"];
  });
  await select("1.20.1-Fabric").click();
  await expect(card("1.20.1-Fabric")).toHaveClass(/selected/);
  checks.push(
    "Failed selection preserves the previous version and does not block the next selection.",
  );

  // Let a background refresh capture the old selection before a new click.
  await ready();
  await page.evaluate((first) => {
    window.__pixelTest.heldDirectoryReads[first] = [];
    window.__pixelTest.requests.length = 0;
    window.__pixelTest.tasks.jobs.push({
      id: "version-selection-refresh",
      title: "刷新数据",
      status: "completed",
      currentStep: 0,
      steps: [],
      log: [],
    });
  }, first);
  await expect
    .poll(() =>
      page.evaluate(
        (first) => window.__pixelTest.heldDirectoryReads[first].length,
        first,
      ),
    )
    .toBe(1);
  await select("1.20.1-Fabric").click();
  await expect(card("1.20.1-Fabric")).toHaveClass(/selected/);
  await page.evaluate((first) => {
    const held = window.__pixelTest.heldDirectoryReads[first];
    delete window.__pixelTest.heldDirectoryReads[first];
    held.forEach((resolve) => resolve());
  }, first);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__pixelTest.requests.filter(
            (request) => request.operation === "bootstrap",
          ).length,
      ),
    )
    .toBe(2);
  await expect(card("1.20.1-Fabric")).toHaveClass(/selected/);
  checks.push(
    "A background refresh cannot restore a selection captured before the latest click.",
  );

  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "request" && args.operation === "launch") {
        const { activeDir, activeVersion } = window.__pixelTest.data.settings;
        window.__selectionLaunch = { activeDir, activeVersion };
        return "version-selection-launch";
      }
      return invoke(command, args);
    };
    window.__pixelTest.delays["versions.select"] = 1000;
  });
  await select("1.21.4").click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "开始游戏", exact: true })
    .click();
  await page.locator(".launch-primary").click();
  await expect
    .poll(() => page.evaluate(() => window.__selectionLaunch))
    .toEqual({ activeDir: first, activeVersion: "1.21.4" });
  checks.push(
    "Launching immediately after a version click waits for the saved selection.",
  );
}
