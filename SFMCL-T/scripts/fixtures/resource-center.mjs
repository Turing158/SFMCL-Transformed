// Extends pixelAppFixture with deterministic resource browsing and version-specific files.
export function resourceCenterFixture() {
  const base = window.__TAURI_INTERNALS__.invoke;
  const state = window.__pixelTest;
  const names = [
    "Sodium",
    "Fabric API",
    "Iris Shaders",
    "Lithium",
    "Mod Menu",
    "Jade",
    "ImmediatelyFast",
    "FerriteCore",
    "Entity Culling",
  ];
  const projects = Array.from({ length: 27 }, (_, index) => ({
    id: `project-${index}`,
    source: "modrinth",
    title: `${names[index % names.length]}${index > 8 ? ` ${index}` : ""}`,
    description:
      "优化游戏体验，让每一次探索更加流畅。支持多种版本，与熟悉的方块世界保持一致。",
    author: index % 2 ? "FabricMC" : "CaffeineMC",
    icon: "/assets/DefaultGameIcon/Fabric.png",
    downloads: 91203456 - index * 150400,
    categories: ["性能优化", "Fabric"],
    versions: ["1.21.4", "1.20.1"],
    website: "https://modrinth.com/mod/sodium",
    body: "## 项目介绍\n优化游戏性能。",
  }));
  const localItems = {};
  for (const id of ["1.21.4", "1.20.1-Fabric"]) {
    localItems[id] = Object.fromEntries(
      ["mod", "resourcepack", "shader", "world"].map((kind) => [
        kind,
        [
          {
            name: `${id} ${kind === "mod" ? "Sodium" : kind === "world" ? "我的世界" : kind === "shader" ? "Complementary" : "Faithful"}`,
            path: `${state.data.settings.activeDir}/.minecraft/versions/${id}/${{ mod: "mods", resourcepack: "resourcepacks", shader: "shaderpacks", world: "saves" }[kind]}/test${kind === "mod" ? ".jar" : ".zip"}`,
            kind,
            description: "本地资源说明",
            version: "1.0",
            authors: "Test",
            icon: "",
            disabled: false,
            size: 2048,
            details:
              kind === "world"
                ? {
                    seed: "9223372036854775807",
                    gameMode: 1,
                    difficulty: 2,
                    gameRules: { doDaylightCycle: "false" },
                  }
                : {},
          },
        ],
      ]),
    );
  }
  state.resources = {
    failNext: false,
    failCategories: false,
    localItems,
    kind: "mod",
    selectedDirectory: null,
  };
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "plugin:dialog|message") return "确认";
    if (command === "plugin:dialog|open") {
      state.requests.push({
        operation: command,
        payload: structuredClone(args),
      });
      return state.resources.selectedDirectory;
    }
    if (
      command !== "request" ||
      (!args.operation.startsWith("resources.") &&
        args.operation !== "path.open")
    )
      return base(command, args);
    const { operation, payload = {} } = args;
    state.requests.push({ operation, payload: structuredClone(payload) });
    if (state.delays[operation])
      await new Promise((resolve) =>
        setTimeout(resolve, state.delays[operation]),
      );
    if (state.failures[operation]) throw new Error(state.failures[operation]);
    if (operation === "resources.categories") {
      if (state.resources.failCategories) throw new Error("分类服务暂不可用");
      return [
        {
          id: payload.source === "curseforge" ? "123" : "optimization",
          name: "性能优化",
        },
        { id: "worldgen", name: "世界生成" },
      ];
    }
    if (operation === "resources.search") {
      state.resources.kind = payload.kind;
      if (state.resources.failNext) {
        state.resources.failNext = false;
        throw new Error("测试网络中断");
      }
      const term = payload.query.toLowerCase();
      await new Promise((resolve) =>
        setTimeout(resolve, term === "slow" ? 700 : 35),
      );
      const filtered =
        term === "slow"
          ? [{ ...projects[0], title: "旧请求结果" }]
          : projects.filter((project) =>
              project.title.toLowerCase().includes(term),
            );
      const sorted =
        payload.sort === "updated" ? [...filtered].reverse() : filtered;
      return {
        total: sorted.length,
        items: sorted
          .slice(payload.offset, payload.offset + payload.limit)
          .map((project) => ({ ...project, source: payload.source })),
      };
    }
    if (operation === "resources.localProject") {
      const item = localItems[payload.versionId]?.mod.find(
        (item) => item.path === payload.path,
      );
      if (!item) throw new Error("模组文件不存在");
      if (state.resources.unmatchedLocalSource === payload.source) return null;
      return { id: payload.source === "modrinth" ? "AANobbMI" : "394468" };
    }
    if (
      operation === "resources.detail" &&
      ["AANobbMI", "394468"].includes(payload.id)
    )
      return {
        ...projects[0],
        id: payload.id,
        source: payload.source,
        title: "Sodium",
        body: "## 项目介绍\n来自对应渠道的模组详情。",
      };
    if (operation === "resources.detail")
      return {
        ...projects.find((project) => project.id === payload.id),
        source: payload.source,
      };
    if (operation === "resources.files") {
      const kind =
        payload.loader === "datapack" ? "datapack" : state.resources.kind;
      return [
        ["1.20.1", "fabric"],
        ["1.21.4", "neoforge"],
        ["1.19.4", "fabric"],
      ]
        .map(([gameVersion, loader], index) => ({
          id: `file-${index}`,
          name: `兼容文件 ${gameVersion}`,
          version: `1.${index}`,
          date: "2026-10-01",
          gameVersions: [gameVersion],
          loaders: [
            kind === "mod"
              ? loader
              : kind === "shader"
                ? "iris"
                : kind === "datapack"
                  ? "datapack"
                  : "minecraft",
          ],
          dependencies:
            state.resources.datapackDependency && kind === "mod"
              ? [{ projectId: "project-0", name: "Sodium", kind: "datapack" }]
              : [],
          file: {
            url: `https://example.com/test-${index}.${kind === "mod" ? "jar" : "zip"}`,
            path: `test-${index}.${kind === "mod" ? "jar" : "zip"}`,
            size: 2048,
          },
        }))
        .filter(
          (file) =>
            (!payload.gameVersion ||
              file.gameVersions.includes(payload.gameVersion)) &&
            (!payload.loader ||
              file.loaders.includes(payload.loader.toLowerCase())),
        );
    }
    if (operation === "resources.download") return "queued-resource";
    if (operation === "resources.local")
      return structuredClone(
        localItems[payload.versionId || state.data.settings.activeVersion]?.[
          payload.kind
        ] || [],
      );
    if (operation === "resources.toggle") {
      const item = localItems[payload.versionId].mod.find(
        (item) => item.path === payload.path,
      );
      item.disabled = payload.disabled;
      const previous = payload.path.replaceAll("\\", "/");
      const directory = previous.replace(/\/(?:\.disabled\/)?[^/]+$/, "");
      const filename = previous.split("/").at(-1);
      item.path = payload.disabled
        ? `${directory}/.disabled/${filename}`
        : `${directory}/${filename.replace(/(?:\.disabled)+$/, "")}`;
      return item.path;
    }
    if (operation === "resources.deletePack") {
      localItems[payload.versionId].resourcepack = [];
      return true;
    }
    if (operation === "path.open") return true;
    throw new Error(`Unexpected resource operation: ${operation}`);
  };
}
