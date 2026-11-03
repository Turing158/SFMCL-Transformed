import { describe, expect, it } from "vitest";
import {
  independentGroups,
  resolveGameSettings,
  mergeJavaPaths,
  withJavaPaths,
  launchSettingDefaults,
  validServerHost,
  prepareGameSettings,
  prepareSettings,
  prepareVersionSettings,
  updateVersionGameSettings,
  updateVersionSettingGroup,
} from "./gameSettings";
import { changedValues } from "./autoSave";
import { mergePending } from "./autoSave";
import type { GameSettings, Settings, VersionSettings } from "./types";

const global: GameSettings = {
  javaPath: "global-java",
  javaPaths: [],
  autoMemory: true,
  memoryMb: 4096,
  isolation: true,
  fullscreen: false,
  width: 1280,
  height: 720,
  windowTitle: "Global",
  customInfo: "global-info",
  ...launchSettingDefaults,
  jvmArgsEnabled: false,
  jvmArgs: "global-jvm",
  gameArgs: "global-game",
};
const config: VersionSettings = {
  useGlobal: false,
  settings: {
    ...global,
    javaPath: "version-java",
    memoryMb: 8192,
    isolation: false,
    windowTitle: "Independent",
    jvmArgs: "version-jvm",
  },
};

describe("per-card game settings", () => {
  it("switches merged window and launch cards together and preserves their saved overrides", () => {
    const version = {
      ...config,
      independentGroups: {
        java: false,
        memory: false,
        window: false,
        advanced: false,
        position: true,
        launcher: false,
        process: true,
      },
      settings: {
        ...config.settings,
        width: 1600,
        windowMode: "center" as const,
        launcherAction: "tray" as const,
        processPriority: "high" as const,
      },
    };
    expect(independentGroups(version)).toMatchObject({
      window: true,
      position: true,
      launcher: true,
      process: true,
    });
    expect(resolveGameSettings(version, global)).toMatchObject({
      width: 1600,
      windowMode: "center",
      launcherAction: "tray",
      processPriority: "high",
    });
    const windowOff = updateVersionSettingGroup(version, "window", false);
    expect(independentGroups(windowOff)).toMatchObject({
      window: false,
      position: false,
    });
    expect(resolveGameSettings(windowOff, global)).toMatchObject({
      width: global.width,
      windowMode: global.windowMode,
      launcherAction: "tray",
      processPriority: "high",
    });
    const allOff = updateVersionSettingGroup(windowOff, "launcher", false);
    expect(allOff.useGlobal).toBe(true);
    expect(resolveGameSettings(allOff, global)).toMatchObject({
      launcherAction: global.launcherAction,
      processPriority: global.processPriority,
    });
    const restored = updateVersionSettingGroup(
      updateVersionSettingGroup(allOff, "window", true),
      "launcher",
      true,
    );
    expect(resolveGameSettings(restored, global)).toMatchObject({
      width: 1600,
      windowMode: "center",
      launcherAction: "tray",
      processPriority: "high",
    });
    expect(restored.settings).toEqual(version.settings);
  });
  it("automatically scopes and enables direct entry from targets, and disables it when cleared", () => {
    const inherited = { ...config, useGlobal: true };
    const portOnly = updateVersionGameSettings(inherited, {
      ...inherited.settings,
      serverPort: 25566,
    });
    expect(
      resolveGameSettings(prepareVersionSettings(portOnly, inherited), global),
    ).toMatchObject({
      serverPort: 25566,
      serverEnabled: false,
      quickPlayEnabled: false,
    });
    const entered = updateVersionGameSettings(inherited, {
      ...inherited.settings,
      serverHost: "version.example.com",
      serverEnabled: false,
    });
    const server = prepareVersionSettings(entered, inherited);
    expect(server).toMatchObject({
      useGlobal: false,
      independentGroups: { server: true, world: false },
      settings: {
        serverEnabled: true,
        serverHost: "version.example.com",
        quickPlayEnabled: false,
      },
    });
    const selected = updateVersionGameSettings(server, {
      ...server.settings,
      serverHost: "",
      serverEnabled: false,
      quickPlayWorld: "Version World",
      quickPlayEnabled: false,
    });
    const world = prepareVersionSettings(selected, server);
    expect(world).toMatchObject({
      useGlobal: false,
      independentGroups: { server: false, world: true },
      settings: {
        serverEnabled: false,
        serverHost: "",
        quickPlayEnabled: true,
        quickPlayWorld: "Version World",
      },
    });
    const cleared = updateVersionGameSettings(world, {
      ...world.settings,
      quickPlayWorld: "",
      quickPlayEnabled: false,
    });
    expect(prepareVersionSettings(cleared, world)).toMatchObject({
      useGlobal: true,
      independentGroups: { server: false, world: false },
      settings: {
        serverEnabled: false,
        serverHost: "",
        quickPlayEnabled: false,
        quickPlayWorld: "",
      },
    });
  });
  it("ignores global server targets and derives activation from local fields instead of legacy flags", () => {
    const globals = {
      ...global,
      serverEnabled: true,
      serverHost: "global.example.com",
      serverPort: 25566,
    };
    expect(
      resolveGameSettings({ ...config, useGlobal: true }, globals),
    ).toMatchObject({
      serverEnabled: false,
      serverHost: "",
      serverPort: 25565,
    });
    const version = {
      ...config,
      independentGroups: {
        java: false,
        memory: false,
        window: false,
        advanced: false,
        server: true,
        world: true,
      },
      settings: {
        ...config.settings,
        serverHost: "local.example.com",
        serverEnabled: false,
      },
    };
    expect(resolveGameSettings(version, globals)).toMatchObject({
      serverEnabled: true,
      serverHost: "local.example.com",
    });
    expect(
      resolveGameSettings(
        {
          ...version,
          settings: {
            ...version.settings,
            serverHost: "",
            serverEnabled: true,
            quickPlayEnabled: true,
            quickPlayWorld: "",
          },
        },
        globals,
      ),
    ).toMatchObject({ serverEnabled: false, quickPlayEnabled: false });
  });
  it("never inherits global Quick Play and preserves the version's saved world", () => {
    const globals = {
      ...global,
      quickPlayEnabled: true,
      quickPlayWorld: "Global World",
    };
    const version = {
      ...config,
      independentGroups: {
        java: false,
        memory: false,
        window: false,
        advanced: false,
        world: true,
      },
      settings: {
        ...config.settings,
        quickPlayEnabled: true,
        quickPlayWorld: "Version World",
      },
    };
    expect(
      resolveGameSettings({ ...version, useGlobal: true }, globals),
    ).toMatchObject({ quickPlayEnabled: false, quickPlayWorld: "" });
    expect(
      resolveGameSettings(
        {
          ...version,
          independentGroups: { ...version.independentGroups, world: false },
        },
        globals,
      ),
    ).toMatchObject({ quickPlayEnabled: false, quickPlayWorld: "" });
    expect(resolveGameSettings(version, globals)).toMatchObject({
      quickPlayEnabled: true,
      quickPlayWorld: "Version World",
    });
    expect(version.settings.quickPlayWorld).toBe("Version World");
  });
  it("clears obsolete global direct-entry values when saving global settings", () => {
    const saved = {
      ...global,
      quickPlayEnabled: true,
      quickPlayWorld: "Global World",
      serverEnabled: true,
      serverHost: "global.example.com",
      serverPort: 25566,
      downloadConcurrency: 8,
      downloadCacheDir: "",
    } as Settings;
    expect(
      prepareSettings({ ...saved, windowTitle: "Updated" }, saved),
    ).toMatchObject({
      windowTitle: "Updated",
      serverEnabled: false,
      serverHost: "",
      serverPort: 25565,
      quickPlayEnabled: false,
      quickPlayWorld: "",
    });
  });
  it("does not reorder settings and schedule redundant version auto-saves", () => {
    const prepared = {
      ...config,
      settings: prepareGameSettings(config.settings, config.settings),
    };
    expect(changedValues(config, prepared)).toEqual({});
    expect(
      changedValues(config, prepareVersionSettings(config, config)),
    ).toEqual({});
  });
  it("independent direct-entry targets override the inherited target", () => {
    const globals = {
      ...global,
      serverEnabled: true,
      serverHost: "server.example.com",
    };
    const version = {
      ...config,
      independentGroups: {
        java: false,
        memory: false,
        window: false,
        advanced: false,
        world: true,
      },
      settings: {
        ...config.settings,
        quickPlayEnabled: true,
        quickPlayWorld: "World",
      },
    };
    expect(resolveGameSettings(version, globals)).toMatchObject({
      serverEnabled: false,
      quickPlayEnabled: true,
    });
  });
  it("validates IPv6 and keeps incomplete server input out of saved settings", () => {
    for (const host of [
      "play.example.com",
      "127.0.0.1",
      "[::1]",
      "[::ffff:192.168.1.1]",
    ])
      expect(validServerHost(host)).toBe(true);
    for (const host of [
      "",
      "example.com:25565",
      "https://example.com",
      "[1]",
      "[::wrong]",
    ])
      expect(validServerHost(host)).toBe(false);
    const saved = {
      ...global,
      serverEnabled: true,
      serverHost: "saved.example.com",
    };
    expect(
      prepareGameSettings(
        { ...saved, serverHost: "", serverPort: 0, windowX: NaN },
        saved,
      ),
    ).toMatchObject({
      serverHost: "saved.example.com",
      serverPort: 25565,
      windowX: 0,
    });
  });
  it("keeps legacy independent and global profiles compatible", () => {
    expect(Object.values(independentGroups(config))).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(resolveGameSettings(config, global)).toEqual(config.settings);
    expect(resolveGameSettings({ ...config, useGlobal: true }, global)).toEqual(
      global,
    );
  });

  it("inherits current globals only for disabled groups without mutating saved overrides", () => {
    const grouped = {
      ...config,
      independentGroups: {
        java: false,
        memory: true,
        window: false,
        advanced: false,
      },
    };
    expect(
      resolveGameSettings(grouped, { ...global, windowTitle: "Latest" }),
    ).toEqual({
      ...global,
      windowTitle: "Latest",
      memoryMb: 8192,
      isolation: false,
    });
    const restored = {
      ...grouped,
      independentGroups: {
        java: true,
        memory: false,
        window: true,
        advanced: true,
      },
    };
    expect(resolveGameSettings(restored, global)).toEqual({
      ...config.settings,
      memoryMb: 4096,
      isolation: true,
    });
    expect(grouped.settings.memoryMb).toBe(8192);
    expect(grouped.settings.windowTitle).toBe("Independent");
  });
});

