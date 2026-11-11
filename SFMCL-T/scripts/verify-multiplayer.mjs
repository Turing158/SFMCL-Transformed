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
    componentJobId: null,
    role: null,
    name: "",
    gameVersion: "",
    address: null,
    worldOpen: false,
    members: [],
    error: null,
  };
  const state = (window.__multiplayerTest = {
    snapshot: { ...idle },
    calls: [],
    copied: "",
    failStatus: true,
    prepareRoom: false,
    pendingRoom: null,
    preparationCount: 0,
  });
  const beginPreparation = (room = null, archive = false) => {
    state.pendingRoom = room;
    const count = ++state.preparationCount;
    const jobId = `component-job-${count}`;
    const downloadId = archive ? null : `component-download-${count}`;
    window.__pixelTest.tasks.jobs.unshift({
      id: jobId,
      title: "准备联机组件 · EasyTier 2.6.4",
      status: "running",
      currentStep: 1,
      downloadId,
      steps: [
        { name: "检查组件", status: "completed", detail: "" },
        { name: "获取组件", status: "running", detail: "" },
        { name: "校验并安装", status: "queued", detail: "" },
      ],
      log: [],
    });
    if (downloadId) {
      window.__pixelTest.tasks.downloads.unshift({
        id: downloadId,
        title: "EasyTier 2.6.4 · 联机组件",
        status: "running",
        downloaded: 14695974,
        total: 32657720,
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
      state.snapshot = { ...idle, componentReady: status === "completed" };
    }
  };
  const readyRoom = (args) => {
    state.server = args.payload.server || "";
    const hostContext =
      args.operation === "multiplayer.create"
        ? window.__pixelTest.tasks.jobs.find(
            (job) => job.id === args.payload.launchId,
          )?.launch
        : undefined;
    state.snapshot = {
      ...idle,
      state: "ready",
      sessionId: "room-session",
      componentReady: true,
      role: args.operation.endsWith("create") ? "host" : "guest",
      name: "周末的生存世界",
      gameVersion: hostContext?.gameVersion || "1.21.4",
      address: "127.0.0.1:51234",
      worldOpen: true,
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
    switch (args.operation) {
      case "multiplayer.status":
        if (state.failStatus) throw Error("unavailable");
        return structuredClone(state.snapshot);
      case "multiplayer.prepare":
        beginPreparation(null, !!args.payload?.archive);
        break;
      case "multiplayer.leave":
        state.snapshot = { ...idle, componentReady: true };
        break;
      case "multiplayer.check-local-port":
        return { reachable: true };
      case "multiplayer.preview":
        if (!args.payload.invitation.startsWith("SFMCL2."))
          throw Error("邀请码无效");
        return {
          name: "周末的生存世界",
          gameVersion: "1.21.4",
          server: "wss://quiet-blue-bird.trycloudflare.com",
        };
      case "multiplayer.create":
      case "multiplayer.join": {
        if (state.prepareRoom) beginPreparation(args);
        else readyRoom(args);
        break;
      }
      case "multiplayer.invitation":
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
const nav = page.getByRole("navigation", { name: "主导航" });
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
  await expect(main.getByText("无法读取联机状态，请重试")).toBeVisible();
  await page.evaluate(() => {
    window.__multiplayerTest.failStatus = false;
  });
  await main.getByRole("button", { name: "刷新", exact: true }).click();
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
  await expect(
    main.getByRole("button", { name: "校验组件", exact: true }),
  ).toBeVisible();
  await expect(main.getByLabel("房间名称", { exact: true })).toBeEnabled();
  await main.getByRole("button", { name: "校验组件", exact: true }).click();
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
  await expect(main.getByText("请输入 1–65535 之间的整数端口")).toBeVisible();
  await main.getByLabel("游戏端口", { exact: true }).fill("51234");
  await main.getByRole("button", { name: "检查端口" }).click();
  await expect(main.getByText("端口可连接", { exact: true })).toBeVisible();
  const connectionMode = main.getByRole("combobox", {
    name: "联机方式",
    exact: true,
  });
  const sharedNode = main.getByLabel("共享节点", { exact: true });
  await expect(connectionMode).toContainText(
    "Cloudflare Tunnel + 本机EasyTier",
  );
  await expect(sharedNode).toHaveCount(0);
  await expect(main.locator("input")).toHaveCount(2);
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
  await expect(main.getByRole("list", { name: "网络成员" })).toHaveCount(0);
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
    main.getByRole("list", { name: "网络成员" }).getByRole("listitem"),
  ).toHaveCount(2);
  await main.getByRole("button", { name: "复制邀请码", exact: true }).click();
  expect(await page.evaluate(() => window.__multiplayerTest.copied)).toBe(
    "SFMCL2.fixture-private-invitation",
  );
  await go("开始游戏");
  await go("联机");
  await expect(main.getByRole("button", { name: "关闭房间" })).toBeVisible();
  await main.screenshot({ path: `${evidence}/room-light.png` });
  await main.getByRole("button", { name: "关闭房间" }).click();
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
  await expect(main.getByRole("alert")).toContainText(
    "请输入 EasyTier 共享节点地址",
  );
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
    "联机方式键盘切换、输入框左侧展开与选择框收窄、共享节点必填、请求按模式提交、模式及地址保留、暗色与窄布局",
  );
  const currentGame = main.getByRole("region", { name: "当前游戏" });
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
    currentGame.getByText("正在启动的游戏", { exact: true }),
  ).toBeVisible();
  await expect(currentGame.getByText("Steve", { exact: true })).toBeVisible();
  await expect(
    currentGame.getByText("1.20.1-Fabric", { exact: true }),
  ).toBeVisible();
  await expect(
    main.getByRole("button", { name: "创建房间", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    window.__pixelTest.tasks.jobs[0].launch.running = true;
  });
  await expect(
    currentGame.getByText("正在运行的游戏", { exact: true }),
  ).toBeVisible();
  await expect(
    main.getByRole("button", { name: "创建房间", exact: true }),
  ).toBeEnabled();
  await expect(
    currentGame.getByRole("button", { name: "选择角色", exact: true }),
  ).toHaveCount(0);
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
  await page.getByRole("option").filter({ hasText: "1.20.1-Fabric" }).click();
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
    currentGame.getByText("当前游戏", { exact: true }),
  ).toBeVisible();
  await expect(currentGame.getByText("Alex", { exact: true })).toBeVisible();
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
  await expect(main.getByRole("alert")).toContainText("邀请码无效");
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
  expect(
    await page.evaluate(() =>
      JSON.stringify(localStorage).includes("fixture-private-invitation"),
    ),
  ).toBe(false);
  await expect(main.getByLabel("联机邀请码")).toHaveValue("");
  pass(
    "邀请预览、非法输入、临时启动目标、世界关闭禁用、暗色与窄布局、凭据不持久化",
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/report.json`,
    JSON.stringify({ checks, errors, scope: "browser fixture only" }, null, 2),
  );
} finally {
  await browser.close();
}
