import type {
  GameSettingGroup,
  GameSettingGroups,
  GameSettings,
  Settings,
  VersionSettings,
} from "./types";

export const javaPathKey = (path: string) =>
  path.replaceAll("\\", "/").toLowerCase();

export function mergeJavaPaths(...lists: string[][]): string[] {
  const seen = new Set<string>();
  return lists.flat().filter((path) => {
    const key = javaPathKey(path);
    if (!path || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function withJavaPaths<T extends GameSettings>(
  settings: T,
  paths: string[],
  removedPath?: string,
): T {
  return {
    ...settings,
    javaPaths: paths,
    javaPath:
      removedPath && javaPathKey(settings.javaPath) === javaPathKey(removedPath)
        ? ""
        : settings.javaPath,
  };
}

export function mergeSavedSettings(
  draft: Settings,
  previous: Settings,
  next: Settings,
): Settings {
  return Object.fromEntries(
    (Object.keys(next) as (keyof Settings)[]).map((key) => [
      key,
      JSON.stringify(draft[key]) === JSON.stringify(previous[key])
        ? next[key]
        : draft[key],
    ]),
  ) as unknown as Settings;
}

export const gameSettingFields = {
  java: ["javaPath", "javaPaths"],
  memory: ["autoMemory", "memoryMb", "isolation"],
  window: ["fullscreen", "width", "height", "windowTitle", "customInfo"],
  advanced: ["jvmArgsEnabled", "jvmArgs", "gameArgs"],
} as const satisfies Record<GameSettingGroup, readonly (keyof GameSettings)[]>;

export function independentGroups(config: VersionSettings): GameSettingGroups {
  const independent = !config.useGlobal;
  return {
    java: independent && (config.independentGroups?.java ?? true),
    memory: independent && (config.independentGroups?.memory ?? true),
    window: independent && (config.independentGroups?.window ?? true),
    advanced: independent && (config.independentGroups?.advanced ?? true),
  };
}

export function resolveGameSettings(
  config: VersionSettings,
  global: GameSettings,
): GameSettings {
  const groups = independentGroups(config);
  const values = gameSettingsFrom(global);
  for (const group of Object.keys(groups) as GameSettingGroup[]) {
    if (groups[group]) {
      Object.assign(
        values,
        Object.fromEntries(
          gameSettingFields[group].map((key) => [key, config.settings[key]]),
        ),
      );
    }
  }
  return values;
}

export function gameSettingsFrom(settings: GameSettings): GameSettings {
  return {
    javaPath: settings.javaPath,
    javaPaths: [...settings.javaPaths],
    autoMemory: settings.autoMemory,
    memoryMb: settings.memoryMb,
    isolation: settings.isolation,
    fullscreen: settings.fullscreen,
    width: settings.width,
    height: settings.height,
    windowTitle: settings.windowTitle,
    customInfo: settings.customInfo,
    jvmArgsEnabled: settings.jvmArgsEnabled,
    jvmArgs: settings.jvmArgs,
    gameArgs: settings.gameArgs,
  };
}
