import type { Loader, ManifestVersion, ResourceFile } from "./types";
const aprilVersions = new Set([
  "15w14a",
  "1.RV-Pre1",
  "3D Shareware v1.34",
  "20w14infinite",
  "22w13oneBlockAtATime",
  "23w13a_or_b",
  "24w14potato",
  "25w14craftmine",
]);
export function matchesVersionFilter(
  version: Pick<ManifestVersion, "id" | "type">,
  filter: string,
) {
  if (filter === "all") return true;
  const april = aprilVersions.has(version.id);
  if (filter === "april") return april;
  if (filter === "old") return version.type.startsWith("old_");
  return !april && version.type === filter;
}
export function compatibleOptifine(choice: Loader, forge: string) {
  if (choice.kind !== "OptiFine" || !forge) return false;
  return optifineForgeVersion(choice) === forge;
}

// OptiFine's download table names a tested Forge version. N/A or missing
// metadata does not establish compatibility with an arbitrary Forge build.
export function optifineForgeVersion(choice: Loader) {
  return String(choice.metadata.forge || "")
    .trim()
    .match(/^(?:Forge\s*)?(\d+(?:\.\d+)+)$/i)?.[1];
}

export const loaderKinds = [
  "Forge",
  "OptiFine",
  "Fabric",
  "NeoForge",
  "Quilt",
  "LiteLoader",
] as const;
export type LoaderKind = (typeof loaderKinds)[number];
export type InstallComponent = LoaderKind | "FabricAPI";
export interface InstallSelection {
  loader: Loader | null;
  optifine: Loader | null;
  fabricApi: ResourceFile | null;
}
export const emptyInstallSelection: InstallSelection = {
  loader: null,
  optifine: null,
  fabricApi: null,
};

export function componentBlockReason(
  kind: InstallComponent,
  selection: InstallSelection,
) {
  const { loader, optifine } = selection;
  if (kind === "FabricAPI")
    return loader?.kind === "Fabric" ? "" : "先选择 Fabric，再添加 Fabric API";
  if (kind === loader?.kind || (kind === "OptiFine" && optifine)) return "";
  if (loader && !(kind === "OptiFine" && loader.kind === "Forge"))
    return `与 ${loader.kind} 不能同时安装，请先取消 ${loader.kind}`;
  if (optifine && kind !== "OptiFine") {
    if (kind !== "Forge") return "与 OptiFine 不能同时安装，请先取消 OptiFine";
    if (!optifineForgeVersion(optifine))
      return "所选 OptiFine 未标注兼容的 Forge 版本";
  }
  return "";
}

export function availableLoaderChoices(
  kind: LoaderKind,
  choices: Loader[],
  selection: InstallSelection,
) {
  if (kind === "Forge" && selection.optifine)
    return choices.filter((choice) =>
      compatibleOptifine(selection.optifine!, choice.version),
    );
  if (kind === "OptiFine" && selection.loader?.kind === "Forge")
    return choices.filter((choice) =>
      compatibleOptifine(choice, selection.loader!.version),
    );
  return choices;
}

export function selectInstallLoader(
  selection: InstallSelection,
  kind: LoaderKind,
  choice: Loader | null,
): InstallSelection {
  if (choice) {
    if (choice.kind !== kind || componentBlockReason(kind, selection))
      return selection;
    if (!availableLoaderChoices(kind, [choice], selection).length)
      return selection;
  }
  if (kind === "OptiFine") return { ...selection, optifine: choice };
  if (!choice && selection.loader?.kind !== kind) return selection;
  return {
    ...selection,
    loader: choice,
    fabricApi: kind === "Fabric" && choice ? selection.fabricApi : null,
  };
}

export function installSelectionPayload(selection: InstallSelection) {
  const { loader, optifine, fabricApi } = selection;
  if (
    loader &&
    optifine &&
    (loader.kind !== "Forge" || !compatibleOptifine(optifine, loader.version))
  )
    throw new Error("所选加载器与 OptiFine 不兼容");
  if (fabricApi && (loader?.kind !== "Fabric" || !fabricApi.file))
    throw new Error("Fabric API 需要 Fabric Loader 和可下载文件");
  return {
    loader: loader ?? optifine,
    optifine: loader ? optifine : null,
    fabricApi: fabricApi?.file ?? null,
  };
}
