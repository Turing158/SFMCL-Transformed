import { runtimePath } from "./lib/paths.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import { playersFixture } from "./fixtures/players.mjs";

const evidence = runtimePath("players-login-implementation");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(8000);
await page.addInitScript({
  content: `(${pixelAppFixture.toString()})(); (${playersFixture.toString()})();`,
});
await page.addInitScript(() => {
  const writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = async (value) => {
    const fixture = window.__pixelTest;
    fixture.requests.push({ operation: "clipboard.writeText", payload: value });
    if (fixture.clipboardFailure) throw new Error("Clipboard unavailable");
    await writeText(value);
  };
});
const errors = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
const ui = page.locator(".players-page");
const path = page.getByRole("navigation", { name: "页面路径" });
const nav = (name) =>
  name === "角色管理"
    ? page.locator(".sidebar .profile-button").click()
    : page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name, exact: true })
        .click();
const enter = async (kind) => {
  const view = await ui.getAttribute("data-view");
  await ui.locator(`[data-player-login="${kind}"]`).click();
  await expect(ui).toHaveAttribute("data-view", view);
};
const back = () =>
  path.getByRole("button", { name: "返回上一级", exact: true }).click();
const count = (operation) =>
  page.evaluate(
    (op) =>
      window.__pixelTest.requests.filter((r) => r.operation === op).length,
    operation,
  );
