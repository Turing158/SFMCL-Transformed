import type {
  GameSettingGroup,
  GameSettingGroups,
  GameSettings,
  Settings,
  VersionSettings,
} from "./types";

export const launchSettingDefaults = {
  windowMode: "default",
  windowMonitor: "",
  windowX: 0,
  windowY: 0,
  launcherAction: "keep",
  restoreLauncher: true,
  serverEnabled: false,
  serverHost: "",
  serverPort: 25565,
  quickPlayEnabled: false,
  quickPlayWorld: "",
  processPriority: "normal",
} as const satisfies Partial<GameSettings>;

export const validServerHost = (value: string) => {
  const host = value.trim();
  if (/^[a-z0-9._-]{1,253}$/i.test(host)) return true;
  if (!/^\[[a-f0-9:.]+\]$/i.test(host)) return false;
  try {
    return new URL(`http://${host}/`).hostname.startsWith("[");
  } catch {
    return false;
  }
};

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

const validInteger = (value: number, min: number, max: number) =>
  Number.isInteger(value) && value >= min && value <= max;

export const absoluteSettingsPath = (value: string) =>
  !value.trim() ||
  /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/i.test(value.trim());

// Keep incomplete numeric/path input local while other valid changes save.
export function prepareGameSettings<T extends GameSettings>(
  draft: T,
  saved: T,
): T {
  const addMissingDefaults = (value: T): T => ({
    ...value,
    ...Object.fromEntries(
      Object.entries(launchSettingDefaults).filter(([key]) => !(key in value)),
    ),
  });
  draft = addMissingDefaults(draft);
  saved = addMissingDefaults(saved);
  return {
    ...draft,
    memoryMb: validInteger(draft.memoryMb, 512, 131072)
      ? draft.memoryMb
      : saved.memoryMb,
    width: validInteger(draft.width, 320, 16384) ? draft.width : saved.width,
    height: validInteger(draft.height, 240, 16384)
      ? draft.height
      : saved.height,
    windowX: validInteger(draft.windowX, -131072, 131072)
      ? draft.windowX
      : saved.windowX,
    windowY: validInteger(draft.windowY, -131072, 131072)
      ? draft.windowY
      : saved.windowY,
    serverHost:
      (!draft.serverEnabled && !draft.serverHost.trim()) ||
      validServerHost(draft.serverHost)
        ? draft.serverHost.trim()
        : saved.serverHost,
    serverPort: validInteger(draft.serverPort, 1, 65535)
      ? draft.serverPort
      : saved.serverPort,
    serverEnabled:
      draft.serverEnabled && !validServerHost(draft.serverHost)
        ? saved.serverEnabled
        : draft.serverEnabled,
    quickPlayEnabled:
      draft.quickPlayEnabled && !draft.quickPlayWorld
        ? saved.quickPlayEnabled
        : draft.quickPlayEnabled,
  };
}

export function prepareSettings(draft: Settings, saved: Settings): Settings {
  return {
    ...prepareGameSettings(draft, saved),
    serverEnabled: false,
    serverHost: "",
    serverPort: 25565,
    quickPlayEnabled: false,
    quickPlayWorld: "",
    downloadConcurrency: validInteger(draft.downloadConcurrency, 1, 32)
      ? draft.downloadConcurrency
      : saved.downloadConcurrency,
    downloadCacheDir: absoluteSettingsPath(draft.downloadCacheDir)
      ? draft.downloadCacheDir.trim()
      : saved.downloadCacheDir,
  };
}

export function prepareVersionSettings(
  draft: VersionSettings,
  saved: VersionSettings,
): VersionSettings {
  const settings = prepareGameSettings(draft.settings, saved.settings);
  const groups = independentGroups(draft);
  settings.quickPlayWorld = groups.world ? settings.quickPlayWorld : "";
  settings.serverHost =
    groups.server && !settings.quickPlayWorld ? settings.serverHost : "";
  settings.serverEnabled = validServerHost(settings.serverHost);
  settings.quickPlayEnabled = !!settings.quickPlayWorld;
  return updateVersionGameSettings(draft, settings);
}

