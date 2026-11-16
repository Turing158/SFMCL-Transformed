// UI fixtures verify interaction only. Real engine coverage lives in Rust tests.
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { runtimePath } from "./lib/paths.mjs";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
const evidence =
  process.env.SFMCL_T_MULTIPLAYER_EVIDENCE ||
  runtimePath("evidence", "multiplayer");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(pixelAppFixture);
await page.addInitScript(() => {
  const idle = {
    state: "idle",
    sessionId: null,
    componentReady: false,
    componentVersion: "2.6.4",
    tunnelReady: false,
    tunnelVersion: "2026.10.7",
    componentJobId: null,
    role: null,
    name: "",
    gameVersion: "",
    address: null,
    worldOpen: false,
    members: [],
    error: null,
    service: null,
    inviteCode: null,
  };
  const state = (window.__multiplayerTest = {
    snapshot: { ...idle, componentReady: true },
    calls: [],
    copied: "",
    failStatus: true,
    portOutcome: "reachable",
    portPending: false,
    failOperation: "",
    prepareRoom: false,
    pendingRoom: null,
    pendingTunnel: false,
    preparationCount: 0,
  });
  const beginPreparation = (room = null, archive = false, tunnel = false) => {
    state.pendingRoom = room;
    state.pendingTunnel = tunnel;
    const previous = state.snapshot;
    const downloadingTunnel = tunnel && (previous.componentReady || archive);
    const count = ++state.preparationCount;
    const jobId = `component-job-${count}`;
    const downloadId =
      archive && !tunnel ? null : `component-download-${count}`;
    window.__pixelTest.tasks.jobs.unshift({
      id: jobId,
      title: `准备联机组件 · EasyTier 2.6.4${tunnel ? " / Cloudflare Tunnel" : ""}`,
      status: "running",
      currentStep: 1,
      downloadId,
      steps: [
        { name: "检查组件", status: "completed", detail: "" },
        { name: "获取组件", status: "running", detail: "" },
        { name: "校验并安装", status: "queued", detail: "" },
        ...(tunnel
          ? [
              { name: "检查 Cloudflare Tunnel", status: "queued", detail: "" },
              { name: "获取 Cloudflare Tunnel", status: "queued", detail: "" },
              {
                name: "校验并安装 Cloudflare Tunnel",
                status: "queued",
                detail: "",
              },
            ]
          : []),
      ],
      log: [],
    });
    if (downloadId) {
      window.__pixelTest.tasks.downloads.unshift({
        id: downloadId,
        title: downloadingTunnel
          ? "Cloudflare Tunnel 2026.10.7 · 联机入口"
          : "EasyTier 2.6.4 · 联机组件",
        status: "running",
        downloaded: 14695974,
        total: downloadingTunnel ? 55390512 : 32657720,
        unknownSize: false,
        completed: 0,
        failed: 0,
        fileCount: 1,
        speed: 1048576,
        workers: 1,
        steps: [],
      });
    }
    state.snapshot = {
      ...idle,
      componentReady: previous.componentReady,
      tunnelReady: previous.tunnelReady,
      state: "preparing",
      sessionId: `prepare-${count}`,
      componentJobId: jobId,
      role: room
        ? room.operation.endsWith("create")
          ? "host"
          : "guest"
        : null,
      name: room ? "周末的生存世界" : "",
      gameVersion: room ? "1.21.4" : "",
      service: room
        ? room.operation.includes(".official.")
          ? "official"
          : "custom"
        : null,
    };
  };
  state.finishPreparation = (status = "completed") => {
    const job = window.__pixelTest.tasks.jobs.find(
      (job) => job.id === state.snapshot.componentJobId,
    );
    const download = window.__pixelTest.tasks.downloads.find(
      (download) => download.id === job?.downloadId,
    );
    if (job) {
      job.status = status;
      job.downloadId = null;
      job.steps.forEach((step) => {
        step.status = status;
      });
    }
    if (download) {
      download.status = status;
      download.speed = 0;
      if (status === "completed") {
        download.downloaded = download.total;
        download.completed = 1;
      }
    }
    const room = state.pendingRoom;
    state.pendingRoom = null;
    if (status === "completed" && room) {
      readyRoom(room);
    } else {
      state.snapshot = {
        ...idle,
        componentReady: state.snapshot.componentReady || status === "completed",
        tunnelReady:
          state.snapshot.tunnelReady ||
          (state.pendingTunnel && status === "completed"),
      };
    }
    state.pendingTunnel = false;
  };
  const readyRoom = (args) => {
    state.server = args.payload.server || "";
    const hostContext = args.operation.endsWith("create")
      ? window.__pixelTest.tasks.jobs.find(
          (job) => job.id === args.payload.launchId,
        )?.launch
      : undefined;
    state.snapshot = {
      ...idle,
      state: "ready",
      sessionId: "room-session",
      componentReady: true,
      tunnelReady: state.snapshot.tunnelReady,
      role: args.operation.endsWith("create") ? "host" : "guest",
      name: "周末的生存世界",
      gameVersion: hostContext?.gameVersion || "1.21.4",
      address: "127.0.0.1:51234",
      worldOpen: true,
      service: args.operation.includes(".official.") ? "official" : "custom",
      inviteCode: args.operation.includes(".official.") ? "A1B2C3D4" : null,
      members: [
        {
          id: "1",
          name: hostContext?.playerName || "Alex",
          ip: "10.45.76.1",
          connection: "local",
          latency: null,
          local: true,
        },
        {
          id: "2",
          name: "Steve",
          ip: "10.45.76.2",
          connection: "relay",
          latency: 42,
          local: false,
        },
      ],
    };
  };
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async (value) => {
        state.copied = value;
      },
    },
  });
  const original = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command !== "request") return original(command, args);
    if (args.operation === "launch") {
      state.calls.push(args);
      return "launch-fixture";
    }
    if (
      args.operation === "jobs.cancel" &&
      args.payload.id === state.snapshot.componentJobId
    ) {
      state.calls.push(args);
      state.finishPreparation("cancelled");
      return;
    }
    if (args.operation === "downloads.control") {
      const job = window.__pixelTest.tasks.jobs.find(
        (job) => job.id === state.snapshot.componentJobId,
      );
      const result = await original(command, args);
      if (job?.downloadId === args.payload.id) {
        if (args.payload.action === "cancel")
          state.finishPreparation("cancelled");
        else
          job.status = args.payload.action === "pause" ? "paused" : "running";
      }
      return result;
    }
    if (!args.operation.startsWith("multiplayer."))
      return original(command, args);
    state.calls.push(args);
    if (args.operation === state.failOperation) throw Error("联机操作失败");
    switch (args.operation) {
      case "multiplayer.status":
        if (state.failStatus) throw Error("unavailable");
        return structuredClone(state.snapshot);
      case "multiplayer.prepare":
        beginPreparation(null, !!args.payload?.archive, !!args.payload?.tunnel);
        break;
      case "multiplayer.leave":
        state.snapshot = {
          ...idle,
          componentReady: true,
          tunnelReady: state.snapshot.tunnelReady,
        };
        break;
      case "multiplayer.check-local-port":
        if (state.portPending)
          await new Promise((resolve) => {
            state.finishPortCheck = resolve;
          });
        if (state.portOutcome === "failure") throw Error("unavailable");
        return { reachable: state.portOutcome === "reachable" };
      case "multiplayer.preview":
        if (!args.payload.invitation.startsWith("SFMCL2."))
          throw Error("邀请码无效");
        return {
          name: "周末的生存世界",
          gameVersion: "1.21.4",
          server: "wss://quiet-blue-bird.trycloudflare.com",
        };
      case "multiplayer.official.preview":
        if (state.previewPending)
          await new Promise((resolve) => {
            state.finishPreview = resolve;
          });
        return {
          name: "官方生存房间",
          gameVersion: "1.21.4",
          server: "wss://relay.example.com",
        };
      case "multiplayer.create":
      case "multiplayer.join":
      case "multiplayer.official.create":
      case "multiplayer.official.join": {
        if (state.prepareRoom) beginPreparation(args);
        else readyRoom(args);
        break;
      }
      case "multiplayer.invitation":
        if (state.snapshot.service === "official") return "A1B2C3D4";
        return state.server
          ? "SFMCL1.fixture-private-invitation"
          : "SFMCL2.fixture-private-invitation";
      default:
        throw Error("Unexpected operation");
    }
    return structuredClone(state.snapshot);
  };
});
const main = page.locator('main[data-page="multiplayer"]');
const componentNotice = main.getByRole("region", {
  name: "联机状态",
  exact: true,
});
const nav = page.getByRole("navigation", { name: "主导航" });
const notification = (message, kind = "error") =>
  page
    .locator(`.notification-deck .toast.${kind}`)
    .filter({ hasText: message });
