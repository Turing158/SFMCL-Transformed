import { describe, expect, it } from "vitest";
import {
  exportFileName,
  initialExportDraft,
  selectExportFiles,
  type ExportInspection,
} from "./modpackExport";

const inspection: ExportInspection = {
  token: "scan",
  gameDirectory: "C:/Game",
  minecraft: "1.20.1",
  loader: null,
  shared: false,
  warnings: [],
  draft: null,
  files: [
    { path: "mods/a.jar", size: 12, modified: "1", selected: true },
    { path: "saves/world/level.dat", size: 10, modified: "1", selected: false },
  ],
};
describe("modpack export choices", () => {
  it("defaults to enabled content and restores only files still present", () => {
    const initial = initialExportDraft(inspection, "Pack");
    expect(initial.paths).toEqual(["mods/a.jar"]);
    const restored = initialExportDraft(
      {
        ...inspection,
        draft: {
          ...initial,
          paths: ["mods/a.jar", "gone.jar"],
          directPaths: ["mods/a.jar", "gone.jar"],
          downloads: [{ path: "gone.jar", url: "https://example.com" }],
        },
      },
      "Pack",
    );
    expect(restored.paths).toEqual(["mods/a.jar"]);
    expect(restored.directPaths).toEqual(["mods/a.jar"]);
    expect(restored.downloads).toEqual([]);
  });
  it("deselecting a file removes its permission and custom URL", () => {
    const initial = initialExportDraft(inspection, "Pack");
    const next = selectExportFiles(
      {
        ...initial,
        directPaths: ["mods/a.jar"],
        downloads: [{ path: "mods/a.jar", url: "https://example.com/a.jar" }],
      },
      ["mods/a.jar"],
      false,
    );
    expect(next.paths).toEqual([]);
    expect(next.directPaths).toEqual([]);
    expect(next.downloads).toEqual([]);
    expect(
      selectExportFiles(next, ["mods/a.jar", "mods/a.jar"], true).paths,
    ).toEqual(["mods/a.jar"]);
  });
  it("uses the two approved extensions and sanitizes names", () => {
    const draft = initialExportDraft(inspection, "中文/Pack");
    expect(exportFileName(draft)).toBe("中文_Pack-1.0.0.mrpack");
    expect(exportFileName({ ...draft, format: "curseforge" })).toBe(
      "中文_Pack-1.0.0.zip",
    );
  });
});
