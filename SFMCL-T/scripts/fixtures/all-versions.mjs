// Directory-aware bridge for isolated browser checks; all changes stay in memory.
export function allVersionsFixture() {
  const test = window.__pixelTest;
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const first = test.data.settings.activeDir;
  const second = "D:/Other-Minecraft";
  const empty = "E:/Empty-Minecraft";
  test.data.settings.gameDirs.push(
    { name: "另一游戏目录", path: second },
    { name: "空文件夹", path: empty },
    { name: ".minecraft", path: `${first}/.minecraft` },
  );
  const root = (directory) => directory.replace(/[/\\]\.minecraft$/i, "");
  const version = (id, directory) => ({
    id,
    directory,
    version: id.split("-")[0],
    kind: "release",
    loader: id.includes("Fabric") ? "Fabric" : "Vanilla",
    javaMajor: 21,
    path: `${directory}/.minecraft/versions/${id}`,
    icon: "",
    favorite: false,
    isolation: true,
  });
  test.directoryVersions = [
    version("1.21.4", first),
    version("1.20.1-Fabric", first),
    version("1.21.4", second),
  ];
  test.directoryFailures = {};
  test.heldDirectoryReads = {};
  test.addDirectoryVersion = (id, directory) =>
    test.directoryVersions.push(version(id, directory));
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command !== "request") return invoke(command, args);
    const { operation, payload = {} } = args;
    const directory = root(payload.directory ?? test.data.settings.activeDir);
    const entry = test.directoryVersions.find(
      (item) => item.id === payload.id && item.directory === directory,
    );
    if (
      ![
        "versions.list",
        "versions.favorites",
        "versions.favorite",
        "versions.rename",
        "versions.delete",
        "resources.local",
        "path.open",
      ].includes(operation)
    )
      return invoke(command, args);
    test.requests.push({ operation, payload: structuredClone(payload) });
    if (operation === "versions.list") {
      const snapshot = structuredClone(
        test.directoryVersions.filter((item) => item.directory === directory),
      );
      if (test.heldDirectoryReads[directory])
        await new Promise((resolve) => {
          test.heldDirectoryReads[directory].push(resolve);
        });
      if (test.directoryFailures[directory])
        throw new Error(test.directoryFailures[directory]);
      return snapshot;
    }
    if (operation === "versions.favorites")
      return structuredClone(
        test.directoryVersions
          .filter((item) => item.favorite)
          .map((item) => ({ ...item, directoryName: item.directory })),
      );
    if (operation === "versions.favorite") entry.favorite = payload.favorite;
    if (operation === "versions.rename") {
      entry.id = payload.name;
      entry.path = `${directory}/.minecraft/versions/${payload.name}`;
    }
    if (operation === "versions.delete")
      test.directoryVersions.splice(test.directoryVersions.indexOf(entry), 1);
    if (operation === "resources.local") return [];
    return true;
  };
}