const statusCalls = () =>
  page.evaluate(
    () =>
      window.__multiplayerTest.calls.filter(
        (call) => call.operation === "multiplayer.status",
      ).length,
  );
const go = (name) => nav.getByRole("button", { name, exact: true }).click();
function pass(name) {
  checks.push(name);
  console.log(`PASS ${name}`);
}
try {
  await page.goto(process.env.SFMCL_T_UI_URL || "http://127.0.0.1:1421/");
  await expect(nav.getByRole("button")).toHaveCount(5);
  expect(
    (await nav.getByRole("button").allTextContents()).map((s) => s.trim()),
  ).toEqual(["开始游戏", "版本管理", "联机", "资源中心", "设置"]);
  await go("联机");
  await expect(main.getByRole("region", { name: "当前游戏" })).toHaveCount(0);
  const statusFailure = notification("无法读取联机状态，请重试");
  await expect(statusFailure).toBeVisible();
  await expect(main.getByRole("alert")).toHaveCount(0);
  await statusFailure.hover();
  const beforeStatusPolls = await statusCalls();
  await expect
    .poll(statusCalls, { timeout: 6500 })
    .toBeGreaterThanOrEqual(beforeStatusPolls + 2);
  await expect(statusFailure).toHaveCount(1);
  await page.evaluate(() => {
    window.__multiplayerTest.failStatus = false;
  });
  await main.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(componentNotice).toHaveCount(0);
  await main.getByRole("tab", { name: "自定义", exact: true }).click();
  await statusFailure.click();
  await expect(
    main.getByRole("button", { name: "校验组件", exact: true }),
  ).toHaveCount(0);
  await expect(
    main.getByRole("button", { name: "准备组件", exact: true }),
  ).toHaveCount(0);
  await expect(
    main.getByRole("button", { name: "导入组件", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => window.__multiplayerTest.preparationCount),
  ).toBe(0);
  await main.screenshot({ path: `${evidence}/components-ready.png` });
  await go("版本管理");
  await go("联机");
  await expect(componentNotice).toHaveCount(0);
  await page.evaluate(() => {
    window.__multiplayerTest.snapshot.componentReady = false;
  });
  await expect(main.getByText("需要准备组件", { exact: true })).toBeVisible();
  await expect(
    main.getByRole("button", { name: "准备组件", exact: true }),
  ).toBeEnabled();
  await expect(
    main.getByRole("button", { name: "导入组件", exact: true }),
  ).toBeEnabled();
  await main.screenshot({ path: `${evidence}/components-required.png` });
  pass(
    "启动自动读取已校验组件状态、就绪后隐藏状态卡片、切页保持隐藏、缺失时显示准备和导入入口",
  );
  await main.getByLabel("房间名称", { exact: true }).fill("周末的生存世界");
  await main.getByRole("button", { name: "准备组件", exact: true }).click();
  await expect(main.getByRole("progressbar")).toHaveCount(0);
  await expect(main.getByRole("region", { name: "当前房间" })).toHaveCount(0);
  await expect(main.getByLabel("房间名称", { exact: true })).toHaveValue(
    "周末的生存世界",
  );
  await expect(main.getByLabel("房间名称", { exact: true })).toBeDisabled();
  await main.screenshot({ path: `${evidence}/preparing-form.png` });
  await main.getByRole("button", { name: "查看下载", exact: true }).click();
  const downloads = page.locator('main[data-page="downloads"]');
  const jobTitle = "准备联机组件 · EasyTier 2.6.4";
  const downloadTitle = "EasyTier 2.6.4 · 联机组件";
  await expect(
    downloads.getByRole("button", { name: jobTitle, exact: true }),
  ).toBeVisible();
  await downloads
    .getByRole("button", { name: `暂停 ${downloadTitle}`, exact: true })
    .click();
  await expect(
    downloads.getByRole("button", {
      name: `继续 ${downloadTitle}`,
      exact: true,
    }),
  ).toBeVisible();
  await downloads
    .getByRole("button", { name: `继续 ${downloadTitle}`, exact: true })
    .click();
  await expect(
    downloads.getByRole("button", {
      name: `暂停 ${downloadTitle}`,
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.__pixelTest.tasks.downloads[0].status = "failed";
    window.__pixelTest.tasks.jobs[0].status = "failed";
  });
  await expect(
    downloads.getByText("文件下载失败。重试下方下载任务后，操作将自动继续。"),
  ).toBeVisible();
  await downloads
    .getByRole("button", { name: `继续 ${downloadTitle}`, exact: true })
    .click();
  await expect(
    downloads.getByRole("button", {
      name: `暂停 ${downloadTitle}`,
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(() => window.__multiplayerTest.finishPreparation());
  await go("联机");
  await expect(componentNotice).toHaveCount(0);
  await expect(
    main.getByRole("button", { name: "准备组件", exact: true }),
  ).toHaveCount(0);
  await expect(main.getByLabel("房间名称", { exact: true })).toBeEnabled();
  await page.evaluate(() => {
    window.__multiplayerTest.snapshot.componentReady = false;
  });
  await main.getByRole("button", { name: "准备组件", exact: true }).click();
  await main.getByRole("button", { name: "查看下载", exact: true }).click();
  await downloads
    .getByRole("button", { name: `取消 ${jobTitle}`, exact: true })
    .click();
  await go("联机");
  await expect(
    main.getByRole("button", { name: "准备组件", exact: true }),
  ).toBeVisible();
  await main.getByRole("button", { name: "准备组件", exact: true }).click();
  await main.getByRole("button", { name: "查看下载", exact: true }).click();
  await downloads
    .getByRole("button", { name: `取消 ${downloadTitle}`, exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await go("联机");
  await expect(
    main.getByRole("button", { name: "准备组件", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.__pixelTest.pickedDirectory =
      "C:/Fixtures/easytier-windows-x86_64-v2.6.4.zip";
  });
  await main.getByRole("button", { name: "导入组件", exact: true }).click();
  await main.getByRole("button", { name: "查看下载", exact: true }).click();
  await expect(
    downloads.getByRole("button", { name: jobTitle, exact: true }),
  ).toHaveCount(4);
  expect(
    await page.evaluate(() => window.__pixelTest.tasks.downloads.length),
  ).toBe(3);
  expect(
    await page.evaluate(
      () =>
        window.__multiplayerTest.calls
          .filter((call) => call.operation === "multiplayer.prepare")
          .at(-1).payload.archive,
    ),
  ).toBe("C:/Fixtures/easytier-windows-x86_64-v2.6.4.zip");
  await downloads.screenshot({ path: `${evidence}/component-downloads.png` });
  await page.evaluate(() => window.__multiplayerTest.finishPreparation());
  await go("联机");
  await expect(main.getByLabel("房间名称", { exact: true })).toHaveValue(
    "周末的生存世界",
  );
  pass(
    "组件准备保留表单、下载中心暂停继续和失败重试、两种取消入口、导入任务与状态恢复",
  );
  await main.getByLabel("游戏端口", { exact: true }).fill("0");
  await main.getByRole("button", { name: "检查端口" }).click();
  const invalidPort = notification("请输入 1–65535 之间的整数端口");
  await expect(invalidPort).toBeVisible();
  await expect(main.getByText("请输入 1–65535 之间的整数端口")).toHaveCount(0);
  await page.screenshot({
    path: `${evidence}/port-validation-notification.png`,
  });
  await invalidPort.click();
  await expect(invalidPort).toHaveCount(0);
  await main.getByLabel("游戏端口", { exact: true }).fill("65536");
  const beforeInvalidPort = await page.evaluate(
    () => window.__multiplayerTest.calls.length,
  );
  await main.getByRole("button", { name: "创建房间", exact: true }).click();
  await expect(invalidPort).toBeVisible();
  expect(
    await page.evaluate(
      (beforeInvalidPort) =>
        window.__multiplayerTest.calls
          .slice(beforeInvalidPort)
          .some((call) => call.operation === "multiplayer.create"),
      beforeInvalidPort,
    ),
  ).toBe(false);
  await invalidPort.click();
  await main.getByLabel("游戏端口", { exact: true }).fill("51234");
  for (const [outcome, message] of [
    ["closed", "端口未开放"],
    ["failure", "检查失败，请重试"],
  ]) {
    await page.evaluate((outcome) => {
      window.__multiplayerTest.portOutcome = outcome;
    }, outcome);
    await main.getByRole("button", { name: "检查端口" }).click();
    await expect(notification(message)).toBeVisible();
    await notification(message).click();
  }
  await page.evaluate(() => {
    window.__multiplayerTest.portOutcome = "reachable";
    window.__multiplayerTest.portPending = true;
  });
  await main.getByRole("button", { name: "检查端口" }).click();
  await expect(main.getByRole("button", { name: "检查中…" })).toBeDisabled();
  await go("版本管理");
  await page.evaluate(() => {
    window.__multiplayerTest.finishPortCheck();
    window.__multiplayerTest.portPending = false;
  });
  await go("联机");
  await expect(main.getByRole("button", { name: "检查端口" })).toBeEnabled();
  await expect(notification("端口可连接", "success")).toHaveCount(0);
  await main.getByRole("button", { name: "检查端口" }).click();
  await expect(notification("端口可连接", "success")).toBeVisible();
  await expect(main.getByText("端口可连接", { exact: true })).toHaveCount(0);
  await notification("端口可连接", "success").click();
  pass(
    "端口校验、开放/未开放/失败均使用气泡提示，切页忽略过期结果，状态轮询错误不重复弹出",
  );
  const connectionMode = main.getByRole("combobox", {
    name: "联机方式",
    exact: true,
  });
  const sharedNode = main.getByLabel("共享节点", { exact: true });
  await expect(connectionMode).toContainText("共享EasyTier节点");
  await expect(sharedNode).toHaveValue("");
  expect(await sharedNode.evaluate((input) => input.required)).toBe(true);
  await connectionMode.click();
  await page
    .getByRole("option", {
      name: "Cloudflare Tunnel + 本机EasyTier",
      exact: true,
    })
    .click();
  await expect(connectionMode).toContainText(
    "Cloudflare Tunnel + 本机EasyTier",
  );
  await expect(sharedNode).toHaveCount(0);
  await expect(main.locator("input")).toHaveCount(2);
  const componentList = main.getByLabel("联机组件", { exact: true });
  await expect(
    componentList.getByRole("img", {
      name: "EasyTier 2.6.4 · 已就绪",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    componentList.getByRole("img", {
      name: "Cloudflare Tunnel 2026.10.7 · 待准备",
      exact: true,
    }),
  ).toBeVisible();
  await expect(main.getByText("需要准备组件", { exact: true })).toBeVisible();
  await main.getByRole("button", { name: "准备组件", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        window.__multiplayerTest.calls
          .filter((call) => call.operation === "multiplayer.prepare")
          .at(-1).payload.tunnel,
    ),
  ).toBe(true);
  await expect(main.getByRole("region", { name: "当前房间" })).toHaveCount(0);
  await main.getByRole("button", { name: "查看下载", exact: true }).click();
  const tunnelJobTitle = "准备联机组件 · EasyTier 2.6.4 / Cloudflare Tunnel";
  const tunnelDownloadTitle = "Cloudflare Tunnel 2026.10.7 · 联机入口";
  await expect(
    downloads.getByRole("button", {
      name: `暂停 ${tunnelDownloadTitle}`,
      exact: true,
    }),
  ).toBeVisible();
  await downloads
    .getByRole("button", { name: `取消 ${tunnelJobTitle}`, exact: true })
    .click();
  await go("联机");
  await expect(main.getByText("需要准备组件", { exact: true })).toBeVisible();
  await expect(
    componentList.getByRole("img", {
      name: "EasyTier 2.6.4 · 已就绪",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    componentList.getByRole("img", {
      name: "Cloudflare Tunnel 2026.10.7 · 待准备",
      exact: true,
    }),
  ).toBeVisible();
  await main.getByRole("button", { name: "准备组件", exact: true }).click();
  await page.evaluate(() => window.__multiplayerTest.finishPreparation());
  await expect(componentNotice).toHaveCount(0);
  await expect(
    main.getByRole("button", { name: "准备组件", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.__multiplayerTest.snapshot.tunnelReady = false;
  });
  await expect(
    main.getByRole("button", { name: "导入组件", exact: true }),
  ).toBeVisible();
  await main.getByRole("button", { name: "导入组件", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        window.__multiplayerTest.calls
          .filter((call) => call.operation === "multiplayer.prepare")
          .at(-1).payload,
    ),
  ).toMatchObject({
    tunnel: true,
    archive: "C:/Fixtures/easytier-windows-x86_64-v2.6.4.zip",
  });
  await page.evaluate(() => window.__multiplayerTest.finishPreparation());
  await expect(componentNotice).toHaveCount(0);
  await main.getByRole("tab", { name: "加入房间", exact: true }).click();
  await expect(componentList).toHaveCount(0);
  await main.getByRole("tab", { name: "创建房间", exact: true }).click();
  await expect(componentList).toHaveCount(0);
  await main.getByRole("tab", { name: "官方", exact: true }).click();
  await expect(componentList).toHaveCount(0);
  await main.getByRole("tab", { name: "自定义", exact: true }).click();
  pass(
    "选择 Cloudflare 后显示缺失组件状态、提前下载、取消重试、导入时获取隧道、全部就绪后隐藏状态卡片，切换官方和加入模式保持隐藏",
  );
  const connectionRow = main.locator(".multiplayer-connection-row");
  await expect
    .poll(async () => {
      const row = await connectionRow.boundingBox();
      const select = await connectionMode.boundingBox();
      return Math.abs(row.width - select.width);
    })
    .toBeLessThan(1);
  await go("版本管理");
  await go("联机");
  await expect(main.getByLabel("房间名称", { exact: true })).toHaveValue(
    "周末的生存世界",
  );
  await main.screenshot({ path: `${evidence}/create-light.png` });
  await page.evaluate(() => {
    window.__multiplayerTest.prepareRoom = true;
    window.__multiplayerTest.failOperation = "multiplayer.create";
  });
  await main.getByRole("button", { name: "创建房间", exact: true }).click();
  await expect(notification("联机操作失败")).toBeVisible();
  await notification("联机操作失败").click();
  await page.evaluate(() => {
    window.__multiplayerTest.failOperation = "";
  });
  await main.getByRole("button", { name: "创建房间", exact: true }).click();
  expect(
    await page.evaluate(() =>
      Object.hasOwn(
        window.__multiplayerTest.calls
          .filter((call) => call.operation === "multiplayer.create")
          .at(-1).payload,
        "server",
      ),
    ),
  ).toBe(false);
  await expect(main.getByRole("progressbar")).toHaveCount(0);
  await expect(main.getByLabel("房间名称", { exact: true })).toBeDisabled();
  await expect(connectionMode).toBeDisabled();
  await expect(main.getByRole("list", { name: "你的小伙伴" })).toHaveCount(0);
  await main.getByRole("button", { name: "查看下载", exact: true }).click();
  await expect(
    downloads.getByRole("button", {
      name: `暂停 ${downloadTitle}`,
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.__multiplayerTest.finishPreparation();
    window.__multiplayerTest.prepareRoom = false;
  });
  await go("联机");
  await expect(
    main.getByRole("list", { name: "你的小伙伴" }).getByRole("listitem"),
  ).toHaveCount(2);
  await expect(main.locator(".multiplayer-service-tabs")).toBeHidden();
  await main.getByRole("button", { name: "复制邀请码", exact: true }).click();
  expect(await page.evaluate(() => window.__multiplayerTest.copied)).toBe(
    "SFMCL2.fixture-private-invitation",
  );
  await go("开始游戏");
  await go("联机");
  await expect(main.getByRole("button", { name: "关闭房间" })).toBeVisible();
  await main.screenshot({ path: `${evidence}/room-light.png` });
  await main.getByRole("button", { name: "关闭房间" }).click();
  await expect(main.getByRole("tablist", { name: "联机服务" })).toBeVisible();
  pass("端口验证、表单保留、创建房间、成员路由、复制邀请与关闭");
  await connectionMode.focus();
  await page.keyboard.press("End");
  await expect(page.getByRole("option")).toHaveText([
    "Cloudflare Tunnel + 本机EasyTier",
    "共享EasyTier节点",
  ]);
  await page.keyboard.press("Enter");
  await expect(connectionMode).toContainText("共享EasyTier节点");
  await expect(sharedNode).toHaveValue("");
  expect(await sharedNode.evaluate((input) => input.required)).toBe(true);
  const createCount = () =>
    page.evaluate(
      () =>
        window.__multiplayerTest.calls.filter(
          (call) => call.operation === "multiplayer.create",
        ).length,
    );
  const beforeInvalidNode = await createCount();
  await main.getByRole("button", { name: "创建房间", exact: true }).click();
  expect(await createCount()).toBe(beforeInvalidNode);
  await sharedNode.fill("   ");
  await main.getByRole("button", { name: "创建房间", exact: true }).click();
  await expect(
    notification("请输入 EasyTier 共享节点地址").first(),
  ).toBeVisible();
  await expect(main.getByRole("alert")).toHaveCount(0);
  expect(await createCount()).toBe(beforeInvalidNode);
  await sharedNode.fill("  tcp://node.example:11010  ");
  await go("版本管理");
  await go("联机");
  await expect(connectionMode).toContainText("共享EasyTier节点");
  await expect(sharedNode).toHaveValue("  tcp://node.example:11010  ");
  await expect
    .poll(async () => {
      const row = await connectionRow.boundingBox();
      const select = await connectionMode.boundingBox();
      const input = await sharedNode.boundingBox();
      return (
        select.width < row.width * 0.6 &&
        input.x + input.width < select.x &&
        Math.abs(input.y - select.y) < 4
      );
    })
    .toBe(true);
  await main.screenshot({ path: `${evidence}/shared-node-light.png` });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await main.screenshot({ path: `${evidence}/shared-node-dark.png` });
  await page.setViewportSize({ width: 850, height: 1000 });
  await main.screenshot({ path: `${evidence}/shared-node-compact.png` });
  expect(
    await main.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  const compactInput = await sharedNode.boundingBox();
  const compactSelect = await connectionMode.boundingBox();
  expect(compactInput.x + compactInput.width).toBeLessThan(compactSelect.x);
  expect(Math.abs(compactInput.y - compactSelect.y)).toBeLessThan(4);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await main.getByRole("button", { name: "创建房间", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        window.__multiplayerTest.calls
          .filter((call) => call.operation === "multiplayer.create")
          .at(-1).payload.server,
    ),
  ).toBe("tcp://node.example:11010");
  await main.getByRole("button", { name: "复制邀请码", exact: true }).click();
  expect(await page.evaluate(() => window.__multiplayerTest.copied)).toBe(
    "SFMCL1.fixture-private-invitation",
  );
  await main.getByRole("button", { name: "关闭房间" }).click();
  await sharedNode.fill("  wss://node.example:11011  ");
  await main.screenshot({ path: `${evidence}/shared-node-wss.png` });
  await main.getByRole("button", { name: "创建房间", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        window.__multiplayerTest.calls
          .filter((call) => call.operation === "multiplayer.create")
          .at(-1).payload.server,
    ),
  ).toBe("wss://node.example:11011");
  await main.getByRole("button", { name: "复制邀请码", exact: true }).click();
  expect(await page.evaluate(() => window.__multiplayerTest.copied)).toBe(
    "SFMCL1.fixture-private-invitation",
  );
  await main.getByRole("button", { name: "关闭房间" }).click();
  await expect(sharedNode).toHaveValue("  wss://node.example:11011  ");
  await sharedNode.fill("  tcp://node.example:11010  ");
  await connectionMode.click();
  await page
    .getByRole("option", {
      name: "Cloudflare Tunnel + 本机EasyTier",
      exact: true,
    })
    .click();
  await expect(sharedNode).toHaveCount(0);
  await main.getByRole("button", { name: "创建房间", exact: true }).click();
  expect(
    await page.evaluate(() =>
      Object.hasOwn(
        window.__multiplayerTest.calls
          .filter((call) => call.operation === "multiplayer.create")
          .at(-1).payload,
        "server",
      ),
    ),
  ).toBe(false);
  await main.getByRole("button", { name: "关闭房间" }).click();
  await connectionMode.click();
  await page
    .getByRole("option", { name: "共享EasyTier节点", exact: true })
    .click();
  await expect(sharedNode).toHaveValue("  tcp://node.example:11010  ");
  await connectionMode.click();
  await page
    .getByRole("option", {
      name: "Cloudflare Tunnel + 本机EasyTier",
      exact: true,
    })
    .click();
  pass(
    "联机方式键盘切换、输入框左侧展开与选择框收窄、共享节点必填、TCP/WSS 请求按模式提交、模式及地址保留、暗色与窄布局",
  );
  await page.evaluate(() => {
    const fixture = window.__pixelTest;
    fixture.data.settings.activePlayer = "";
    fixture.data.settings.activeVersion = "";
    fixture.tasks.jobs = [
      {
        id: "host-fabric",
        title: "启动 1.20.1-Fabric",
        status: "running",
        currentStep: 0,
        steps: [{ name: "检查游戏与 Java", status: "running", detail: "" }],
        log: [],
        launch: {
          versionId: "1.20.1-Fabric",
          gameVersion: "1.20.1",
          directory: "C:/Other-Running-Game",
          playerName: "Steve",
          offlineLan: false,
          running: false,
        },
      },
      {
        id: "refresh-empty-selection",
        title: "刷新",
        status: "completed",
        currentStep: 0,
        steps: [],
        log: [],
      },
    ];
  });
  await go("版本管理");
  await go("联机");
  await expect(
    main.locator('.multiplayer-host-hint[role="status"]'),
  ).toHaveText("游戏还在启动，请进入世界并对局域网开放后创建房间。");
  await expect(
    main.getByRole("button", { name: "创建房间", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    window.__pixelTest.tasks.jobs[0].launch.running = true;
  });
  await expect(
    main.locator('.multiplayer-host-hint[role="status"]'),
  ).toHaveCount(0);
  await expect(
    main.getByRole("button", { name: "创建房间", exact: true }),
  ).toBeEnabled();
  await main.getByRole("button", { name: "创建房间", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        window.__multiplayerTest.calls
          .filter((call) => call.operation === "multiplayer.create")
          .at(-1).payload,
    ),
  ).toEqual({
    name: "周末的生存世界",
    port: 51234,
    launchId: "host-fabric",
  });
  expect(
    await page.evaluate(() => [
      window.__pixelTest.data.settings.activePlayer,
      window.__pixelTest.data.settings.activeVersion,
    ]),
  ).toEqual(["", ""]);
  await main.getByRole("button", { name: "关闭房间" }).click();
  await page.evaluate(() => {
    const first = window.__pixelTest.tasks.jobs[0];
    window.__pixelTest.tasks.jobs.unshift({
      ...structuredClone(first),
      id: "host-vanilla",
      title: "启动 1.21.4",
      launch: {
        ...first.launch,
        versionId: "1.21.4",
        gameVersion: "1.21.4",
        playerName: "Alex",
        offlineLan: true,
        running: false,
      },
    });
  });
  await expect(
    main.getByRole("combobox", { name: "房主游戏", exact: true }),
  ).toContainText("1.20.1-Fabric");
  await expect(
    main.getByRole("button", { name: "创建房间", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    window.__pixelTest.tasks.jobs[0].launch.running = true;
  });
  await expect(
    main.getByRole("button", { name: "创建房间", exact: true }),
  ).toBeDisabled();
  await main.getByRole("combobox", { name: "房主游戏", exact: true }).click();
  await page.getByRole("option").filter({ hasText: "1.21.4" }).click();
  await expect(
    main.getByRole("combobox", { name: "房主游戏", exact: true }),
  ).toContainText("1.21.4");
  await main.getByRole("combobox", { name: "房主游戏", exact: true }).click();
  await page.getByRole("option").filter({ hasText: "1.20.1-Fabric" }).click();
  await expect(main.getByText(/^当前游戏：/)).toHaveCount(0);
  await expect(
    main.getByRole("button", { name: "创建房间", exact: true }),
  ).toBeEnabled();
  await go("版本管理");
  await go("联机");
  await expect(
    main.getByRole("combobox", { name: "房主游戏", exact: true }),
  ).toContainText("1.20.1-Fabric");
  await main.screenshot({ path: `${evidence}/host-game-selection.png` });
  await main.getByRole("button", { name: "创建房间", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        window.__multiplayerTest.calls
          .filter((call) => call.operation === "multiplayer.create")
          .at(-1).payload.launchId,
    ),
  ).toBe("host-fabric");
  await main.getByRole("button", { name: "关闭房间" }).click();
  await page.evaluate(() => {
    window.__pixelTest.tasks.jobs = [
      {
        id: "refresh-restored-selection",
        title: "刷新",
        status: "completed",
        currentStep: 0,
        steps: [],
        log: [],
      },
    ];
    window.__pixelTest.data.settings.activePlayer = "pixel-player";
    window.__pixelTest.data.settings.activeVersion = "1.21.4";
  });
  await go("版本管理");
  await go("联机");
  await expect(
    main.locator('.multiplayer-host-hint[role="status"]'),
  ).toHaveCount(0);
  await expect(
    main.getByRole("combobox", { name: "房主游戏", exact: true }),
  ).toHaveCount(0);
  pass(
    "运行实例角色和版本自动识别、启动中禁用、多实例选择与切页保留、不改写全局选择",
  );
  await main.getByRole("tab", { name: "创建房间" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(main.getByRole("tab", { name: "加入房间" })).toBeFocused();
  await main.getByLabel("联机邀请码").fill("invalid");
  await main.getByRole("button", { name: "查看房间" }).click();
  await expect(notification("邀请码无效")).toBeVisible();
  await expect(main.getByRole("alert")).toHaveCount(0);
  await main.getByLabel("联机邀请码").fill("SFMCL2.fixture-private-invitation");
  await main.getByRole("button", { name: "查看房间" }).click();
  await expect(
    main.getByText("wss://quiet-blue-bird.trycloudflare.com", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.__multiplayerTest.prepareRoom = true;
  });
  await main.getByRole("button", { name: "加入房间", exact: true }).click();
  await expect(main.getByLabel("联机邀请码")).toBeDisabled();
  await expect(main.getByRole("progressbar")).toHaveCount(0);
  await expect(main.getByRole("button", { name: "启动并连接" })).toHaveCount(0);
  await main.getByRole("button", { name: "查看下载", exact: true }).click();
  await page.evaluate(() => window.__multiplayerTest.finishPreparation());
  await go("联机");
  await expect(main.locator(".multiplayer-service-tabs")).toBeHidden();
  await main.getByRole("button", { name: "启动并连接" }).click();
  expect(
    await page.evaluate(
      () =>
        window.__multiplayerTest.calls.find(
          (call) => call.operation === "launch",
        ).payload,
    ),
  ).toEqual({
    sessionId: "room-session",
    id: "1.21.4",
    directory: "C:/Pixel-Test/Minecraft",
  });
  await main.getByRole("button", { name: "复制地址", exact: true }).click();
  expect(await page.evaluate(() => window.__multiplayerTest.copied)).toBe(
    "127.0.0.1:51234",
  );
  await page.evaluate(() => {
    window.__multiplayerTest.snapshot.worldOpen = false;
    window.__multiplayerTest.snapshot.state = "waiting";
  });
  await expect(main.getByRole("button", { name: "启动并连接" })).toBeDisabled();
  await page.evaluate(() => {
    window.__multiplayerTest.snapshot.worldOpen = true;
    window.__multiplayerTest.snapshot.state = "ready";
    document.documentElement.dataset.theme = "dark";
  });
  await expect(main.getByRole("button", { name: "启动并连接" })).toBeEnabled();
  await main.screenshot({ path: `${evidence}/room-dark.png` });
  await page.setViewportSize({ width: 850, height: 1000 });
  await main.screenshot({ path: `${evidence}/room-compact.png` });
  expect(
    await main.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await main.getByRole("button", { name: "离开房间" }).click();
  await expect(main.getByRole("tablist", { name: "联机服务" })).toBeVisible();
  expect(
    await page.evaluate(() =>
      JSON.stringify(localStorage).includes("fixture-private-invitation"),
    ),
  ).toBe(false);
  await expect(main.getByLabel("联机邀请码")).toHaveValue("");
  pass(
    "邀请预览、非法输入、临时启动目标、世界关闭禁用、暗色与窄布局、凭据不持久化",
  );
  const official = main.getByRole("tab", { name: "官方", exact: true });
  await page.evaluate(() => {
    window.__multiplayerTest.prepareRoom = false;
  });
  const custom = main.getByRole("tab", { name: "自定义", exact: true });
  await custom.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(official).toBeFocused();
  await expect(official).toHaveAttribute("aria-selected", "true");
  await expect(main.getByLabel("邀请码", { exact: true })).toBeVisible();
  await main.getByLabel("邀请码", { exact: true }).fill("ABCD!234");
  await expect(main.getByLabel("邀请码", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  const queries = await page.evaluate(
    () =>
      window.__multiplayerTest.calls.filter(
        (c) => c.operation === "multiplayer.official.preview",
      ).length,
  );
  await main.getByRole("button", { name: "查看房间", exact: true }).click();
  await expect(notification("请输入 8 位英文字母或数字邀请码")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.__multiplayerTest.calls.filter(
          (c) => c.operation === "multiplayer.official.preview",
        ).length,
    ),
  ).toBe(queries);
  await main.getByLabel("邀请码", { exact: true }).fill("ABC1234");
  await main.getByRole("button", { name: "查看房间", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        window.__multiplayerTest.calls.filter(
          (c) => c.operation === "multiplayer.official.preview",
        ).length,
    ),
  ).toBe(queries);
  for (const code of ["12345678", "a1b2c3d4"]) {
    await main.getByLabel("邀请码", { exact: true }).fill(code);
    await expect(main.getByLabel("邀请码", { exact: true })).toHaveValue(
      code.toUpperCase(),
    );
    await expect(main.getByLabel("邀请码", { exact: true })).toHaveAttribute(
      "aria-invalid",
      "false",
    );
    await main.getByRole("button", { name: "查看房间", exact: true }).click();
    await expect(main.locator(".multiplayer-preview")).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          window.__multiplayerTest.calls
            .filter((c) => c.operation === "multiplayer.official.preview")
            .at(-1).payload.invitation,
      ),
    ).toBe(code.toUpperCase());
  }
  await main.getByLabel("邀请码", { exact: true }).fill("abcdefgh");
  await expect(main.getByLabel("邀请码", { exact: true })).toHaveValue(
    "ABCDEFGH",
  );
  const cells = main.locator(".multiplayer-invite-cell");
  await expect(cells).toHaveCount(8);
  expect((await cells.allTextContents()).join("")).toBe("ABCDEFGH");
  await expect(main.locator(".multiplayer-invite-divider")).toHaveText("-");
  await cells.nth(2).click();
  await page.keyboard.type("z");
  await expect(main.getByLabel("邀请码", { exact: true })).toHaveValue(
    "ABZDEFGH",
  );
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  await expect(main.getByLabel("邀请码", { exact: true })).toHaveValue(
    "AZDEFGH",
  );
  await main.getByLabel("邀请码", { exact: true }).fill("");
  await main.getByLabel("邀请码", { exact: true }).evaluate((input) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "a1b2-c3d4");
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    );
  });
  await expect(main.getByLabel("邀请码", { exact: true })).toHaveValue(
    "A1B2C3D4",
  );
  await expect(main.getByLabel("邀请码", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "false",
  );
  expect((await cells.allTextContents()).join("")).toBe("A1B2C3D4");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      const geometry = await main
        .locator(".multiplayer-invite-row")
        .evaluate((row) => {
          const parent = row.parentElement.getBoundingClientRect();
          const bounds = row.getBoundingClientRect();
          return {
            centered: Math.abs(
              (bounds.left + bounds.right) / 2 -
                (parent.left + parent.right) / 2,
            ),
            fits: bounds.width <= parent.width + 1,
            cells: [...row.querySelectorAll(".multiplayer-invite-cell")].map(
              (cell) => {
                const bounds = cell.getBoundingClientRect();
                return { width: bounds.width, height: bounds.height };
              },
            ),
          };
        });
      expect(geometry.centered).toBeLessThanOrEqual(1);
      expect(geometry.fits).toBe(true);
      geometry.cells.forEach((cell) =>
        expect(Math.abs(cell.width - cell.height)).toBeLessThanOrEqual(1),
      );
      await main
        .locator(".multiplayer-field")
        .screenshot({ path: `${evidence}/invite-boxes-${theme}-${width}.png` });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  pass(
    "字母数字邀请码校验、居中八个正方形与四格分隔、逐字修改退格、带分隔符混合码粘贴及明暗窄宽布局",
  );
  await page.evaluate(() => {
    window.__multiplayerTest.previewPending = true;
  });
  await main.getByRole("button", { name: "查看房间", exact: true }).click();
  await expect(
    main.getByRole("button", { name: "查询中…", exact: true }),
  ).toBeDisabled();
  await main.getByLabel("邀请码", { exact: true }).fill("IJKLMNOP");
  await custom.click();
  await page.evaluate(() => {
    window.__multiplayerTest.previewPending = false;
    window.__multiplayerTest.finishPreview();
  });
  await expect(main.locator(".multiplayer-preview")).toHaveCount(0);
  await official.click();
  await expect(main.getByLabel("邀请码", { exact: true })).toHaveValue(
    "IJKLMNOP",
  );
  await main.getByLabel("邀请码", { exact: true }).fill("a1b2c3d4");
  await main.getByRole("button", { name: "查看房间", exact: true }).click();
  await expect(main.getByText("官方生存房间", { exact: true })).toBeVisible();
  await main.getByRole("button", { name: "加入房间", exact: true }).click();
  await expect(main.getByRole("region", { name: "当前房间" })).toBeVisible();
  await expect(main.locator(".multiplayer-service-tabs")).toBeHidden();
  expect(
    await page.evaluate(
      () =>
        window.__multiplayerTest.calls
          .filter((c) => c.operation === "multiplayer.official.join")
          .at(-1).payload.invitation,
    ),
  ).toBe("A1B2C3D4");
  await expect(main.getByLabel("官方房间邀请码")).toHaveCount(0);
  await expect(main.locator(".multiplayer-invite-copy")).toHaveCount(0);
  await main.getByRole("button", { name: "离开房间", exact: true }).click();
  await expect(main.getByRole("tablist", { name: "联机服务" })).toBeVisible();
  await main.getByRole("tab", { name: "创建房间", exact: true }).click();
  await expect(
    main.getByRole("combobox", { name: "联机方式", exact: true }),
  ).toHaveCount(0);
  await main.getByLabel("游戏端口", { exact: true }).fill("25565");
  await main.getByRole("button", { name: "创建房间", exact: true }).click();
  await expect(main.getByRole("region", { name: "当前房间" })).toBeVisible();
  await expect(main.locator(".multiplayer-service-tabs")).toBeHidden();
  expect(
    await page.evaluate(
      () =>
        window.__multiplayerTest.calls
          .filter((c) => c.operation === "multiplayer.official.create")
          .at(-1).payload.server,
    ),
  ).toBeUndefined();
  await expect(main.getByLabel("官方房间邀请码")).toContainText("A1B2-C3D4");
  await main
    .getByRole("button", { name: "复制邀请码 A1B2-C3D4", exact: true })
    .click();
  expect(await page.evaluate(() => window.__multiplayerTest.copied)).toBe(
    "A1B2-C3D4",
  );
  await main.getByRole("button", { name: "复制邀请码", exact: true }).click();
  expect(await page.evaluate(() => window.__multiplayerTest.copied)).toBe(
    "A1B2-C3D4",
  );
  await go("版本管理");
  await go("联机");
  await expect(main.getByLabel("官方房间邀请码")).toContainText("A1B2-C3D4");
  await main.screenshot({ path: `${evidence}/official-room-dark.png` });
  await main.getByRole("button", { name: "关闭房间", exact: true }).click();
  await expect(main.getByRole("tablist", { name: "联机服务" })).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await custom.click();
      await official.click();
      await expect
        .poll(
          async () =>
            (await official.boundingBox()).width -
            (await custom.boundingBox()).width,
        )
        .toBeGreaterThan(5);
      const fit = await main
        .locator(".multiplayer-service-tabs")
        .evaluate((el) => ({
          fits: el.scrollWidth <= el.clientWidth + 1,
          width: el.clientWidth,
        }));
      expect(fit.fits).toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
      await main.screenshot({
        path: `${evidence}/official-${theme}-${width}.png`,
      });
    }
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await official.evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toContain("0.28s");
  await custom.click();
  await expect(custom).toHaveAttribute("aria-selected", "true");
  const sampleTransition = async (name, nested = false) =>
    page.evaluate(
      async ({ name, nested }) => {
        const root = document.querySelector('main[data-page="multiplayer"]');
        const button = [...root.querySelectorAll('[role="tab"]')].find(
          (tab) => tab.textContent.trim() === name,
        );
        button.click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const panel = root.querySelector(
          nested
            ? '.multiplayer-room > [role="tabpanel"]'
            : ".multiplayer-service-panel",
        );
        const animation = panel
          .getAnimations()
          .find((animation) => animation.id === "sfmcl-t-resource-tab");
        if (!animation) return null;
        animation.pause();
        animation.currentTime = 80;
        const style = getComputedStyle(panel);
        const result = {
          opacity: Number(style.opacity),
          x: new DOMMatrixReadOnly(style.transform).m41,
          duration: animation.effect.getTiming().duration,
        };
        animation.finish();
        return result;
      },
      { name, nested },
    );
  for (const [name, direction] of [
    ["官方", -1],
    ["自定义", 1],
  ]) {
    const frame = await sampleTransition(name);
    expect(frame).not.toBeNull();
    expect(frame.duration).toBe(240);
    expect(frame.opacity).toBeGreaterThan(0.15);
    expect(frame.opacity).toBeLessThan(1);
    expect(frame.x * direction).toBeGreaterThan(0);
  }
  for (const [name, direction] of [
    ["加入房间", 1],
    ["创建房间", -1],
  ]) {
    const frame = await sampleTransition(name, true);
    expect(frame).not.toBeNull();
    expect(frame.duration).toBe(240);
    expect(frame.opacity).toBeLessThan(1);
    expect(frame.x * direction).toBeGreaterThan(0);
  }
  await expect(main.getByLabel("房间名称", { exact: true })).toHaveValue(
    "周末的生存世界",
  );
  await expect
    .poll(() =>
      main
        .locator(".multiplayer-service-panel")
        .evaluate((panel) => panel.getAnimations().length),
    )
    .toBe(0);
  pass(
    "官方/自定义伸展 Tab、键盘切换、8 位校验、查询加载与陈旧响应、官方创建加入复制、切页保持、双主题四种宽度、两层内容切换动画及系统偏好下的完整动画",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/report.json`,
    JSON.stringify({ checks, errors, scope: "browser fixture only" }, null, 2),
  );
} finally {
  await browser.close();
}
