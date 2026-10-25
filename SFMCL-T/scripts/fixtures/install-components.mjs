export function installComponentsFixture() {
  const base = window.__TAURI_INTERNALS__.invoke;
  const state = window.__pixelTest;
  const loader = (kind, version, metadata = {}) => ({
    kind,
    version,
    metadata,
  });
  state.installComponents = {
    failures: {},
    delays: {},
    catalogs: {
      Forge: [
        loader("Forge", "47.4.0"),
        loader("Forge", "47.2.18"),
        loader("Forge", "47.1.0"),
        ...Array.from({ length: 70 }, (_, i) => loader("Forge", `47.0.${i}`)),
      ],
      OptiFine: [
        loader("OptiFine", "HD_U_I6", { forge: "Forge 47.2.18" }),
        loader("OptiFine", "HD_U_I5", { forge: "Forge 47.1.0" }),
        loader("OptiFine", "HD_U_I7_pre1", { forge: "Forge N/A" }),
        loader("OptiFine", "HD_U_unknown"),
      ],
      Fabric: [loader("Fabric", "0.16.10"), loader("Fabric", "0.16.9")],
      NeoForge: [loader("NeoForge", "47.1.106")],
      Quilt: [loader("Quilt", "0.27.0")],
      LiteLoader: [],
    },
    files: [
      {
        id: "api-current",
        version: "0.92.12+1.20.1",
        gameVersions: ["1.20.1"],
        file: {
          path: "fabric-api-current.jar",
          url: "https://example.com/fabric-api-current.jar",
          size: 2048,
        },
      },
      {
        id: "api-old",
        version: "0.91.0+1.19.4",
        gameVersions: ["1.19.4"],
        file: {
          path: "fabric-api-old.jar",
          url: "https://example.com/fabric-api-old.jar",
          size: 2048,
        },
      },
      { id: "api-no-file", version: "0.93.0", gameVersions: ["1.20.1"] },
    ].map((file) => ({
      ...file,
      name: "Fabric API",
      date: "2026-10-17",
      loaders: ["fabric"],
      dependencies: [],
    })),
  };
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command !== "request") return base(command, args);
    const { operation, payload } = args;
    if (operation === "install") {
      state.requests.push({ operation, payload: structuredClone(payload) });
      if (state.failures.install) throw new Error(state.failures.install);
      return "install-components-test";
    }
    const kind =
      operation === "loaders"
        ? payload.kind
        : operation === "resources.files" && payload.id === "P7dR8mSH"
          ? "FabricAPI"
          : null;
    if (!kind) return base(command, args);
    state.requests.push({ operation, payload: structuredClone(payload) });
    const fixture = state.installComponents;
    const result = structuredClone(
      kind === "FabricAPI" ? fixture.files : fixture.catalogs[kind],
    );
    const error = fixture.failures[kind];
    await new Promise((resolve) =>
      setTimeout(resolve, fixture.delays[kind] ?? 100),
    );
    if (error) throw new Error(error);
    return result;
  };
}
