import type { ResourceTab } from "./navigation";
import type { ResourceDependency, ResourceFile, Version } from "./types";

export const resourceDependencyKinds: Record<
  ResourceDependency["kind"],
  string
> = {
  mod: "模组",
  resourcepack: "材质包",
  shader: "光影",
  modpack: "整合包",
  datapack: "数据包",
  world: "存档",
  plugin: "插件",
  unknown: "未知类型",
};

export function compatibleResourceVersion(
  resource: ResourceFile,
  version: Version,
  kind: Exclude<ResourceTab, "minecraft">,
) {
  if (version.error) return false;
  if (
    resource.gameVersions.length &&
    !resource.gameVersions.includes(version.version)
  )
    return false;
  return (
    kind !== "mod" ||
    !resource.loaders.length ||
    resource.loaders.some(
      (loader) => loader.toLowerCase() === version.loader.toLowerCase(),
    )
  );
}
