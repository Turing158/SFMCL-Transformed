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
