// Extends pixelAppFixture and launchDockFixture in an isolated browser.
export function favoriteContextFixture() {
  const test = window.__pixelTest;
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const first = test.data.settings.activeDir;
  const second = "D:/Other-Minecraft";
  test.data.settings.gameDirs.push({ name: "另一游戏目录", path: second });
  const versions = [
    { id: "1.21.4", directory: first },
    { id: "1.20.1-Fabric", directory: first },
    { id: "1.21.4", directory: second },
  ].map((entry) => ({
    ...entry,
    version: entry.id.split("-")[0],
    kind: "release",
    loader: entry.id.includes("Fabric") ? "Fabric" : "Vanilla",
    javaMajor: 21,
    path: `${entry.directory}/.minecraft/versions/${entry.id}`,
    icon: "",
    favorite: true,
    isolation: true,
    directoryName: entry.directory === first ? "像素工坊" : "另一游戏目录",
  }));
  test.menuVersions = versions;
  test.pickedDirectory = "C:/Pixel-Test/new-icon.png";
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command !== "request") return invoke(command, args);
    const { operation, payload } = args;
    const directory = payload.directory ?? test.data.settings.activeDir;
    const version = versions.find(
      (entry) => entry.id === payload.id && entry.directory === directory,
    );
    if (
      [
        "versions.list",
        "versions.favorites",
        "versions.favorite",
        "versions.rename",
        "versions.delete",
        "versions.icon",
        "versions.repair",
        "resources.local",
        "resources.toggle",
        "resources.deletePack",
        "path.open",
      ].includes(operation)
    ) {
      test.requests.push({ operation, payload: structuredClone(payload) });
      if (test.failures[operation]) throw new Error(test.failures[operation]);
      if (operation === "versions.list") {
        test.versions = versions.filter(
          (entry) => entry.directory === directory,
        );
        return structuredClone(test.versions);
      }
      if (operation === "versions.favorites")
        return structuredClone(versions.filter((entry) => entry.favorite));
      if (operation === "versions.favorite") {
        version.favorite = payload.favorite;
        return true;
      }
      if (operation === "versions.rename") {
        version.id = payload.name;
        version.path = `${directory}/.minecraft/versions/${payload.name}`;
        return true;
      }
      if (operation === "versions.delete") {
        versions.splice(versions.indexOf(version), 1);
        return true;
      }
      if (operation === "versions.icon") {
        version.icon = payload.path ?? "";
        return true;
      }
      if (operation === "versions.repair") return "repair-test";
      if (operation === "resources.local") return [];
      return true;
    }
    return invoke(command, args);
  };
}
