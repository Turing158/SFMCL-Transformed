export type ExportFormat = "modrinth" | "curseforge";
export interface ExportOptions {
  name: string;
  version: string;
  author: string;
  summary: string;
}
export interface ExportFile {
  path: string;
  size: number;
  modified: string;
  selected: boolean;
}
export interface ExportDraft {
  format: ExportFormat;
  options: ExportOptions;
  paths: string[];
  directPaths: string[];
  downloads: { path: string; url: string }[];
}
export interface ExportInspection {
  token: string;
  gameDirectory: string;
  minecraft: string;
  loader: { kind: string; version: string } | null;
  shared: boolean;
  files: ExportFile[];
  warnings: string[];
  draft: ExportDraft | null;
}
export interface ExportPlan {
  token: string | null;
  items: {
    path: string;
    size: number;
    method: "embedded" | "reference" | "unresolved";
    project: string | null;
    version: string | null;
    reason: string;
  }[];
  issues: string[];
  warnings: string[];
  totalSize: number;
  embeddedSize: number;
  manifest: Record<string, unknown>;
}
export const exportFormats = {
  modrinth: { name: "Modrinth", extension: "mrpack" },
  curseforge: { name: "CurseForge", extension: "zip" },
} as const;
export function initialExportDraft(
  inspection: ExportInspection,
  name: string,
): ExportDraft {
  const available = new Set(inspection.files.map((file) => file.path));
  const saved = inspection.draft;
  const paths = saved
    ? saved.paths.filter((path) => available.has(path))
    : inspection.files.filter((file) => file.selected).map((file) => file.path);
  return {
    format: saved?.format === "curseforge" ? "curseforge" : "modrinth",
    options: saved?.options ?? {
      name,
      version: "1.0.0",
      author: "",
      summary: "",
    },
    paths,
    directPaths:
      saved?.directPaths?.filter((path) => paths.includes(path)) ?? [],
    downloads:
      saved?.downloads?.filter((item) => paths.includes(item.path)) ?? [],
  };
}
export function selectExportFiles(
  draft: ExportDraft,
  paths: string[],
  selected: boolean,
): ExportDraft {
  const next = new Set(draft.paths);
  for (const path of paths) {
    if (selected) next.add(path);
    else next.delete(path);
  }
  return {
    ...draft,
    paths: [...next].sort(),
    directPaths: draft.directPaths.filter((path) => next.has(path)),
    downloads: draft.downloads.filter((item) => next.has(item.path)),
  };
}
export function exportFileName(draft: ExportDraft): string {
  const stem =
    `${draft.options.name.trim()}-${draft.options.version.trim()}`
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/[ .]+$/g, "")
      .slice(0, 100) || "modpack";
  return `${stem}.${exportFormats[draft.format].extension}`;
}