describe("saved Java lists", () => {
  it("merges scans without duplicates and preserves manual entries", () => {
    expect(
      mergeJavaPaths(
        ["C:\\Java\\bin\\java.exe", "missing-java.exe"],
        ["c:/JAVA/bin/java.exe", "D:/Java/bin/javaw.exe", ""],
      ),
    ).toEqual([
      "C:\\Java\\bin\\java.exe",
      "missing-java.exe",
      "D:/Java/bin/javaw.exe",
    ]);
  });

  it("only clears the selection when that entry was removed", () => {
    const draft = {
      ...global,
      javaPath: "C:\\Java\\bin\\java.exe",
      windowTitle: "Unsaved",
    };
    expect(withJavaPaths(draft, [], "c:/java/bin/java.exe")).toEqual({
      ...draft,
      javaPath: "",
      javaPaths: [],
    });
    expect(withJavaPaths(draft, [draft.javaPath], "other.exe")).toEqual({
      ...draft,
      javaPaths: [draft.javaPath],
    });
    expect(draft.javaPath).toBe("C:\\Java\\bin\\java.exe");
  });

  it("accepts an auto-saved list while keeping pending game and launcher changes", () => {
    const previous = { ...global, theme: "light" } as Settings;
    const draft = {
      ...previous,
      javaPath: "draft-java.exe",
      memoryMb: 8192,
      theme: "dark",
    };
    const next = {
      ...previous,
      javaPaths: ["scanned-java.exe"],
      activeVersion: "1.21.4",
    };
    expect(mergePending(draft, previous, next)).toEqual({
      ...draft,
      javaPaths: next.javaPaths,
      activeVersion: next.activeVersion,
    });
    expect(mergePending(next, previous, next)).toEqual(next);
  });
});