const check = (text) => {
  checks.push(text);
  console.log("PASS " + text);
};
const shot = async (name) => {
  await page.waitForTimeout(240);
  await page.screenshot({ path: `${evidence}/${name}.png` });
};
const expectLoginFits = async (context) => {
  // Wait for entry motion to finish before measuring the content boundaries.
  await expect
    .poll(
      async () => {
        return ui.evaluate((el) => {
          const content = el.querySelector(".players-login-content");
          const collection = el.querySelector(".players-collection");
          const bounds = content.getBoundingClientRect();
          const overflow = [
            content.scrollHeight - content.clientHeight,
            content.scrollWidth - content.clientWidth,
            collection.scrollHeight - collection.clientHeight,
          ];
          for (const control of content.querySelectorAll("input, button")) {
            const rect = control.getBoundingClientRect();
            overflow.push(
              rect.bottom - bounds.bottom,
              bounds.top - rect.top,
              rect.right - bounds.right,
              bounds.left - rect.left,
            );
          }
          return Math.max(...overflow);
        });
      },
      { message: context },
    )
    .toBeLessThanOrEqual(1);
  await expect(ui.locator(".players-login-content")).toHaveCSS(
    "overflow-y",
    "visible",
  );
};
try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1420/");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  await nav("角色管理");
  await ui.getByRole("button", { name: "选择角色 Alex", exact: true }).click();
  await ui.locator(".players-view-switch").click();
  await expect(ui).toHaveAttribute("data-view", "gallery");
  await enter("offline");
  await expect(path.locator("button, strong")).toHaveText(["", "离线登录"]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(ui.locator(".players-identity h2")).toHaveText("Steve");
  await expect(ui.locator(".players-model")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  const name = page.getByLabel("角色名称", { exact: true });
  await expect(name).toBeFocused();
  await name.fill("Forest_42");
  await expect(ui.locator(".players-identity h2")).toHaveText("Forest_42");
  expect(
    await page.evaluate(() => window.__pixelTest.data.settings.activePlayer),
  ).toBe("alex");
  await name.fill("");
  await ui.getByRole("button", { name: "创建角色", exact: true }).click();
  await expect(ui.getByRole("alert")).toContainText("请输入角色名称");
  await name.fill("无效名字!");
  await ui.getByRole("button", { name: "创建角色", exact: true }).click();
  await expect(ui.getByRole("alert")).toContainText("英文字母");
  expect(await count("players.add")).toBe(0);
  await name.fill("Valid_Name");
  await page.evaluate(() => {
    window.__pixelTest.failures["players.add"] = "角色已存在";
  });
  await ui.getByRole("button", { name: "创建角色", exact: true }).click();
  await expect(ui.getByRole("alert")).toContainText("角色已存在");
  await page.evaluate(() => {
    delete window.__pixelTest.failures["players.add"];
  });
  await back();
  await expect(ui).toHaveAttribute("data-view", "gallery");
  await expect(ui.locator(".players-identity h2")).toHaveText("Alex");
  await expect(ui.locator('[data-player-login="offline"]')).toBeFocused();
  check(
    "Offline child route, live name, validation, inline API errors and preserved selected player / gallery view",
  );

  await enter("offline");
  await name.fill("Created_Player");
  await ui.getByRole("button", { name: "创建角色", exact: true }).click();
  await expect(ui).not.toHaveAttribute("data-login");
  await expect(ui).toHaveAttribute("data-view", "gallery");
  await expect(path.locator("button, strong")).toHaveText(["角色管理"]);
  await expect(
    ui.getByRole("button", { name: "选择角色 Created_Player", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(ui.locator('[data-player-login="offline"]')).toBeFocused();
  check(
    "Offline creation automatically returns to the saved list view with the new character selected",
  );

  await enter("offline");
  await name.fill("Slow_Player");
  await page.evaluate(() => {
    window.__pixelTest.delays["players.add"] = 700;
  });
  const adds = await count("players.add");
  await ui.getByRole("button", { name: "创建角色", exact: true }).click();
  await expect(
    ui.getByRole("button", { name: "创建角色", exact: true }),
  ).toBeDisabled();
  await nav("开始游戏");
  await page.waitForTimeout(900);
  await expect(ui).toBeHidden();
  await expect(path.locator("strong")).toHaveText("开始游戏");
  await nav("角色管理");
  await expect(ui.locator(".players-identity h2")).toHaveText("Slow_Player");
  expect(await count("players.add")).toBe(adds + 1);
  await expect(ui).not.toHaveAttribute("data-login");
  await expect(ui.locator(".players-login-result")).toHaveCount(0);
  check(
    "Pending offline creation updates the list after navigation without reopening its child page",
  );

  await page.evaluate(() => {
    window.__pixelTest.failures["players.login"] =
      "请在设置中填写 Microsoft 应用 Client ID";
  });
  await enter("microsoft");
  await expect(path.locator("button, strong")).toHaveText([
    "",
    "Microsoft 登录",
  ]);
  await expect(ui.getByRole("alert")).toContainText("Client ID");
  await expect(ui.locator(".players-login-steps .running")).toHaveCount(0);
  expect(await count("players.login")).toBe(1);
  await page.evaluate(() => {
    delete window.__pixelTest.failures["players.login"];
    window.__pixelTest.failures["plugin:opener|open_url"] = "浏览器不可用";
  });
  await ui.getByRole("button", { name: "重新登录", exact: true }).click();
  await expect(ui.locator(".device-code")).toBeVisible();
  await expect(ui.getByRole("alert")).toContainText("无法打开浏览器");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "TEST-CODE",
  );
  expect(
    await page.evaluate(() =>
      window.__pixelTest.requests
        .filter((r) =>
          ["clipboard.writeText", "plugin:opener|open_url"].includes(
            r.operation,
          ),
        )
        .map((r) => r.operation),
    ),
  ).toEqual(["clipboard.writeText", "plugin:opener|open_url"]);
  check("Device code is automatically copied before opening the browser");
  const loginRequests = await count("players.login");
  const browserRequests = await count("plugin:opener|open_url");
  await ui.getByRole("button", { name: "复制授权链接", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "https://www.microsoft.com/link",
  );
  expect(await count("plugin:opener|open_url")).toBe(browserRequests);
  expect(await count("players.login")).toBe(loginRequests);
  await ui
    .getByRole("button", { name: "复制设备代码 TEST-CODE", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "TEST-CODE",
  );
  check(
    "Authorization link and device code copy independently, even when the default browser fails to open",
  );
  await page.evaluate(() => {
    delete window.__pixelTest.failures["plugin:opener|open_url"];
  });
  await ui.getByRole("button", { name: "打开授权页面", exact: true }).click();
  await expect(ui.getByRole("alert")).toHaveCount(0);
  expect(await count("players.login")).toBe(loginRequests);
  expect(await count("plugin:opener|open_url")).toBe(browserRequests + 1);
  expect(
    await page.evaluate(
      () =>
        window.__pixelTest.requests
          .filter((r) => r.operation === "plugin:opener|open_url")
          .at(-1).payload,
    ),
  ).toEqual({ url: "https://www.microsoft.com/link", with: undefined });
  check(
    "Device-code failures can retry; browser-open failures preserve the device code and retry only the browser",
  );

  for (const [step, provider] of [
    [1, "xbox"],
    [2, "minecraft"],
    [3, "sfmcl-t"],
  ]) {
    await page.evaluate((step) => {
      const job = window.__pixelTest.tasks.jobs.at(-1);
      job.currentStep = step;
      job.steps.forEach((s, i) => {
        s.status = i < step ? "completed" : i === step ? "running" : "queued";
      });
    }, step);
    await expect(ui.locator(".players-auth-stage")).toHaveAttribute(
      "data-provider",
      provider,
    );
    await expect(ui.locator(".players-login-steps .completed")).toHaveCount(
      step,
    );
    await shot(`provider-${provider}`);
  }
  const completedCancels = await count("jobs.cancel");
  await page.evaluate(() => {
    const fixture = window.__pixelTest;
    const job = fixture.tasks.jobs.at(-1);
    job.status = "completed";
    job.steps.forEach((step) => {
      step.status = "completed";
    });
    fixture.data.players.push({
      uuid: "ms-completed",
      name: "Online_Player",
      online: true,
      skin: "",
      slim: false,
    });
    fixture.data.settings.activePlayer = "ms-completed";
  });
  await expect(ui).not.toHaveAttribute("data-login");
  await expect(ui).toHaveAttribute("data-view", "gallery");
  await expect(path.locator("button, strong")).toHaveText(["角色管理"]);
  await expect(
    ui.getByRole("button", { name: "选择角色 Online_Player", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(ui.locator('[data-player-login="microsoft"]')).toBeFocused();
  expect(await count("jobs.cancel")).toBe(completedCancels);
  check(
    "Microsoft steps update from the real job; completion returns to the saved list view with the account selected, without cancelling the completed job",
  );

  await enter("microsoft");
  await expect(ui.locator(".device-code")).toBeVisible();
  const refreshes = await count("bootstrap");
  await page.evaluate(() => {
    const fixture = window.__pixelTest;
    fixture.delays.bootstrap = 700;
    fixture.tasks.jobs.at(-1).status = "completed";
  });
  await expect
    .poll(() => count("bootstrap"))
    .toBeGreaterThanOrEqual(refreshes + 2);
  await nav("开始游戏");
  await page.waitForTimeout(900);
  await expect(ui).toBeHidden();
  await expect(path.locator("strong")).toHaveText("开始游戏");
  await page.evaluate(() => {
    window.__pixelTest.delays.bootstrap = 0;
  });
  await nav("角色管理");
  await expect(ui).toHaveAttribute("data-view", "gallery");
  check(
    "A completed Microsoft login with a delayed refresh does not redirect after the user leaves the page",
  );

  await page.evaluate(() => {
    window.__pixelTest.clipboardFailure = true;
  });
  const opensBeforeCopyFailure = await count("plugin:opener|open_url");
  await enter("microsoft");
  await expect(ui.locator(".device-code")).toBeVisible();
  await expect(
    page.getByText("无法自动复制设备代码，请点击代码手动复制", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => count("plugin:opener|open_url"))
    .toBe(opensBeforeCopyFailure + 1);
  await expect(
    ui.getByRole("button", { name: "重新登录", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.__pixelTest.clipboardFailure = false;
  });
  await ui.locator(".device-code").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "TEST-CODE",
  );
  await back();
  check(
    "Automatic-copy failure preserves the login and browser opening, and manual copy can retry",
  );

  await page.evaluate(() => {
    window.__pixelTest.loginExpiresIn = 1;
  });
  // Explicit back cancels asynchronously; settle it before counting expirations.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const fixture = window.__pixelTest;
        return fixture.requests.some(
          (request) =>
            request.operation === "jobs.cancel" &&
            request.payload.id === fixture.tasks.jobs.at(-1).id,
        );
      }),
    )
    .toBe(true);
  const cancels = await count("jobs.cancel");
  await enter("microsoft");
  await expect(ui.getByRole("alert")).toContainText("设备代码已过期");
  await expect(ui.locator(".players-login-steps .running")).toHaveCount(0);
  await expect.poll(() => count("jobs.cancel")).toBe(cancels + 1);
  await page.evaluate(() => {
    window.__pixelTest.loginExpiresIn = 900;
  });
  await ui.getByRole("button", { name: "重新登录", exact: true }).click();
  await expect(ui.locator(".device-code")).toBeVisible();
  await expect(ui.getByRole("alert")).toHaveCount(0);
  await back();
  check(
    "Device-code deadline cancels the owned job and supports a fresh attempt",
  );

  await page.evaluate(() => {
    window.__pixelTest.delays["players.login"] = 650;
  });
  const opens = await count("plugin:opener|open_url");
  const copies = await count("clipboard.writeText");
  const cancellationBefore = await count("jobs.cancel");
  const loginBefore = await count("players.login");
  await enter("microsoft");
  await nav("开始游戏");
  await nav("角色管理");
  await expect(ui.locator(".device-code")).toBeVisible();
  expect(await count("jobs.cancel")).toBe(cancellationBefore);
  expect(await count("players.login")).toBe(loginBefore + 1);
  expect(await count("plugin:opener|open_url")).toBe(opens + 1);
  expect(await count("clipboard.writeText")).toBe(copies + 1);
  const runningJobs = await page.evaluate(
    () =>
      window.__pixelTest.tasks.jobs.filter((j) => j.status === "running")
        .length,
  );
  expect(runningJobs).toBe(1);
  await back();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__pixelTest.tasks.jobs.filter((j) => j.status === "running")
            .length,
      ),
    )
    .toBe(0);
  check(
    "Sidebar navigation retains a pending device-code request; re-entry resumes one live job and browser window, and explicit back cancels it",
  );

  await page.evaluate(() => {
    window.__pixelTest.delays["players.login"] = 0;
  });
  for (const theme of ["light", "dark"]) {
    for (const [width, height] of [
      [1440, 900],
      [1440, 600],
      [1120, 640],
      [850, 600],
      [1024, 768],
      [768, 600],
      [650, 600],
      [375, 600],
      [375, 450],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      for (const view of ["grove", "gallery"]) {
        if ((await ui.getAttribute("data-view")) !== view)
          await ui.locator(".players-view-switch").click();
        await expect(page.locator("html")).not.toHaveAttribute(
          "data-player-view-transition",
        );
        for (const kind of ["offline", "microsoft"]) {
          await enter(kind);
          if (kind === "offline") await name.fill("Layout_Player");
          else await expect(ui.locator(".device-code")).toBeVisible();
          await expect
            .poll(() =>
              ui.evaluate((el) => {
                const host = el.closest(".page");
                return (
                  el.scrollWidth <= el.clientWidth + 1 &&
                  host.scrollHeight <= host.clientHeight + 1
                );
              }),
            )
            .toBe(true);
          await expect(
            path.getByRole("button", { name: "返回上一级", exact: true }),
          ).toBeVisible();
          const fit = await ui.evaluate((el) => ({
            horizontal: el.scrollWidth - el.clientWidth,
            page:
              el.closest(".page").scrollHeight -
              el.closest(".page").clientHeight,
            body: document.documentElement.scrollHeight - innerHeight,
            theme: getComputedStyle(el).getPropertyValue("--accent"),
          }));
          expect(fit.horizontal).toBeLessThanOrEqual(1);
          expect(fit.page).toBeLessThanOrEqual(1);
          expect(fit.body).toBeLessThanOrEqual(1);
          const layout = await ui.evaluate((el) => {
            const style = getComputedStyle(el);
            const width =
              el.clientWidth -
              parseFloat(style.paddingLeft) -
              parseFloat(style.paddingRight);
            const preview = el
              .querySelector(".player-preview")
              .getBoundingClientRect();
            const collection = el
              .querySelector(".players-collection")
              .getBoundingClientRect();
            return {
              stacked:
                collection.top >= preview.bottom - 1 &&
                Math.abs(collection.left - preview.left) < 1,
              beside:
                collection.left >= preview.right - 1 &&
                Math.abs(collection.top - preview.top) < 1,
              narrow: width <= 580,
              previewHeight: preview.height,
              formHeight: el.querySelector(".players-login-content")
                .clientHeight,
            };
          });
          expect(
            view === "gallery" || layout.narrow
              ? layout.stacked
              : layout.beside,
          ).toBe(true);
          expect(layout.previewHeight).toBeGreaterThan(40);
          expect(layout.formHeight).toBeGreaterThan(40);
          await expectLoginFits(`${view}/${kind}/${theme}/${width}x${height}`);
          if (kind === "offline") {
            await expect(ui.locator(".offline-note, .footer-hint")).toHaveCount(
              0,
            );
            await expect(ui.locator(".players-login-camp")).toBeVisible();
            const submit = ui.getByRole("button", {
              name: "创建角色",
              exact: true,
            });
            await expect(submit).toBeInViewport();
            await name.fill("无效名字!");
            await submit.click();
            await expect(ui.getByRole("alert")).toContainText("英文字母");
            await expectLoginFits(`Offline validation at ${width}x${height}`);
            await name.fill("Layout_Player");
          } else {
            const authorize = ui.getByRole("button", {
              name: "打开授权页面",
              exact: true,
            });
            await expect(authorize).toBeInViewport();
            await page.evaluate(() => {
              window.__pixelTest.failures["plugin:opener|open_url"] =
                "浏览器不可用";
            });
            await authorize.click();
            await expect(ui.getByRole("alert")).toContainText("无法打开浏览器");
            await expectLoginFits(`Browser error at ${width}x${height}`);
            await page.evaluate(() => {
              delete window.__pixelTest.failures["plugin:opener|open_url"];
            });
            await authorize.click();
            await expect(ui.getByRole("alert")).toHaveCount(0);
          }
          await shot(`${view}-${kind}-${theme}-${width}-${height}`);
          await back();
          await expect(ui).toHaveAttribute("data-view", view);
        }
      }
    }
  }
  check(
    "Both login pages adapt to the selected layout and available size in both themes; normal and error states fit without scrolling and keep every action visible",
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
