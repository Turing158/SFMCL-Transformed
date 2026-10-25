import { describe, expect, it } from "vitest";
import {
  independentGroups,
  resolveGameSettings,
  mergeJavaPaths,
  withJavaPaths,
  mergeSavedSettings,
} from "./gameSettings";
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
  it("keeps legacy independent and global profiles compatible", () => {
    expect(Object.values(independentGroups(config))).toEqual([
      true,
      true,
      true,
      true,
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

  it("accepts an auto-saved list while keeping unsaved game and launcher changes", () => {
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
    expect(mergeSavedSettings(draft, previous, next)).toEqual({
      ...draft,
      javaPaths: next.javaPaths,
      activeVersion: next.activeVersion,
    });
    expect(mergeSavedSettings(next, previous, next)).toEqual(next);
  });
});
