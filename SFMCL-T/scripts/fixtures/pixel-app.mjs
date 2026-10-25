// Deterministic in-memory Tauri bridge for browser UI checks.
export function pixelAppFixture({
  components = false,
  persistJavaLists = false,
} = {}) {
  const settings = {
    schemaVersion: 1,
    gameDirs: [{ name: "像素工坊", path: "C:/Pixel-Test/Minecraft" }],
    activeDir: "C:/Pixel-Test/Minecraft",
    activeVersion: "1.21.4",
    activePlayer: "pixel-player",
    javaPath: "",
    javaPaths: [
      "C:/Java/jdk-21/bin/javaw.exe",
      "C:/Very Long Java Installation Directory/Custom Minecraft Runtime/jdk-17/bin/javaw.exe",
    ],
    autoMemory: true,
    memoryMb: 4096,
    isolation: true,
    fullscreen: false,
    width: 1280,
    height: 720,
    windowTitle: "",
    customInfo: "SFMCL-T",
    jvmArgsEnabled: false,
    jvmArgs: "",
    gameArgs: "",
    theme: "light",
    accent: "forest",
    backgroundType: "none",
    background: "",
    hardwareAcceleration: true,
    showNotices: false,
    downloadTaskDisplay: components ? "always" : "off",
    downloadConcurrency: 8,
    downloadCacheDir: "",
    microsoftClientId: "",
    closeOnLaunch: false,
  };
  const data = {
    settings,
    players: [
      {
        uuid: "pixel-player",
        name: "Alex",
        online: false,
        skin: "",
        slim: false,
      },
    ],
    dataDir: "C:/Pixel-Test",
    defaultDownloadCacheDir: "C:/Pixel-Test/downloads/cache",
    version: "0.1.0",
  };
  const versions = ["1.21.4", "1.20.1-Fabric"].map((id) => ({
    id,
    version: id.split("-")[0],
    kind: "release",
    loader: id.includes("Fabric") ? "Fabric" : "Vanilla",
    path: `${settings.activeDir}/.minecraft/versions/${id}`,
    javaMajor: 21,
    icon: "",
  }));
  const requests = [];
  const tasks = { downloads: [], jobs: [] };
  const delays = {};
  const failures = {};
  const versionSettings = {};
  const gameSettings = (value) =>
    Object.fromEntries(
      [
        "javaPath",
        "javaPaths",
        "autoMemory",
        "memoryMb",
        "isolation",
        "fullscreen",
        "width",
        "height",
        "windowTitle",
        "customInfo",
        "jvmArgsEnabled",
        "jvmArgs",
        "gameArgs",
      ].map((key) => [key, structuredClone(value[key])]),
    );
  const javaKey = (path) => path.replaceAll("\\", "/").toLowerCase();
  const javaRuntime = (path) => {
    const major = Number(path.match(/jdk-(\d+)/i)?.[1] || 21);
    return { path, major, version: `${major}.0.1`, architecture: "x64" };
  };
  const javaInventory = [
    ...settings.javaPaths,
    "C:/Java/jdk-8/bin/java.exe",
  ].map(javaRuntime);
  const snapshotKey = "pixel-test-java-settings";
  if (persistJavaLists && sessionStorage.getItem(snapshotKey)) {
    const saved = JSON.parse(sessionStorage.getItem(snapshotKey));
    data.settings = saved.settings;
    Object.assign(versionSettings, saved.versionSettings);
  }
  const persist = () => {
    if (persistJavaLists)
      sessionStorage.setItem(
        snapshotKey,
        JSON.stringify({ settings: data.settings, versionSettings }),
      );
  };
  if (components) {
    data.players.push({
      uuid: "steve-player",
      name: "Steve",
      online: false,
      skin: "",
      slim: false,
    });
    tasks.downloads = [
      ["minecraft", "Minecraft 1.21.4", "running"],
      ["fabric", "Fabric API", "paused"],
      ["world", "世界备份", "completed"],
      ["pack", "资源包下载", "failed"],
    ].map(([id, title, status]) => ({
      id,
      title,
      status,
      downloaded: status === "completed" ? 104857600 : 67108864,
      total: 104857600,
      unknownSize: false,
      completed: status === "completed" ? 80 : 51,
      failed: status === "failed" ? 1 : 0,
      fileCount: 80,
      speed: status === "running" ? 5242880 : 0,
      workers: status === "running" ? 8 : 0,
      steps: [],
      error: status === "failed" ? "连接暂时中断，可以继续下载。" : undefined,
    }));
    tasks.jobs = [
      {
        id: "install-job",
        title: "安装 Minecraft 1.21.4",
        status: "running",
        currentStep: 1,
        steps: [
          { name: "获取版本", status: "completed", detail: "1.21.4" },
          { name: "下载文件", status: "running", detail: "正在准备游戏资源" },
          { name: "验证安装", status: "queued", detail: "" },
        ],
        log: ["准备安装 Minecraft 1.21.4"],
      },
    ];
  }
  window.__pixelTest = {
    data,
    requests,
    tasks,
    delays,
    failures,
    versionSettings,
    javaInventory,
    availableMemoryMb: 16384,
  };
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback: () => 1,
    unregisterCallback: () => {},
    invoke: async (command, args) => {
      if (command === "startup_window") {
        (window.__pixelTest.startupPhases ??= []).push(args.phase);
        return;
      }
      if (command === "plugin:window|is_maximized") return false;
      if (command === "plugin:event|listen") return 1;
      if (command === "plugin:event|unlisten") return;
      if (command === "plugin:dialog|open")
        return window.__pixelTest.pickedDirectory ?? null;
      if (command !== "request")
        throw new Error(`Unexpected native operation: ${command}`);
      const { operation, payload = {} } = args;
      requests.push({ operation, payload: structuredClone(payload) });
      if (delays[operation]) {
        await new Promise((resolve) => setTimeout(resolve, delays[operation]));
      }
      if (failures[operation]) throw new Error(failures[operation]);
      switch (operation) {
        case "bootstrap":
          return structuredClone(data);
        case "tasks":
          return structuredClone(tasks);
        case "versions.list":
          return versions.map((version) => {
            const config = versionSettings[version.id];
            return {
              ...version,
              independentSettings:
                !!config &&
                !config.useGlobal &&
                (!config.independentGroups ||
                  Object.values(config.independentGroups).some(Boolean)),
              isolation:
                config &&
                !config.useGlobal &&
                (config.independentGroups?.memory ?? true)
                  ? config.settings.isolation
                  : data.settings.isolation,
            };
          });
        case "versions.favorites":
          return versions
            .filter((version) => version.favorite)
            .map((version) => ({
              ...version,
              directory: data.settings.activeDir,
              directoryName:
                data.settings.gameDirs.find(
                  (directory) => directory.path === data.settings.activeDir,
                )?.name || "游戏目录",
            }));
        case "versions.settings.get":
          return structuredClone(
            versionSettings[payload.id] || {
              useGlobal: true,
              settings: gameSettings(data.settings),
            },
          );
        case "versions.settings.save":
          versionSettings[payload.id] = structuredClone(payload.config);
          persist();
          return structuredClone(payload.config);
        case "settings.save":
          data.settings = structuredClone(payload);
          persist();
          return data.settings;
        case "system.memory":
          return { availableMb: window.__pixelTest.availableMemoryMb };
        case "java.discover":
          return structuredClone(javaInventory);
        case "java.list":
          return (payload.paths || data.settings.javaPaths).map(javaRuntime);
        case "java.probe":
          return javaRuntime(payload.path);
        case "java.paths.save": {
          const target = payload.versionId
            ? (versionSettings[payload.versionId] ??= {
                useGlobal: true,
                settings: gameSettings(data.settings),
              }).settings
            : data.settings;
          target.javaPaths = [
            ...new Map(
              payload.paths
                .filter(
                  (path) =>
                    path.trim() &&
                    (!payload.removedPath ||
                      javaKey(path) !== javaKey(payload.removedPath)),
                )
                .map((path) => [javaKey(path), path]),
            ).values(),
          ];
          if (
            payload.removedPath &&
            javaKey(target.javaPath) === javaKey(payload.removedPath)
          )
            target.javaPath = "";
          persist();
          return structuredClone(target.javaPaths);
        }
        case "versions.select":
          if (payload.directory) data.settings.activeDir = payload.directory;
          data.settings.activeVersion = payload.id;
          return;
        case "versions.favorite":
          versions.find((version) => version.id === payload.id).favorite =
            payload.favorite;
          return true;
        case "players.select":
          data.settings.activePlayer = payload.id;
          return;
        case "downloads.cache.open":
          (window.__pixelTest.openedCacheDirectories ??= []).push(
            payload.path.trim() || data.defaultDownloadCacheDir,
          );
          return true;
        case "downloads.control": {
          if (payload.action === "clear") {
            tasks.downloads = tasks.downloads.filter(
              (item) => item.id !== payload.id,
            );
            return;
          }
          const download = tasks.downloads.find(
            (item) => item.id === payload.id,
          );
          if (download) {
            download.status =
              payload.action === "pause"
                ? "paused"
                : payload.action === "cancel"
                  ? "cancelled"
                  : "running";
            download.speed = download.status === "running" ? 1024 * 1024 : 0;
          }
          return;
        }
        case "players.skin":
          data.players[0].slim = payload.slim;
          return data.players[0];
        case "players.add":
          data.players.push({
            uuid: "new-player",
            name: payload.name,
            online: false,
            skin: "",
            slim: false,
          });
          return data.players.at(-1);
        case "notices.list":
          return [];
        case "manifest":
          return {
            versions: ["1.21.4", "1.20.1", "1.19.4"].map((id) => ({
              id,
              type: "release",
              releaseTime: "2026-01-01",
              url: "",
            })),
          };
        case "loaders":
          await new Promise((resolve) => setTimeout(resolve, 180));
          return [
            { kind: payload.kind, version: "0.16.9", metadata: {} },
            { kind: payload.kind, version: "0.16.10", metadata: {} },
          ];
        case "resources.categories":
          return [
            { id: "optimization", name: "性能优化" },
            { id: "worldgen", name: "世界生成" },
          ];
        case "resources.files":
          return [
            {
              id: "fabric-api",
              name: "Fabric API",
              version: "0.92.0",
              date: "2026-01-01",
              gameVersions: ["1.20.1"],
              loaders: ["fabric"],
              dependencies: [],
            },
          ];
        case "resources.local":
          return [];
        case "resources.detail":
          return {
            id: "sodium",
            source: "modrinth",
            title: "Sodium",
            description: "优化渲染性能，让方块世界更加流畅。",
            author: "Test",
            icon: "",
            downloads: 12000,
            categories: ["性能优化", "Fabric"],
            versions: ["1.20.1"],
            website: "https://modrinth.com/mod/sodium",
            body: "## 渲染优化\n提升帧率，保留原版的游戏体验。",
          };
        case "resources.search":
          return {
            total: 1,
            items: [
              {
                id: "sodium",
                source: "modrinth",
                title: "Sodium",
                description: "优化渲染性能，让方块世界更加流畅。",
                author: "Test",
                icon: "",
                downloads: 12000,
                categories: ["性能优化", "Fabric"],
                versions: ["1.20.1"],
                website: "",
                body: "",
              },
            ],
          };
        default:
          throw new Error(`Unexpected API operation: ${operation}`);
      }
    },
  };
}