export function updateVersionGameSettings(
  config: VersionSettings,
  settings: GameSettings,
): VersionSettings {
  const serverChanged =
    settings.serverHost !== config.settings.serverHost ||
    settings.serverEnabled !== config.settings.serverEnabled;
  const worldChanged =
    settings.quickPlayWorld !== config.settings.quickPlayWorld ||
    settings.quickPlayEnabled !== config.settings.quickPlayEnabled;
  if (!serverChanged && !worldChanged) return { ...config, settings };
  const groups = independentGroups(config);
  if (serverChanged) groups.server = !!settings.serverHost.trim();
  if (worldChanged) groups.world = !!settings.quickPlayWorld;
  return {
    ...config,
    settings,
    independentGroups: groups,
    useGlobal: !Object.values(groups).some(Boolean),
  };
}

export const gameSettingFields = {
  java: ["javaPath", "javaPaths"],
  memory: ["autoMemory", "memoryMb", "isolation"],
  window: ["fullscreen", "width", "height", "windowTitle", "customInfo"],
  advanced: ["jvmArgsEnabled", "jvmArgs", "gameArgs"],
  position: ["windowMode", "windowMonitor", "windowX", "windowY"],
  launcher: ["launcherAction", "restoreLauncher"],
  server: ["serverEnabled", "serverHost", "serverPort"],
  world: ["quickPlayEnabled", "quickPlayWorld"],
  process: ["processPriority"],
} as const satisfies Record<GameSettingGroup, readonly (keyof GameSettings)[]>;

export function independentGroups(config: VersionSettings): GameSettingGroups {
  const independent = !config.useGlobal;
  const window =
    independent &&
    ((config.independentGroups?.window ?? true) ||
      (config.independentGroups?.position ?? false));
  const launcher =
    independent &&
    ((config.independentGroups?.launcher ?? false) ||
      (config.independentGroups?.process ?? false));
  return {
    java: independent && (config.independentGroups?.java ?? true),
    memory: independent && (config.independentGroups?.memory ?? true),
    window,
    advanced: independent && (config.independentGroups?.advanced ?? true),
    position: window,
    launcher,
    server: independent && (config.independentGroups?.server ?? false),
    world: independent && (config.independentGroups?.world ?? false),
    process: launcher,
  };
}

export function updateVersionSettingGroup(
  config: VersionSettings,
  group: GameSettingGroup,
  independent: boolean,
): VersionSettings {
  const groups = { ...independentGroups(config), [group]: independent };
  if (group === "window" || group === "position") {
    groups.window = groups.position = independent;
  }
  if (group === "launcher" || group === "process") {
    groups.launcher = groups.process = independent;
  }
  return {
    ...config,
    independentGroups: groups,
    useGlobal: !Object.values(groups).some(Boolean),
  };
}

export function resolveGameSettings(
  config: VersionSettings,
  global: GameSettings,
): GameSettings {
  const groups = independentGroups(config);
  const values = {
    ...gameSettingsFrom(global),
    serverEnabled: false,
    serverHost: "",
    serverPort: config.settings.serverPort ?? 25565,
    quickPlayEnabled: false,
    quickPlayWorld: "",
  };
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
  values.quickPlayEnabled = !!values.quickPlayWorld;
  if (values.quickPlayEnabled) {
    values.serverHost = "";
    values.serverEnabled = false;
  } else {
    values.serverEnabled = validServerHost(values.serverHost);
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
    windowMode: settings.windowMode ?? launchSettingDefaults.windowMode,
    windowMonitor: settings.windowMonitor ?? "",
    windowX: settings.windowX ?? 0,
    windowY: settings.windowY ?? 0,
    launcherAction: settings.launcherAction ?? "keep",
    restoreLauncher: settings.restoreLauncher ?? true,
    serverEnabled: settings.serverEnabled ?? false,
    serverHost: settings.serverHost ?? "",
    serverPort: settings.serverPort ?? 25565,
    quickPlayEnabled: settings.quickPlayEnabled ?? false,
    quickPlayWorld: settings.quickPlayWorld ?? "",
    processPriority: settings.processPriority ?? "normal",
    jvmArgsEnabled: settings.jvmArgsEnabled,
    jvmArgs: settings.jvmArgs,
    gameArgs: settings.gameArgs,
  };
}
