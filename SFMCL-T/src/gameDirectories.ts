import type { Settings } from "./types";

const minecraftFolder = /(?:^|[\\/])\.minecraft$/i;

function trimDirectorySeparator(path: string) {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) return path.slice(0, 1);
  return /^[a-z]:$/i.test(trimmed) ? path.slice(0, 3) : trimmed;
}

export function gameDirectoryPath(path: string) {
  const directory = trimDirectorySeparator(path);
  return minecraftFolder.test(directory)
    ? trimDirectorySeparator(directory.slice(0, -".minecraft".length))
    : directory;
}

export function minecraftDirectoryPath(path: string) {
  const directory = trimDirectorySeparator(path);
  if (!directory || minecraftFolder.test(directory)) return directory;
  const separator = directory.includes("\\") ? "\\" : "/";
  return `${directory}${/[\\/]$/.test(directory) ? "" : separator}.minecraft`;
}

export function gameDirectoryName(directory: { name: string; path: string }) {
  return directory.name.toLowerCase() === ".minecraft"
    ? gameDirectoryPath(directory.path).split(/[\\/]/).filter(Boolean).pop() ||
        "游戏目录"
    : directory.name;
}

function directoryKey(path: string) {
  const root = gameDirectoryPath(path);
  return /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(root)
    ? root.replace(/\\/g, "/").toLowerCase()
    : root;
}

export function registerGameDirectory(
  gameDirs: Settings["gameDirs"],
  selected: string,
) {
  const key = directoryKey(selected);
  const existing = gameDirs.find((entry) => directoryKey(entry.path) === key);
  if (existing) return { gameDirs, path: existing.path };

  const path = gameDirectoryPath(selected);
  const name = path.split(/[\\/]/).filter(Boolean).pop() || "游戏目录";
  return { gameDirs: [...gameDirs, { name, path }], path };
}
